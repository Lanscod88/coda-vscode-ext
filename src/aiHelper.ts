import {AISettings} from './types';

export class AIHelper {
  constructor(private postMessageToWebview: (msg: any) => void) {}

  public extractToolJson(text: string): string {
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

  public async callModel(messages: any[], settings: AISettings, model: string): Promise<string> {
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
            this.postMessageToWebview({type: 'streamChunk', chunk});
          }
        } catch (e) {}
      }
    }
    return fullText;
  }

  public parseNumCtx(str: string): number {
    const map: {[k: string]: number} = {
      '8k': 8192,
      '16k': 16384,
      '32k': 32768,
      '64k': 65536,
      '128k': 131072,
    };
    return map[str] || 32768;
  }
}
