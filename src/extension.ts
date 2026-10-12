import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const outputChannel = vscode.window.createOutputChannel('Ollama AI Assistant');

export function activate(context: vscode.ExtensionContext) {
    outputChannel.appendLine('Ollama 插件已激活');
    const provider = new OllamaChatViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ollamaChatView', provider)
    );
}

class OllamaChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data: any) => {
            outputChannel.show(true);
            outputChannel.appendLine(`[UI事件] 收到前端消息类型: ${data.type}`);
            switch (data.type) {
                case 'getModels':
                    this.fetchAndSendModels();
                    break;
                case 'sendMessage':
                    await this.streamOllamaResponse(data.prompt, data.model);
                    break;
            }
        });
    }

    private fetchAndSendModels() {
        const config = vscode.workspace.getConfiguration('ollamaAssistant');
        let host = config.get<string>('host') || 'http://127.0.0.1:11434';
        host = host.replace('localhost', '127.0.0.1');

        const targetUrl = `${host}/api/tags`;
        outputChannel.appendLine(`[Models] 正在获取模型列表，地址: ${targetUrl}`);

        http.get(targetUrl, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        throw new Error(`服务返回状态码 ${res.statusCode}`);
                    }
                    const json = JSON.parse(data);
                    const models = json.models ? json.models.map((m: any) => m.name) : [];
                    outputChannel.appendLine(`[Models] 成功获取到模型: ${JSON.stringify(models)}`);
                    
                    this._view?.webview.postMessage({
                        type: 'modelList',
                        models: models
                    });
                } catch (e: any) {
                    outputChannel.appendLine(`[Models] 解析模型列表失败: ${e.message}`);
                    vscode.window.showErrorMessage(`解析 Ollama 响应失败: ${e.message}`);
                    this._view?.webview.postMessage({ type: 'modelList', models: [] });
                }
            });
        }).on('error', (err) => {
            outputChannel.appendLine(`[Models] 连接 Ollama 失败: ${err.message}`);
            vscode.window.showErrorMessage(`连接 Ollama 失败: ${err.message}`);
            this._view?.webview.postMessage({ type: 'modelList', models: [] });
        });
    }

    private async streamOllamaResponse(prompt: string, model: string) {
        const config = vscode.workspace.getConfiguration('ollamaAssistant');
        let host = config.get<string>('host') || 'http://127.0.0.1:11434';
        host = host.replace('localhost', '127.0.0.1');
        const targetUrl = `${host}/api/chat`;

        outputChannel.show(true);
        outputChannel.appendLine(`[Chat] 开始向模型 ${model} 发送对话请求...`);

        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/x-ndjson, application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: prompt }],
                    stream: true
                })
            });

            outputChannel.appendLine(`[Chat] Ollama 响应状态码: ${response.status}`);

            if (!response.ok || !response.body) {
                throw new Error(`Ollama 响应错误，状态码: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const json = JSON.parse(trimmed);
                        const messageContent = json.message?.content || '';
                        if (messageContent) {
                            // 已移除单条 chunk 日志打印，提升性能与日志整洁度
                            this._view?.webview.postMessage({
                                type: 'streamChunk',
                                chunk: messageContent
                            });
                        }
                    } catch (e: any) {
                        // 忽略格式不完整的行
                    }
                }
            }

            if (buffer.trim()) {
                try {
                    const json = JSON.parse(buffer.trim());
                    const messageContent = json.message?.content || '';
                    if (messageContent) {
                        this._view?.webview.postMessage({
                            type: 'streamChunk',
                            chunk: messageContent
                        });
                    }
                } catch (e) {}
            }

            outputChannel.appendLine('[Chat] Ollama 响应流结束'); // 只保留响应结束打印
            this._view?.webview.postMessage({ type: 'streamEnd' });

        } catch (error: any) {
            outputChannel.appendLine(`[Chat] 请求 Ollama 聊天出错: ${error.message}`);
            vscode.window.showErrorMessage(`请求 Ollama 聊天失败: ${error.message}`);
            this._view?.webview.postMessage({ type: 'streamEnd' });
        }
    }

    private _getHtmlForWebview(): string {
        const htmlPath = path.join(this._extensionUri.fsPath, 'resources', 'webview.html');
        try {
            return fs.readFileSync(htmlPath, 'utf8');
        } catch (err: any) {
            outputChannel.appendLine(`[Error] 读取 webview.html 失败: ${err.message}`);
            return `<!DOCTYPE html><html><body><h3>加载页面失败: ${err.message}</h3></body></html>`;
        }
    }
}

export function deactivate() {}