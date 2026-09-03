import type { LLMTask } from '../../../infrastructure/llm/llm.types.js';

/* ------------------------------------------------------------------ */
/*  Prompt Template & Management Types (AI-010 / TASK-303)            */
/* ------------------------------------------------------------------ */

export interface PromptTemplate {
  id: string;
  version: string;
  task: LLMTask;
  targetModel: string;
  systemPrompt: string;
  template: string;
  variables: string[];
  changelog: string;
}

export interface RenderedPrompt {
  promptId: string;
  promptVersion: string;
  systemPrompt: string;
  userPrompt: string;
}

export class PromptRenderError extends Error {
  constructor(message: string, public readonly templateId: string, public readonly version: string) {
    super(message);
    this.name = 'PromptRenderError';
  }
}
