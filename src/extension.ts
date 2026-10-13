import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const outputChannel = vscode.window.createOutputChannel('VS Code Local AI');

interface AISettings {
  protocol: 'ollama' | 'openai';
  baseUrl: string;
  apiKey: string;
  selectedModel?: string;
  numCtx: string;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine('VS Code Local AI 插件已激活 (具备文件读写 Agent 能力)');
  const provider = new AIChatViewProvider(context);

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('ollamaChatView', provider));
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-local-ai.openSettings', () => {
      provider.toggleSettingsView();
    }),
  );
}

class AIChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };
    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data: any) => {
      outputChannel.show(true);
      switch (data.type) {
        case 'getSettings':
          this.sendSettingsToWebview();
          break;
        case 'saveSettings':
          await this.saveSettings(data.settings);
          break;
        case 'getModels':
          await this.fetchAndSendModels();
          break;
        case 'sendMessage':
          await this.handleAgentLoop(data.prompt, data.model);
          break;
      }
    });
  }

  public toggleSettingsView() {
    if (this._view) {
      this._view.webview.postMessage({type: 'toggleSettingsView'});
    }
  }

  private getStoredSettings(): AISettings {
    const defaultSettings: AISettings = {
      protocol: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      selectedModel: '',
      numCtx: '32k',
    };
    const saved = this._context.globalState.get<AISettings>('aiSettings');
    return saved ? {...defaultSettings, ...saved} : defaultSettings;
  }

  private async saveSettings(settings: AISettings) {
    const current = this.getStoredSettings();
    const merged = {...current, ...settings};
    await this._context.globalState.update('aiSettings', merged);
    vscode.window.showInformationMessage('本地 AI 配置已成功保存！');
    this._view?.webview.postMessage({type: 'settingsSaved'});
  }

  private sendSettingsToWebview() {
    const settings = this.getStoredSettings();
    this._view?.webview.postMessage({type: 'loadSettings', settings});
  }

  private async fetchAndSendModels() {
    const settings = this.getStoredSettings();
    let models: string[] = [];
    if (settings.protocol === 'openai') {
      let baseUrl = (settings.baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
      try {
        const headers: Record<string, string> = {};
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
        const res = await fetch(`${baseUrl}/models`, {headers});
        if (res.ok) {
          const json: any = await res.json();
          if (Array.isArray(json.data)) models = json.data.map((m: any) => m.id);
        }
      } catch (e) {}
      this._view?.webview.postMessage({
        type: 'modelList',
        models,
        selectedModel: settings.selectedModel || models[0],
      });
    } else {
      let host = (settings.baseUrl || 'http://127.0.0.1:11434')
        .replace('localhost', '127.0.0.1')
        .replace(/\/$/, '');
      http
        .get(`${host}/api/tags`, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              models = json.models ? json.models.map((m: any) => m.name) : [];
              this._view?.webview.postMessage({
                type: 'modelList',
                models,
                selectedModel: settings.selectedModel || models[0],
              });
            } catch (e) {
              this._view?.webview.postMessage({type: 'modelList', models: []});
            }
          });
        })
        .on('error', () => this._view?.webview.postMessage({type: 'modelList', models: []}));
    }
  }

  // ==================== 工作区路径与工具实现 ====================
  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  private async executeTool(name: string, args: any): Promise<string> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return '错误：当前未打开任何工作区文件夹 (Workspace)。请先在 VS Code 中通过 文件 -> 打开文件夹 打开一个项目。';
    }

    // 核心优化：智能路径解析
    const resolvePath = (targetPath: string) => {
      if (!targetPath) return root;
      // 如果传入的是绝对路径（带有盘符如 E:\ 或 / 开头），则直接使用；否则自动拼接当前工作区根目录
      return path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
    };

    try {
      if (name === 'list_directory') {
        const targetPath = resolvePath(args.path || '');
        const entries = await fs.promises.readdir(targetPath, {withFileTypes: true});
        const list = entries.map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
        return JSON.stringify(list, null, 2);
      } else if (name === 'read_file') {
        const filePath = resolvePath(args.path);
        const content = await fs.promises.readFile(filePath, 'utf8');
        return content;
      } else if (name === 'write_file') {
        const filePath = resolvePath(args.path);
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, {recursive: true});
        await fs.promises.writeFile(filePath, args.content, 'utf8');
        return `成功：文件 ${args.path} 已在工作区中创建/更新。`;
      }
      return `未知工具: ${name}`;
    } catch (err: any) {
      return `执行工具 ${name} 失败: ${err.message}`;
    }
  }

  // ==================== Agent 智能体循环与健壮解析 ====================
  private async handleAgentLoop(prompt: string, model: string) {
    const settings = this.getStoredSettings();
    settings.selectedModel = model;
    await this._context.globalState.update('aiSettings', settings);

    const workspaceRoot = this.getWorkspaceRoot() || '未打开工作区';

    const systemPrompt = `你是一个运行在 VS Code 中的超级本地 AI 编程助手（类似 Cline）。
当前打开的工作区路径是: ${workspaceRoot}
你可以通过输出工具调用指令来读取、浏览和修改工作区文件。

【极其重要的文件修改规范与铁律】：
1. **禁止局部覆盖（核心）**：\`write_file\` 是**全量覆盖**写入工具。当你要修改、优化或在现有文件中增加函数/代码时，**必须先调用 \`read_file\` 读取文件的完整内容**。
2. **必须保留原有代码**：在调用 \`write_file\` 时，\`content\` 参数必须传入**整个文件的完整最终代码**（即：原有的所有代码 + 你新增或修改的函数）。绝对不能只输出新增的代码片段，否则会导致原文件其他代码被全部清空！
3. 如果是创建全新文件，则直接写入全部新内容。

可用工具格式（必须用合法的 JSON 并用 Markdown 代码块包裹）：
\`\`\`json
{
  "name": "write_file",
  "arguments": {
    "path": "文件相对路径",
    "content": "// 这里必须是包含原代码和新代码的完整文件内容..."
  }
}
\`\`\`

支持的工具名:
1. "list_directory" (参数: {"path": "相对路径或空字符串"})
2. "read_file" (参数: {"path": "文件相对路径"})
3. "write_file" (参数: {"path": "文件相对路径", "content": "文件的完整最终代码"})

如果不需要调用工具，直接回答用户问题即可。`;

    let messages: any[] = [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: prompt},
    ];

    let maxSteps = 5;
    let step = 0;

    while (step < maxSteps) {
      step++;
      let assistantResponseText = '';

      if (settings.protocol === 'openai') {
        assistantResponseText = await this.callOpenAIModel(messages, settings, model);
      } else {
        assistantResponseText = await this.callOllamaModel(messages, settings, model);
      }

      // 实时记录原始回复到输出面板，方便调试
      outputChannel.appendLine(`\n--- [Step ${step}] AI 原始回复 ---\n${assistantResponseText}`);

      messages.push({role: 'assistant', content: assistantResponseText});

      // 增强版多重解析逻辑：兼容 Markdown 代码块、标签及纯 JSON
      let toolJsonStr = '';

      const tagMatch = assistantResponseText.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
      if (tagMatch) {
        toolJsonStr = tagMatch[1].trim();
      } else {
        const codeBlockMatch = assistantResponseText.match(
          /```(?:json)?\s*(\{[\s\S]*?name\s*:\s*"[^"]+"[\s\S]*?\})\s*```/,
        );
        if (codeBlockMatch) {
          toolJsonStr = codeBlockMatch[1].trim();
        } else {
          const jsonMatch = assistantResponseText.match(
            /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/,
          );
          if (jsonMatch) {
            toolJsonStr = jsonMatch[0].trim();
          }
        }
      }

      if (toolJsonStr.startsWith('```')) {
        const innerMatch = toolJsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (innerMatch) toolJsonStr = innerMatch[1].trim();
      }

      if (toolJsonStr) {
        try {
          const toolCall = JSON.parse(toolJsonStr);
          this._view?.webview.postMessage({
            type: 'streamChunk',
            chunk: `\n\n⚙️ **正在执行工具 [${toolCall.name}]**: \`${toolCall.arguments?.path || ''}\`\n\n`,
          });

          const toolResult = await this.executeTool(toolCall.name, toolCall.arguments);

          this._view?.webview.postMessage({
            type: 'streamChunk',
            chunk: `📥 **工具返回结果**:\n\`\`\`\n${toolResult.slice(0, 500)}${toolResult.length > 500 ? '\n...(内容已截断)' : ''}\n\`\`\`\n\n`,
          });

          messages.push({role: 'user', content: `[系统通知 - 工具执行结果]:\n${toolResult}`});
          continue;
        } catch (e: any) {
          outputChannel.appendLine(`[Tool Parse Error]: ${e.message} | JSON Str: ${toolJsonStr}`);
          messages.push({
            role: 'user',
            content: `[系统错误]: 工具 JSON 解析失败: ${e.message}。请确保输出合法的 JSON。`,
          });
          continue;
        }
      } else {
        break; // 没有工具调用，对话结束
      }
    }

    this._view?.webview.postMessage({type: 'streamEnd'});
  }

  private async callOllamaModel(
    messages: any[],
    settings: AISettings,
    model: string,
  ): Promise<string> {
    let host = (settings.baseUrl || '[http://127.0.0.1:11434](http://127.0.0.1:11434)')
      .replace('localhost', '127.0.0.1')
      .replace(/\/$/, '');
    const targetUrl = `${host}/api/chat`;
    const numCtxValue = this.parseNumCtx(settings.numCtx);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: true,
        options: {num_ctx: numCtxValue},
      }),
    });

    if (!response.ok || !response.body) throw new Error(`Ollama 状态码: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          const chunk = json.message?.content || '';
          if (chunk) {
            fullText += chunk;
            this._view?.webview.postMessage({type: 'streamChunk', chunk});
          }
        } catch (e) {}
      }
    }
    return fullText;
  }

  private async callOpenAIModel(
    messages: any[],
    settings: AISettings,
    model: string,
  ): Promise<string> {
    let baseUrl = settings.baseUrl || '[http://127.0.0.1:1234/v1';
    // .replace(/](http://127.0.0.1:1234/v1').replace(/)\/$/, '');
    const headers: Record<string, string> = {'Content-Type': 'application/json'};
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
    const numCtxValue = this.parseNumCtx(settings.numCtx);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: true,
        max_tokens: numCtxValue,
      }),
    });

    if (!response.ok || !response.body) throw new Error(`请求失败，状态码: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.replace(/^data:\s*/, '');
        if (dataStr === '[DONE]') continue;

        try {
          const json = JSON.parse(dataStr);
          const chunk = json.choices?.[0]?.delta?.content || '';
          if (chunk) {
            fullText += chunk;
            this._view?.webview.postMessage({type: 'streamChunk', chunk});
          }
        } catch (e) {}
      }
    }
    return fullText;
  }

  private parseNumCtx(numCtxStr: string): number {
    const map: {[key: string]: number} = {
      '8k': 8192,
      '16k': 16384,
      '32k': 32768,
      '64k': 65536,
      '128k': 131072,
      '256k': 262144,
    };
    return map[numCtxStr] || 32768;
  }

  private _getHtmlForWebview(): string {
    const htmlPath = path.join(this._context.extensionUri.fsPath, 'resources', 'webview.html');
    try {
      return fs.readFileSync(htmlPath, 'utf8');
    } catch (err: any) {
      return `<!DOCTYPE html><html><body><h3>加载页面失败: ${err.message}</h3></body></html>`;
    }
  }
}

export function deactivate() {}
