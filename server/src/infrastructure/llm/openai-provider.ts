import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError
} from 'openai';
import { generateUlid } from '../../utils/ulid.js';
import {
  LLMConfigurationError,
  LLMError,
  LLMProvider,
  LLMProviderUnavailableError,
  LLMRequest,
  LLMResponse,
  LLMTask,
  LLMTimeoutError
} from './llm.types.js';

/* ------------------------------------------------------------------ */
/*  OpenAI Provider Adapter (AI-001 / BT-B1)                          */
/* ------------------------------------------------------------------ */

export interface OpenAIProviderOptions {
  apiKey?: string;
  taskModelMapping?: Record<LLMTask, string>;
  client?: OpenAI;
  organization?: string;
  baseURL?: string;
}

const DEFAULT_TASK_MODELS: Record<LLMTask, string> = {
  diagnosis: 'gpt-4o-mini',
  decision: 'gpt-4o',
  summarisation: 'gpt-4o-mini'
};

/**
 * Strips raw API keys or potential credential tokens from error messages to prevent leakage.
 */
function sanitizeErrorMessage(message: string, apiKey?: string): string {
  let sanitized = message;
  if (apiKey && apiKey.length > 4) {
    sanitized = sanitized.replaceAll(apiKey, '[REDACTED_API_KEY]');
  }
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey && envKey.length > 4) {
    sanitized = sanitized.replaceAll(envKey, '[REDACTED_API_KEY]');
  }
  sanitized = sanitized.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
  return sanitized;
}

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly taskModelMapping: Record<LLMTask, string>;

  constructor(options?: OpenAIProviderOptions) {
    if (options?.client) {
      this.client = options.client;
      this.apiKey = options.apiKey || 'mock-key';
    } else {
      const key = options?.apiKey || process.env.OPENAI_API_KEY;
      if (!key || key.trim() === '') {
        throw new LLMConfigurationError(
          'OPENAI_API_KEY is required to initialize OpenAIProvider.'
        );
      }
      this.apiKey = key.trim();
      this.client = new OpenAI({
        apiKey: this.apiKey,
        maxRetries: 0, // Handled upstream by OrchestratedLLMProvider to prevent duplicate retries
        organization: options?.organization,
        baseURL: options?.baseURL
      });
    }

    this.taskModelMapping = {
      ...DEFAULT_TASK_MODELS,
      ...(options?.taskModelMapping ?? {})
    };
  }

  public getClient(): OpenAI {
    return this.client;
  }

  public getTaskModel(task: LLMTask): string {
    return this.taskModelMapping[task] || DEFAULT_TASK_MODELS[task] || 'gpt-4o-mini';
  }

  /**
   * Translates internal LLMRequest into an OpenAI Chat Completion request,
   * invokes the API, and formats the output into LLMResponse.
   */
  public async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!request || !request.prompt) {
      throw new LLMError('LLM request prompt is required', 'INVALID_REQUEST', false, 400);
    }

    const model = (request.metadata?.model as string) || this.getTaskModel(request.task);

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (request.systemPrompt) {
      messages.push({
        role: 'system',
        content: request.systemPrompt
      });
    }

    messages.push({
      role: 'user',
      content: request.prompt
    });

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
      temperature: request.temperature ?? 0.1
    };

    if (request.maxTokens !== undefined && request.maxTokens > 0) {
      params.max_tokens = request.maxTokens;
    }

    // Request JSON mode if a schema is provided or if prompt instructs structured JSON output
    const isJsonRequested =
      !!request.schema ||
      /json/i.test(request.prompt) ||
      (request.systemPrompt ? /json/i.test(request.systemPrompt) : false);

    if (isJsonRequested) {
      params.response_format = { type: 'json_object' };
    }

    const startTime = Date.now();
    let completion: OpenAI.Chat.Completions.ChatCompletion;

    try {
      completion = await this.client.chat.completions.create(params);
    } catch (err: unknown) {
      throw this.mapOpenAIError(err, request.timeoutMs);
    }

    const latencyMs = Date.now() - startTime;
    const choice = completion.choices?.[0];
    const content = choice?.message?.content || '';

    let structuredData: Record<string, unknown> | null = null;
    if (isJsonRequested && content) {
      try {
        structuredData = JSON.parse(content);
      } catch {
        structuredData = null;
      }
    }

    const inputTokens = completion.usage?.prompt_tokens ?? 0;
    const outputTokens = completion.usage?.completion_tokens ?? 0;
    const totalTokens = completion.usage?.total_tokens ?? (inputTokens + outputTokens);

    return {
      content,
      structuredData,
      modelId: completion.model || model,
      promptVersion: request.promptVersion || 'v1.0.0',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens
      },
      latencyMs,
      stopReason: choice?.finish_reason || 'stop',
      providerRequestId: completion.id || `req_openai_${generateUlid()}`
    };
  }

  private mapOpenAIError(err: unknown, timeoutMs?: number): LLMError {
    if (err instanceof LLMError) {
      return err;
    }

    if (err instanceof AuthenticationError) {
      return new LLMError(
        'OpenAI authentication failed: Invalid API key or unauthorized access',
        'OPENAI_AUTH_ERROR',
        false,
        401,
        err
      );
    }

    if (err instanceof RateLimitError) {
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'OPENAI_RATE_LIMIT',
        true,
        429,
        err
      );
    }

    if (err instanceof BadRequestError) {
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'OPENAI_BAD_REQUEST',
        false,
        400,
        err
      );
    }

    if (err instanceof InternalServerError) {
      return new LLMProviderUnavailableError(
        sanitizeErrorMessage(err.message, this.apiKey),
        err.status ?? 500,
        err
      );
    }

    if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) {
      return new LLMTimeoutError(timeoutMs ?? 20000);
    }

    if (err instanceof APIConnectionError) {
      return new LLMProviderUnavailableError(
        `OpenAI connection error: ${sanitizeErrorMessage(err.message, this.apiKey)}`,
        undefined,
        err
      );
    }

    if (err instanceof APIError) {
      const isTransient = err.status ? err.status === 429 || err.status >= 500 : false;
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'OPENAI_API_ERROR',
        isTransient,
        err.status,
        err
      );
    }

    const message = err instanceof Error ? err.message : 'Unknown OpenAI error';
    return new LLMError(
      sanitizeErrorMessage(message, this.apiKey),
      'OPENAI_UNKNOWN_ERROR',
      false,
      undefined,
      err
    );
  }
}
