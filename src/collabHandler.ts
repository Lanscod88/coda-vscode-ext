import {AISettings, ChatHistoryItem, CollabConfig} from './types';
import {AIHelper} from './aiHelper';
import {MCPExecutor} from './mcpExecutor';

export class CollabHandler {
  constructor(
    private aiHelper: AIHelper,
    private mcpExecutor: MCPExecutor,
    private getStoredSettings: () => AISettings,
    private getStoredHistory: () => ChatHistoryItem[],
    private saveHistory: (history: ChatHistoryItem[]) => Promise<void>,
    private sendHistoryToWebview: () => void,
    private getWorkspaceRoot: () => string | undefined,
    private postMessageToWebview: (msg: any) => void,
  ) {}

  public async handleCollabWorkflow(prompt: string, config: CollabConfig, activeSkill: string) {
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
      this.postMessageToWebview({type: 'streamChunk', chunk});
      const h = this.getStoredHistory();
      const target = h.find(item => item.id === newItem.id);
      if (target) {
        target.response = accumulator;
        await this.saveHistory(h);
      }
    };

    await update(`🚀 **[多模型协作 - 阶段 1/2: 架构规划]** (模型: \`${designM}\`)\n\n`);
    const planResult = await this.aiHelper.callModel(
      [
        {role: 'system', content: '你是一个资深架构师。请分析需求并给出详细的实现方案与文件清单。'},
        {role: 'user', content: prompt},
      ],
      settings,
      designM,
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
      const resText = await this.aiHelper.callModel(messages, settings, implM);
      messages.push({role: 'assistant', content: resText});

      const toolJson = this.aiHelper.extractToolJson(resText);
      if (toolJson) {
        try {
          const call = JSON.parse(toolJson);
          await update(
            `\n\n⚙️ **MCP 执行工具 [${call.name}]**: \`${call.arguments?.path || ''}\`\n\n`,
          );
          const result = await this.mcpExecutor.executeMCPTool(call.name, call.arguments);
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
    this.postMessageToWebview({type: 'streamEnd'});
  }
}
