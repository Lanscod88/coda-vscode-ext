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
  numCtx: string; // e.g. "32k"
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine('VS Code Local AI 插件已激活 (多协议本地引擎专版)');
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
          await this.handleSendMessage(data.prompt, data.model);
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
    outputChannel.appendLine(
      `[Settings] 本地 AI 配置已保存: 协议=${merged.protocol}, 地址=${merged.baseUrl}, 上下文=${merged.numCtx}`,
    );
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
      // 支持 LM Studio / vLLM / llama.cpp 的 /v1/models 接口
      let baseUrl = settings.baseUrl || 'http://127.0.0.1:1234/v1';
      baseUrl = baseUrl.replace(/\/$/, '');
      const targetUrl = `${baseUrl}/models`;

      try {
        const headers: Record<string, string> = {};
        if (settings.apiKey) {
          headers['Authorization'] = `Bearer ${settings.apiKey}`;
        }
        const res = await fetch(targetUrl, {headers});
        if (res.ok) {
          const json: any = await res.json();
          if (Array.isArray(json.data)) {
            models = json.data.map((m: any) => m.id);
          }
        }
      } catch (e) {
        outputChannel.appendLine(`[Fetch Models] OpenAI 兼容接口拉取模型失败: ${e}`);
      }

      this._view?.webview.postMessage({
        type: 'modelList',
        models,
        selectedModel: settings.selectedModel || models[0],
      });
    } else {
      // Ollama 协议原生接口 /api/tags
      let host = settings.baseUrl || 'http://127.0.0.1:11434';
      host = host.replace('localhost', '127.0.0.1').replace(/\/$/, '');
      const targetUrl = `${host}/api/tags`;

      http
        .get(targetUrl, res => {
          let data = '';
          res.on('data', chunk => {
            data += chunk;
          });
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
        .on('error', () => {
          this._view?.webview.postMessage({type: 'modelList', models: []});
        });
    }
  }

  private async handleSendMessage(prompt: string, model: string) {
    const settings = this.getStoredSettings();
    settings.selectedModel = model;
    await this._context.globalState.update('aiSettings', settings);

    outputChannel.appendLine(
      `[Chat] 使用 [${settings.protocol}] 协议模型 (${model}) 发送请求，上下文: ${settings.numCtx}...`,
    );

    if (settings.protocol === 'openai') {
      await this.streamOpenAICompatibleResponse(prompt, settings, model);
    } else {
      await this.streamOllamaResponse(prompt, settings, model);
    }
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

  private async streamOllamaResponse(prompt: string, settings: AISettings, model: string) {
    let host = settings.baseUrl || 'http://127.0.0.1:11434';
    host = host.replace('localhost', '127.0.0.1').replace(/\/$/, '');
    const targetUrl = `${host}/api/chat`;

    const numCtxValue = this.parseNumCtx(settings.numCtx);

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/x-ndjson'},
        body: JSON.stringify({
          model: model,
          messages: [{role: 'user', content: prompt}],
          stream: true,
          options: {
            num_ctx: numCtxValue,
          },
        }),
      });

      if (!response.ok || !response.body) throw new Error(`Ollama 状态码: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

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
            const messageContent = json.message?.content || '';
            if (messageContent) {
              this._view?.webview.postMessage({type: 'streamChunk', chunk: messageContent});
            }
          } catch (e) {}
        }
      }
      this._view?.webview.postMessage({type: 'streamEnd'});
    } catch (error: any) {
      vscode.window.showErrorMessage(`Ollama 请求失败: ${error.message}`);
      this._view?.webview.postMessage({type: 'streamEnd'});
    }
  }

  private async streamOpenAICompatibleResponse(
    prompt: string,
    settings: AISettings,
    model: string,
  ) {
    let baseUrl = settings.baseUrl || 'http://127.0.0.1:1234/v1';
    baseUrl = baseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {'Content-Type': 'application/json'};
    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    const numCtxValue = this.parseNumCtx(settings.numCtx);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          messages: [{role: 'user', content: prompt}],
          stream: true,
          max_tokens: numCtxValue, // 通用参数
        }),
      });

      if (!response.ok || !response.body) throw new Error(`请求失败，状态码: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

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
            const content = json.choices?.[0]?.delta?.content || '';
            if (content) {
              this._view?.webview.postMessage({type: 'streamChunk', chunk: content});
            }
          } catch (e) {}
        }
      }
      this._view?.webview.postMessage({type: 'streamEnd'});
    } catch (error: any) {
      vscode.window.showErrorMessage(`请求失败: ${error.message}`);
      this._view?.webview.postMessage({type: 'streamEnd'});
    }
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
