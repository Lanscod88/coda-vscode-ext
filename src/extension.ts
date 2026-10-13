import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const outputChannel = vscode.window.createOutputChannel('VS Code Local AI');

interface AISettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  selectedModel?: string;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine('VS Code Local AI 插件已激活');
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
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      selectedModel: '',
    };
    const saved = this._context.globalState.get<AISettings>('aiSettings');
    return saved ? {...defaultSettings, ...saved} : defaultSettings;
  }

  private async saveSettings(settings: AISettings) {
    const current = this.getStoredSettings();
    const merged = {...current, ...settings};
    await this._context.globalState.update('aiSettings', merged);
    outputChannel.appendLine(`[Settings] 配置已保存: 提供商=${merged.provider}`);
    vscode.window.showInformationMessage('AI 配置已成功保存！');
    this._view?.webview.postMessage({type: 'settingsSaved'});
  }

  private sendSettingsToWebview() {
    const settings = this.getStoredSettings();
    this._view?.webview.postMessage({type: 'loadSettings', settings});
  }

  private async fetchAndSendModels() {
    const settings = this.getStoredSettings();
    let models: string[] = [];

    if (settings.provider === 'gemini') {
      models = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
      this._view?.webview.postMessage({
        type: 'modelList',
        models,
        selectedModel: settings.selectedModel || models[0],
      });
    } else if (settings.provider === 'deepseek') {
      models = ['deepseek-chat', 'deepseek-reasoner'];
      this._view?.webview.postMessage({
        type: 'modelList',
        models,
        selectedModel: settings.selectedModel || models[0],
      });
    } else if (settings.provider === 'openai') {
      models = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];
      this._view?.webview.postMessage({
        type: 'modelList',
        models,
        selectedModel: settings.selectedModel || models[0],
      });
    } else {
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

    outputChannel.appendLine(`[Chat] 使用 [${settings.provider}] 模型 (${model}) 发送请求...`);

    if (settings.provider === 'gemini') {
      await this.streamGeminiResponse(prompt, settings, model);
    } else if (settings.provider === 'deepseek' || settings.provider === 'openai') {
      await this.streamOpenAICompatibleResponse(prompt, settings, model);
    } else {
      await this.streamOllamaResponse(prompt, settings, model);
    }
  }

  private async streamGeminiResponse(prompt: string, settings: AISettings, model: string) {
    if (!settings.apiKey) {
      vscode.window.showErrorMessage('请先在插件设置中填写 Gemini API Key');
      this._view?.webview.postMessage({type: 'streamEnd'});
      return;
    }
    // const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${settings.apiKey}`;
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:streamGenerateContent?alt=sse&key=${settings.apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({contents: [{parts: [{text: prompt}]}]}),
      });

      if (!response.ok || !response.body) {
        const errorBody = await response.text();
        outputChannel.appendLine(`[Chat] Gemini 详细错误响应: ${errorBody}`);
        throw new Error(`Gemini API 错误 (${response.status}): ${errorBody}`);
      }

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
          try {
            const json = JSON.parse(trimmed.replace(/^data:\s*/, ''));
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text) {
              this._view?.webview.postMessage({type: 'streamChunk', chunk: text});
            }
          } catch (e) {}
        }
      }
      this._view?.webview.postMessage({type: 'streamEnd'});
    } catch (error: any) {
      vscode.window.showErrorMessage(`Gemini 请求失败: ${error.message}`);
      this._view?.webview.postMessage({type: 'streamEnd'});
    }
  }

  private async streamOpenAICompatibleResponse(
    prompt: string,
    settings: AISettings,
    model: string,
  ) {
    if (!settings.apiKey) {
      vscode.window.showErrorMessage('请先在插件设置中填写 API Key');
      this._view?.webview.postMessage({type: 'streamEnd'});
      return;
    }
    let baseUrl =
      settings.baseUrl ||
      (settings.provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1');
    baseUrl = baseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [{role: 'user', content: prompt}],
          stream: true,
        }),
      });

      if (!response.ok || !response.body) throw new Error(`API 错误: ${response.status}`);

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

  private async streamOllamaResponse(prompt: string, settings: AISettings, model: string) {
    let host = settings.baseUrl || 'http://127.0.0.1:11434';
    host = host.replace('localhost', '127.0.0.1').replace(/\/$/, '');
    const targetUrl = `${host}/api/chat`;

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/x-ndjson'},
        body: JSON.stringify({
          model: model,
          messages: [{role: 'user', content: prompt}],
          stream: true,
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
