import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {AISettings, ChatHistoryItem, CustomSkill} from './types';
import {MCPExecutor} from './mcpExecutor';
import {AIHelper} from './aiHelper';
import {SingleAgentHandler} from './singleAgentHandler';
import {CollabHandler} from './collabHandler';

const outputChannel = vscode.window.createOutputChannel('VS Code Local AI');

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine('VS Code Local AI 插件已激活 (多文件模块化架构)');
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
  private mcpExecutor: MCPExecutor;
  private aiHelper: AIHelper;
  private singleAgentHandler: SingleAgentHandler;
  private collabHandler: CollabHandler;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this.mcpExecutor = new MCPExecutor(() => this.getWorkspaceRoot());
    this.aiHelper = new AIHelper(msg => this._view?.webview.postMessage(msg));
    this.singleAgentHandler = new SingleAgentHandler(
      this.aiHelper,
      this.mcpExecutor,
      () => this.getStoredSettings(),
      () => this.getStoredHistory(),
      h => this.saveHistory(h),
      () => this.sendHistoryToWebview(),
      () => this.getWorkspaceRoot(),
      msg => this._view?.webview.postMessage(msg),
    );
    this.collabHandler = new CollabHandler(
      this.aiHelper,
      this.mcpExecutor,
      () => this.getStoredSettings(),
      () => this.getStoredHistory(),
      h => this.saveHistory(h),
      () => this.sendHistoryToWebview(),
      () => this.getWorkspaceRoot(),
      msg => this._view?.webview.postMessage(msg),
    );
  }

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
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

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
            await this.collabHandler.handleCollabWorkflow(
              data.prompt,
              data.collabConfig,
              data.activeSkill,
            );
          } else {
            await this.singleAgentHandler.handleSingleAgent(
              data.prompt,
              data.model,
              data.activeSkill,
            );
          }
          break;
        case 'approveReview':
          await this.singleAgentHandler.handleApproveReview(
            data.historyId,
            data.reviewText,
            data.implModel,
          );
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

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const stylePath = vscode.Uri.joinPath(this._context.extensionUri, 'resources', 'main.css');
    const scriptPath = vscode.Uri.joinPath(this._context.extensionUri, 'resources', 'main.js');

    const styleUri = webview.asWebviewUri(stylePath);
    const scriptUri = webview.asWebviewUri(scriptPath);

    const htmlPath = path.join(this._context.extensionUri.fsPath, 'resources', 'webview.html');
    try {
      let htmlContent = fs.readFileSync(htmlPath, 'utf8');
      return htmlContent
        .replace('{{styleUri}}', styleUri.toString())
        .replace('{{scriptUri}}', scriptUri.toString());
    } catch (e) {
      return `<!DOCTYPE html><html><body><h3>无法加载 webview.html</h3></body></html>`;
    }
  }
}

export function deactivate() {}
