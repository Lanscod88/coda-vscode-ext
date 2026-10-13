export interface AISettings {
  protocol: 'ollama' | 'openai';
  baseUrl: string;
  apiKey: string;
  selectedModel?: string;
  numCtx: string;
}

export interface ChatHistoryItem {
  id: number;
  prompt: string;
  response: string;
  model: string;
  completed: boolean;
  reviewPending?: boolean;
  reviewText?: string;
}

export interface CustomSkill {
  name: string;
  content: string;
}

export interface CollabConfig {
  designModel: string;
  implModel: string;
}
