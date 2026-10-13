import * as vscode from 'vscode';
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

interface ChatHistoryItem {
  id: number;
  prompt: string;
  response: string;
  model: string;
  completed: boolean;
  reviewPending?: boolean;
  reviewText?: string;
}

interface CustomSkill {
  name: string;
  content: string;
}

interface CollabConfig {
  designModel: string;
  implModel: string;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine('VS Code Local AI 插件已激活 (修复状态保持与流式插入位置)');
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
        case 'getHistory':
          this.sendHistoryToWebview();
          break;
        case 'deleteHistory':
          await this.deleteHistoryItems(data.ids);
          break;
        case 'getSkills':
          this.sendSkillsToWebview();
          break;
        case 'saveSkill':
          await this.saveCustomSkill(data.skill);
          break;
        case 'deleteSkill':
          await this.deleteCustomSkill(data.name);
          break;
        case 'sendMessage':
          if (data.collabEnabled) {
            await this.handleCollabWorkflow(data.prompt, data.collabConfig, data.activeSkill);
          } else {
            await this.handleSingleAgent(data.prompt, data.model, data.activeSkill);
          }
          break;
        case 'approveReview':
          await this.handleApproveReview(data.historyId, data.reviewText, data.implModel);
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

  private getStoredHistory(): ChatHistoryItem[] {
    return this._context.workspaceState.get<ChatHistoryItem[]>('chatHistory') || [];
  }

  private async saveHistory(history: ChatHistoryItem[]) {
    await this._context.workspaceState.update('chatHistory', history);
  }

  private sendHistoryToWebview() {
    this._view?.webview.postMessage({type: 'renderHistory', history: this.getStoredHistory()});
  }

  private async deleteHistoryItems(ids: number[]) {
    let history = this.getStoredHistory();
    history = history.filter(item => !ids.includes(item.id));
    await this.saveHistory(history);
    this.sendHistoryToWebview();
  }

  private getStoredSkills(): CustomSkill[] {
    return this._context.globalState.get<CustomSkill[]>('customSkills') || [];
  }

  private async saveCustomSkill(skill: CustomSkill) {
    let skills = this.getStoredSkills();
    skills = skills.filter(s => s.name !== skill.name);
    skills.push(skill);
    await this._context.globalState.update('customSkills', skills);
    this.sendSkillsToWebview();
    vscode.window.showInformationMessage(`Skill [${skill.name}] 保存成功！`);
  }

  private async deleteCustomSkill(name: string) {
    let skills = this.getStoredSkills();
    skills = skills.filter(s => s.name !== name);
    await this._context.globalState.update('customSkills', skills);
    this.sendSkillsToWebview();
  }

  private sendSkillsToWebview() {
    this._view?.webview.postMessage({type: 'renderSkills', skills: this.getStoredSkills()});
  }

  private async fetchAndSendModels() {
    const settings = this.getStoredSettings();
    let models: string[] = [];
    let host = (settings.baseUrl || 'http://127.0.0.1:11434')
      .replace('localhost', '127.0.0.1')
      .replace(/\/$/, '');
    try {
      const res = await fetch(`${host}/api/tags`);
      if (res.ok) {
        const json: any = await res.json();
        models = json.models ? json.models.map((m: any) => m.name) : [];
      }
    } catch (e) {}

    this._view?.webview.postMessage({
      type: 'modelList',
      models,
      selectedModel: settings.selectedModel || models[0],
    });
  }

  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  private async executeMCPTool(name: string, args: any): Promise<string> {
    const root = this.getWorkspaceRoot();
    if (!root) return '错误：当前未打开任何工作区文件夹 (Workspace)。';

    if (['read_file', 'write_file', 'delete_file'].includes(name)) {
      if (!args || !args.path || typeof args.path !== 'string' || args.path.trim() === '') {
        return `错误：工具 [${name}] 必须提供有效的 path 参数（文件相对路径）。`;
      }
    }

    const resolvePath = (targetPath: string) => {
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
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
          return `错误：路径 "${args.path}" 是一个目录而不是文件。`;
        }
        return await fs.promises.readFile(filePath, 'utf8');
      } else if (name === 'write_file') {
        const filePath = resolvePath(args.path);
        try {
          const stats = await fs.promises.stat(filePath);
          if (stats.isDirectory()) {
            return `错误：路径 "${args.path}" 是一个已存在的目录，无法直接覆盖写入。`;
          }
        } catch (e) {}
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, {recursive: true});
        await fs.promises.writeFile(filePath, args.content || '', 'utf8');
        return `成功：文件 ${args.path} 已写入。`;
      } else if (name === 'delete_file') {
        const filePath = resolvePath(args.path);
        await fs.promises.unlink(filePath);
        return `成功：文件 ${args.path} 已删除。`;
      }
      return `未知工具: ${name}`;
    } catch (err: any) {
      return `执行 MCP 工具 ${name} 失败: ${err.message}`;
    }
  }

  private extractToolJson(text: string): string {
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const jsonStr = this.findValidJson(match[1].trim());
      if (jsonStr) return jsonStr;
    }
    return this.findValidJson(text) || '';
  }

  private findValidJson(text: string): string | null {
    let start = text.indexOf('{');
    while (start !== -1) {
      let braces = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (esc) {
          esc = false;
          continue;
        }
        if (c === '\\') {
          esc = true;
          continue;
        }
        if (c === '"') {
          inStr = !inStr;
          continue;
        }
        if (!inStr) {
          if (c === '{') braces++;
          else if (c === '}') {
            braces--;
            if (braces === 0) {
              const candidate = text.substring(start, i + 1);
              try {
                const parsed = JSON.parse(candidate);
                if (parsed && (parsed.name || parsed.tool)) {
                  if (!parsed.name && parsed.tool) parsed.name = parsed.tool;
                  return JSON.stringify(parsed);
                }
              } catch (e) {}
              break;
            }
          }
        }
      }
      start = text.indexOf('{', start + 1);
    }
    return null;
  }

  private async handleSingleAgent(prompt: string, model: string, activeSkill: string) {
    const settings = this.getStoredSettings();
    const history = this.getStoredHistory();
    const isReviewRequest = /审查|review|检查|审计/i.test(prompt);

    const newItem: ChatHistoryItem = {
      id: Date.now(),
      prompt: prompt,
      response: '',
      model: model,
      completed: false,
    };
    history.push(newItem);
    await this.saveHistory(history);
    this.sendHistoryToWebview();

    let accumulator = '';
    const update = async (chunk: string) => {
      accumulator += chunk;
      this._view?.webview.postMessage({type: 'streamChunk', chunk});
      const h = this.getStoredHistory();
      const target = h.find(item => item.id === newItem.id);
      if (target) {
        target.response = accumulator;
        await this.saveHistory(h);
      }
    };

    const root = this.getWorkspaceRoot() || '未打开工作区';
    const skillInstruction = activeSkill ? `\n\n【Skill 规则约束】：\n${activeSkill}` : '';

    if (isReviewRequest) {
      await update(`🔍 **[单模型代码审查] 正在读取项目结构并审计...**\n\n`);
      const rootFiles = await this.executeMCPTool('list_directory', {path: ''});

      const reviewPrompt = `当前工作区路径: ${root}
项目文件列表:
${rootFiles}

用户审查指令：${prompt}
请作为资深代码审查员，检查代码质量并给出详细的修改或优化建议。${skillInstruction}`;

      const reviewResult = await this.callModel(
        [
          {
            role: 'system',
            content: '你是一个严格、专业的代码审查员，请直接输出文本分析与修改建议。',
          },
          {role: 'user', content: reviewPrompt},
        ],
        settings,
        model,
        newItem.id,
      );

      await update(`\n\n⚠️ **审查完成，是否让模型按照上述建议修改代码？**\n`);

      // 持久化审查等待状态
      const currentH = this.getStoredHistory();
      const target = currentH.find(item => item.id === newItem.id);
      if (target) {
        target.reviewPending = true;
        target.reviewText = reviewResult;
        await this.saveHistory(currentH);
      }

      this._view?.webview.postMessage({
        type: 'showReviewAction',
        historyId: newItem.id,
        reviewText: reviewResult,
        implModel: model,
      });
      return;
    }

    const systemPrompt = `你是一个专业的 VS Code AI 编程助手。工作区路径: ${root}。
你可以通过 MCP 调用以下工具：
1. list_directory: {"path": "相对路径或空"}
2. read_file: {"path": "文件相对路径"}
3. write_file: {"path": "文件相对路径", "content": "内容"}
4. delete_file: {"path": "文件相对路径"}
需要调用工具时，请输出标准的 JSON 块。${skillInstruction}`;

    let messages = [
      {role: 'system', content: systemPrompt},
      {role: 'user', content: prompt},
    ];

    let steps = 0;
    while (steps < 6) {
      steps++;
      const resText = await this.callModel(messages, settings, model, newItem.id);
      messages.push({role: 'assistant', content: resText});

      const toolJson = this.extractToolJson(resText);
      if (toolJson) {
        try {
          const call = JSON.parse(toolJson);
          await update(
            `\n\n⚙️ **MCP 执行工具 [${call.name}]**: \`${call.arguments?.path || ''}\`\n\n`,
          );
          const result = await this.executeMCPTool(call.name, call.arguments);
          await update(`📥 **工具返回结果**:\n\`\`\`\n${result.slice(0, 400)}\n\`\`\`\n\n`);
          messages.push({role: 'user', content: `[MCP 工具执行结果]:\n${result}`});
          continue;
        } catch (e: any) {
          messages.push({role: 'user', content: `[系统错误]: 工具解析失败: ${e.message}`});
          continue;
        }
      } else {
        break;
      }
    }

    const finalH = this.getStoredHistory();
    const finalTarget = finalH.find(item => item.id === newItem.id);
    if (finalTarget) {
      finalTarget.completed = true;
      await this.saveHistory(finalH);
    }
    this._view?.webview.postMessage({type: 'streamEnd'});
  }

  private async handleApproveReview(historyId: number, reviewText: string, implModel: string) {
    const settings = this.getStoredSettings();
    const history = this.getStoredHistory();
    const targetItem = history.find(h => h.id === historyId);
    if (!targetItem) return;

    // 清除审查等待状态
    targetItem.reviewPending = false;
    targetItem.reviewText = undefined;
    await this.saveHistory(history);

    const update = async (chunk: string) => {
      targetItem.response += chunk;
      await this.saveHistory(history);
      this._view?.webview.postMessage({type: 'streamChunk', chunk});
    };

    await update(`\n\n✨ **[应用修改阶段] 正在根据审查建议修改代码** (模型: \`${implModel}\`)\n\n`);

    const root = this.getWorkspaceRoot() || '未打开工作区';
    const fixPrompt = `工作区路径: ${root}
审查员建议：\n${reviewText}\n请根据建议调用 MCP 工具（如 write_file 或 delete_file）对代码进行修改。`;

    let messages = [
      {
        role: 'system',
        content: `你是一个程序员 Agent。工作区: ${root}。可以通过 JSON 调用 MCP 工具修改文件。`,
      },
      {role: 'user', content: fixPrompt},
    ];

    let steps = 0;
    while (steps < 5) {
      steps++;
      const resText = await this.callModel(messages, settings, implModel, historyId);
      messages.push({role: 'assistant', content: resText});

      const toolJson = this.extractToolJson(resText);
      if (toolJson) {
        try {
          const call = JSON.parse(toolJson);
          await update(
            `\n\n⚙️ **MCP 执行工具 [${call.name}]**: \`${call.arguments?.path || ''}\`\n\n`,
          );
          const result = await this.executeMCPTool(call.name, call.arguments);
          await update(`📥 **工具返回结果**:\n\`\`\`\n${result.slice(0, 400)}\n\`\`\`\n\n`);
          messages.push({role: 'user', content: `[MCP 工具执行结果]:\n${result}`});
          continue;
        } catch (e: any) {
          messages.push({role: 'user', content: `[系统错误]: 工具解析失败: ${e.message}`});
          continue;
        }
      } else {
        break;
      }
    }

    targetItem.completed = true;
    await this.saveHistory(history);
    this._view?.webview.postMessage({type: 'streamEnd'});
  }

  private async handleCollabWorkflow(prompt: string, config: CollabConfig, activeSkill: string) {
    const settings = this.getStoredSettings();
    const history = this.getStoredHistory();
    const designM = config.designModel;
    const implM = config.implModel;

    const newItem: ChatHistoryItem = {
      id: Date.now(),
      prompt: prompt,
      response: '',
      model: `Design: ${designM} ➔ Impl: ${implM}`,
      completed: false,
    };
    history.push(newItem);
    await this.saveHistory(history);
    this.sendHistoryToWebview();

    let accumulator = '';
    const update = async (chunk: string) => {
      accumulator += chunk;
      this._view?.webview.postMessage({type: 'streamChunk', chunk});
      const h = this.getStoredHistory();
      const target = h.find(item => item.id === newItem.id);
      if (target) {
        target.response = accumulator;
        await this.saveHistory(h);
      }
    };

    await update(`🚀 **[多模型协作 - 阶段 1/2: 架构规划]** (模型: \`${designM}\`)\n\n`);
    const planResult = await this.callModel(
      [
        {role: 'system', content: '你是一个资深架构师。请分析需求并给出详细的实现方案与文件清单。'},
        {role: 'user', content: prompt},
      ],
      settings,
      designM,
      newItem.id,
    );

    await update(
      `\n\n---|\n\n💻 **[多模型协作 - 阶段 2/2: 代码实现与落地]** (模型: \`${implM}\`)\n\n`,
    );
    const root = this.getWorkspaceRoot() || '未打开工作区';
    const skillInstruction = activeSkill ? `\n\n【Skill 约束】：\n${activeSkill}` : '';
    const coderPrompt = `工作区路径: ${root}
架构设计方案：
${planResult}

请作为实现程序员，通过 MCP 工具完成代码编写或修改。${skillInstruction}`;

    let messages = [
      {
        role: 'system',
        content: '你是一个擅长写代码的 Agent，可以通过 JSON 格式调用 MCP 工具进行文件增删改。',
      },
      {role: 'user', content: coderPrompt},
    ];

    let steps = 0;
    while (steps < 8) {
      steps++;
      const resText = await this.callModel(messages, settings, implM, newItem.id);
      messages.push({role: 'assistant', content: resText});

      const toolJson = this.extractToolJson(resText);
      if (toolJson) {
        try {
          const call = JSON.parse(toolJson);
          await update(
            `\n\n⚙️ **MCP 执行工具 [${call.name}]**: \`${call.arguments?.path || ''}\`\n\n`,
          );
          const result = await this.executeMCPTool(call.name, call.arguments);
          await update(`📥 **工具返回结果**:\n\`\`\`\n${result.slice(0, 400)}\n\`\`\`\n\n`);
          messages.push({role: 'user', content: `[MCP 工具执行结果]:\n${result}`});
          continue;
        } catch (e: any) {
          messages.push({role: 'user', content: `[系统错误]: 工具解析失败: ${e.message}`});
          continue;
        }
      } else {
        break;
      }
    }

    const finalH = this.getStoredHistory();
    const finalTarget = finalH.find(item => item.id === newItem.id);
    if (finalTarget) {
      finalTarget.completed = true;
      await this.saveHistory(finalH);
    }
    this._view?.webview.postMessage({type: 'streamEnd'});
  }

  private async callModel(
    messages: any[],
    settings: AISettings,
    model: string,
    historyId: number,
  ): Promise<string> {
    const host = (settings.baseUrl || 'http://127.0.0.1:11434')
      .replace('localhost', '127.0.0.1')
      .replace(/\/$/, '');
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: {num_ctx: this.parseNumCtx(settings.numCtx)},
      }),
    });

    if (!res.ok || !res.body) throw new Error(`API 状态码: ${res.status}`);

    const reader = res.body.getReader();
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

  private parseNumCtx(str: string): number {
    const map: {[k: string]: number} = {
      '8k': 8192,
      '16k': 16384,
      '32k': 32768,
      '64k': 65536,
      '128k': 131072,
    };
    return map[str] || 32768;
  }

  private _getHtmlForWebview(): string {
    const htmlPath = path.join(this._context.extensionUri.fsPath, 'resources', 'webview.html');
    try {
      return fs.readFileSync(htmlPath, 'utf8');
    } catch (e) {
      return `<!DOCTYPE html><html><body><h3>无法加载 webview.html</h3></body></html>`;
    }
  }
}

export function deactivate() {}
