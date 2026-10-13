import {AISettings, ChatHistoryItem} from './types';
import {AIHelper} from './aiHelper';
import {MCPExecutor} from './mcpExecutor';

export class SingleAgentHandler {
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

  public async handleSingleAgent(prompt: string, model: string, activeSkill: string) {
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
      this.postMessageToWebview({type: 'streamChunk', chunk});
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
      const rootFiles = await this.mcpExecutor.executeMCPTool('list_directory', {path: ''});

      const reviewPrompt = `当前工作区路径: ${root}
项目文件列表:
${rootFiles}

用户审查指令：${prompt}
请作为资深代码审查员，检查代码质量并给出详细的修改或优化建议。${skillInstruction}`;

      const reviewResult = await this.aiHelper.callModel(
        [
          {
            role: 'system',
            content: '你是一个严格、专业的代码审查员，请直接输出文本分析与修改建议。',
          },
          {role: 'user', content: reviewPrompt},
        ],
        settings,
        model,
      );

      await update(`\n\n⚠️ **审查完成，是否让模型按照上述建议修改代码？**\n`);

      const currentH = this.getStoredHistory();
      const target = currentH.find(item => item.id === newItem.id);
      if (target) {
        target.reviewPending = true;
        target.reviewText = reviewResult;
        await this.saveHistory(currentH);
      }

      this.postMessageToWebview({
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
      const resText = await this.aiHelper.callModel(messages, settings, model);
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

  public async handleApproveReview(historyId: number, reviewText: string, implModel: string) {
    const settings = this.getStoredSettings();
    const history = this.getStoredHistory();
    const targetItem = history.find(h => h.id === historyId);
    if (!targetItem) return;

    targetItem.reviewPending = false;
    targetItem.reviewText = undefined;
    await this.saveHistory(history);

    const update = async (chunk: string) => {
      targetItem.response += chunk;
      await this.saveHistory(history);
      this.postMessageToWebview({type: 'streamChunk', chunk});
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
      const resText = await this.aiHelper.callModel(messages, settings, implModel);
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

    targetItem.completed = true;
    await this.saveHistory(history);
    this.postMessageToWebview({type: 'streamEnd'});
  }
}
