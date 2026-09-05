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
/*  Gemini Provider Adapter (Google AI Studio OpenAI-Compatible API)   */
/* ------------------------------------------------------------------ */

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

export interface GeminiProviderOptions {
  apiKey?: string;
  taskModelMapping?: Record<LLMTask, string>;
  client?: OpenAI;
  baseURL?: string;
}

const DEFAULT_TASK_MODELS: Record<LLMTask, string> = {
  diagnosis: 'gemini-3.6-flash',
  decision: 'gemini-3.1-pro-preview',
  summarisation: 'gemini-3.6-flash'
};

/**
 * Strips raw API keys or potential credential tokens from error messages to prevent leakage.
 */
function sanitizeErrorMessage(message: string, apiKey?: string): string {
  let sanitized = message;
  if (apiKey && apiKey.length > 4) {
    sanitized = sanitized.replaceAll(apiKey, '[REDACTED_API_KEY]');
  }
  const geminiEnvKey = process.env.GEMINI_API_KEY;
  if (geminiEnvKey && geminiEnvKey.length > 4) {
    sanitized = sanitized.replaceAll(geminiEnvKey, '[REDACTED_API_KEY]');
  }
  const openaiEnvKey = process.env.OPENAI_API_KEY;
  if (openaiEnvKey && openaiEnvKey.length > 4) {
    sanitized = sanitized.replaceAll(openaiEnvKey, '[REDACTED_API_KEY]');
  }
  // Sanitize Google AI API key pattern (AIza...) and OpenAI key pattern (sk-...)
  sanitized = sanitized.replace(/AIza[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
  sanitized = sanitized.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
  return sanitized;
}

export class GeminiProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly taskModelMapping: Record<LLMTask, string>;

  constructor(options?: GeminiProviderOptions) {
    this.baseURL = options?.baseURL || process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL;

    if (options?.client) {
      this.client = options.client;
      this.apiKey = options.apiKey || 'mock-key';
    } else {
      const key = options?.apiKey || process.env.GEMINI_API_KEY;
      if (!key || key.trim() === '') {
        throw new LLMConfigurationError(
          'GEMINI_API_KEY is required to initialize GeminiProvider.'
        );
      }
      this.apiKey = key.trim();
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseURL,
        maxRetries: 0 // Handled upstream by OrchestratedLLMProvider to prevent duplicate retries
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

  public getBaseURL(): string {
    return this.baseURL;
  }

  public getTaskModel(task: LLMTask): string {
    return this.taskModelMapping[task] || DEFAULT_TASK_MODELS[task] || 'gemini-3.6-flash';
  }

  /**
   * Translates internal LLMRequest into a Gemini OpenAI-compatible Chat Completion request,
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
      throw this.mapGeminiError(err, request.timeoutMs);
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
      providerRequestId: completion.id || `req_gemini_${generateUlid()}`
    };
  }

  private mapGeminiError(err: unknown, timeoutMs?: number): LLMError {
    if (err instanceof LLMError) {
      return err;
    }

    if (err instanceof AuthenticationError) {
      return new LLMError(
        'Gemini authentication failed: Invalid API key or unauthorized access',
        'GEMINI_AUTH_ERROR',
        false,
        401,
        err
      );
    }

    if (err instanceof RateLimitError) {
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'GEMINI_RATE_LIMIT',
        true,
        429,
        err
      );
    }

    if (err instanceof BadRequestError) {
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'GEMINI_BAD_REQUEST',
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
        `Gemini connection error: ${sanitizeErrorMessage(err.message, this.apiKey)}`,
        undefined,
        err
      );
    }

    if (err instanceof APIError) {
      const isTransient = err.status ? err.status === 429 || err.status >= 500 : false;
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'GEMINI_API_ERROR',
        isTransient,
        err.status,
        err
      );
    }

    const message = err instanceof Error ? err.message : 'Unknown Gemini error';
    return new LLMError(
      sanitizeErrorMessage(message, this.apiKey),
      'GEMINI_UNKNOWN_ERROR',
      false,
      undefined,
      err
    );
  }
}
