/* ------------------------------------------------------------------ */
/*  LLM Provider Abstraction & Model Routing Types (AI-001 / TASK-301)*/
/* ------------------------------------------------------------------ */

export type LLMTask = 'diagnosis' | 'decision' | 'summarisation';

export type LLMProviderType = 'mock' | 'openai' | 'anthropic';

export interface LLMRequest {
  task: LLMTask;
  prompt: string;
  systemPrompt?: string;
  promptVersion?: string;
  schema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  correlationId?: string;
  merchantId?: number;
  metadata?: Record<string, unknown>;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMinorUnits?: number;
}

export interface LLMResponse {
  content: string;
  structuredData?: Record<string, unknown> | null;
  modelId: string;
  promptVersion: string;
  usage: LLMUsage;
  latencyMs: number;
  stopReason: string;
  providerRequestId: string;
}

export interface LLMProvider {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/* ------------------------------------------------------------------ */
/*  Typed LLM Error Hierarchy                                         */
/* ------------------------------------------------------------------ */

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly isTransient: boolean = false,
    public readonly statusCode?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(timeoutMs: number) {
    super(`LLM invocation timed out after ${timeoutMs}ms`, 'LLM_TIMEOUT', true);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMCircuitOpenError extends LLMError {
  constructor(message = 'LLM circuit breaker is OPEN; request fast-failed to engage fallback') {
    super(message, 'LLM_CIRCUIT_OPEN', true);
    this.name = 'LLMCircuitOpenError';
  }
}

export class LLMProviderUnavailableError extends LLMError {
  constructor(message: string, statusCode?: number, cause?: unknown) {
    super(message, 'LLM_PROVIDER_UNAVAILABLE', true, statusCode, cause);
    this.name = 'LLMProviderUnavailableError';
  }
}

export class LLMConcurrencyLimitError extends LLMError {
  constructor(message = 'LLM global concurrency limit reached') {
    super(message, 'LLM_CONCURRENCY_LIMIT', true);
    this.name = 'LLMConcurrencyLimitError';
  }
}

export class LLMSchemaValidationError extends LLMError {
  constructor(message: string, cause?: unknown) {
    super(message, 'LLM_SCHEMA_VALIDATION_ERROR', false, 422, cause);
    this.name = 'LLMSchemaValidationError';
  }
}

export class LLMConfigurationError extends LLMError {
  constructor(message: string) {
    super(message, 'LLM_CONFIG_ERROR', false);
    this.name = 'LLMConfigurationError';
  }
}
