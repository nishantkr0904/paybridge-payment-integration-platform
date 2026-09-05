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
/*  OmniRoute Provider Adapter (OpenAI-Compatible Local Gateway)      */
/* ------------------------------------------------------------------ */

export const DEFAULT_OMNIROUTE_BASE_URL = 'http://localhost:20128/v1';

export interface OmniRouteProviderOptions {
  apiKey?: string;
  taskModelMapping?: Record<LLMTask, string>;
  taskMaxTokens?: Record<LLMTask, number>;
  client?: OpenAI;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_TASK_MODELS: Record<LLMTask, string> = {
  diagnosis: 'antigravity/gemini-3.6-flash-low',
  decision: 'antigravity/gemini-3.1-pro-low',
  summarisation: 'antigravity/gemini-3.6-flash-low'
};

export const DEFAULT_OMNIROUTE_TASK_MAX_TOKENS: Record<LLMTask, number> = {
  diagnosis: 1600,
  decision: 1600,
  summarisation: 800
};

/**
 * Strips raw API keys or potential credential tokens from error messages to prevent leakage.
 */
function sanitizeErrorMessage(message: string, apiKey?: string): string {
  let sanitized = message;
  if (apiKey && apiKey.length > 4) {
    sanitized = sanitized.replaceAll(apiKey, '[REDACTED_API_KEY]');
  }
  const omnirouteEnvKey = process.env.OMNIROUTE_API_KEY;
  if (omnirouteEnvKey && omnirouteEnvKey.length > 4) {
    sanitized = sanitized.replaceAll(omnirouteEnvKey, '[REDACTED_API_KEY]');
  }
  const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (anthropicAuthToken && anthropicAuthToken.length > 4) {
    sanitized = sanitized.replaceAll(anthropicAuthToken, '[REDACTED_API_KEY]');
  }
  const openrouterEnvKey = process.env.OPENROUTER_API_KEY;
  if (openrouterEnvKey && openrouterEnvKey.length > 4) {
    sanitized = sanitized.replaceAll(openrouterEnvKey, '[REDACTED_API_KEY]');
  }
  const geminiEnvKey = process.env.GEMINI_API_KEY;
  if (geminiEnvKey && geminiEnvKey.length > 4) {
    sanitized = sanitized.replaceAll(geminiEnvKey, '[REDACTED_API_KEY]');
  }
  const openaiEnvKey = process.env.OPENAI_API_KEY;
  if (openaiEnvKey && openaiEnvKey.length > 4) {
    sanitized = sanitized.replaceAll(openaiEnvKey, '[REDACTED_API_KEY]');
  }
  // Sanitize key patterns (sk-..., sk-or-v1-..., AIza...)
  sanitized = sanitized.replace(/sk-[a-zA-Z0-9_-]{16,}/g, '[REDACTED_API_KEY]');
  sanitized = sanitized.replace(/AIza[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
  return sanitized;
}

export class OmniRouteProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly taskModelMapping: Record<LLMTask, string>;
  private readonly taskMaxTokens: Record<LLMTask, number>;

  constructor(options?: OmniRouteProviderOptions) {
    this.baseURL = options?.baseURL || process.env.OMNIROUTE_BASE_URL || DEFAULT_OMNIROUTE_BASE_URL;

    if (options?.client) {
      this.client = options.client;
      this.apiKey = options.apiKey || 'mock-key';
    } else {
      const key =
        options?.apiKey ||
        process.env.OMNIROUTE_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN;

      if (!key || key.trim() === '') {
        throw new LLMConfigurationError(
          'OMNIROUTE_API_KEY (or ANTHROPIC_AUTH_TOKEN) is required to initialize OmniRouteProvider.'
        );
      }
      this.apiKey = key.trim();
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseURL,
        defaultHeaders: {
          'X-Title': 'PayBridge Recovery Platform',
          ...(options?.defaultHeaders || {})
        },
        maxRetries: 0 // Handled upstream by OrchestratedLLMProvider
      });
    }

    this.taskModelMapping = {
      ...DEFAULT_TASK_MODELS,
      ...(options?.taskModelMapping ?? {})
    };

    this.taskMaxTokens = {
      ...DEFAULT_OMNIROUTE_TASK_MAX_TOKENS,
      ...(options?.taskMaxTokens ?? {})
    };
  }

  public getClient(): OpenAI {
    return this.client;
  }

  public getBaseURL(): string {
    return this.baseURL;
  }

  public getTaskModel(task: LLMTask): string {
    const envSpecific =
      task === 'diagnosis'
        ? (process.env.OMNIROUTE_DIAGNOSIS_MODEL || process.env.OMNIROUTE_MODEL_DIAGNOSIS)
        : task === 'decision'
          ? (process.env.OMNIROUTE_DECISION_MODEL || process.env.OMNIROUTE_MODEL_DECISION)
          : (process.env.OMNIROUTE_SUMMARISATION_MODEL || process.env.OMNIROUTE_MODEL_SUMMARISATION);

    if (envSpecific && envSpecific.trim() !== '') {
      return envSpecific.trim();
    }

    if (process.env.OMNIROUTE_MODEL && process.env.OMNIROUTE_MODEL.trim() !== '') {
      return process.env.OMNIROUTE_MODEL.trim();
    }

    return this.taskModelMapping[task] || DEFAULT_TASK_MODELS[task];
  }

  public getTaskMaxTokens(task: LLMTask): number {
    const envSpecific =
      task === 'diagnosis'
        ? (process.env.OMNIROUTE_DIAGNOSIS_MAX_TOKENS || process.env.OMNIROUTE_MAX_TOKENS_DIAGNOSIS)
        : task === 'decision'
          ? (process.env.OMNIROUTE_DECISION_MAX_TOKENS || process.env.OMNIROUTE_MAX_TOKENS_DECISION)
          : (process.env.OMNIROUTE_SUMMARISATION_MAX_TOKENS || process.env.OMNIROUTE_MAX_TOKENS_SUMMARISATION);

    if (envSpecific && Number(envSpecific) > 0) {
      return Number(envSpecific);
    }

    if (process.env.OMNIROUTE_MAX_TOKENS && Number(process.env.OMNIROUTE_MAX_TOKENS) > 0) {
      return Number(process.env.OMNIROUTE_MAX_TOKENS);
    }

    return this.taskMaxTokens[task] || DEFAULT_OMNIROUTE_TASK_MAX_TOKENS[task] || 1600;
  }

  /**
   * Translates internal LLMRequest into an OpenAI-compatible Chat Completion request
   * directed at the local OmniRoute gateway, ensures stream=false, invokes the API,
   * and formats the output into LLMResponse.
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

    const effectiveMaxTokens =
      request.maxTokens !== undefined && request.maxTokens > 0
        ? request.maxTokens
        : this.getTaskMaxTokens(request.task);

    // CRITICAL: OmniRoute defaults to streaming SSE if stream is omitted.
    // Explicitly enforce stream: false to receive a standard JSON response.
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
      temperature: request.temperature ?? 0.1,
      max_tokens: effectiveMaxTokens,
      stream: false
    };

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
      throw this.mapOmniRouteError(err, request.timeoutMs);
    }

    const latencyMs = Date.now() - startTime;
    const choice = completion.choices?.[0];
    const content = choice?.message?.content || '';

    let structuredData: Record<string, unknown> | null = null;
    if (isJsonRequested && content) {
      try {
        structuredData = JSON.parse(content);
      } catch {
        // Try stripping markdown fences if model returned ```json ... ```
        const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenceMatch && fenceMatch[1]) {
          try {
            structuredData = JSON.parse(fenceMatch[1]);
          } catch {
            structuredData = null;
          }
        } else {
          structuredData = null;
        }
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
      providerRequestId: completion.id || `req_omniroute_${generateUlid()}`
    };
  }

  private mapOmniRouteError(err: unknown, timeoutMs?: number): LLMError {
    if (err instanceof LLMError) {
      return err;
    }

    if (err instanceof AuthenticationError) {
      return new LLMError(
        'OmniRoute authentication failed: Invalid API key or unauthorized access',
        'OMNIROUTE_AUTH_ERROR',
        false,
        401,
        err
      );
    }

    if (err instanceof RateLimitError) {
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'OMNIROUTE_RATE_LIMIT',
        true,
        429,
        err
      );
    }

    if (err instanceof BadRequestError) {
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'OMNIROUTE_BAD_REQUEST',
        false,
        400,
        err
      );
    }

    if (err instanceof InternalServerError) {
      return new LLMProviderUnavailableError(
        `OmniRoute internal server error: ${sanitizeErrorMessage(err.message, this.apiKey)}`,
        500,
        err
      );
    }

    if (err instanceof APIConnectionTimeoutError) {
      return new LLMTimeoutError(timeoutMs || 20000);
    }

    if (err instanceof APIConnectionError) {
      return new LLMProviderUnavailableError(
        `OmniRoute connection failed: ${sanitizeErrorMessage(err.message, this.apiKey)}`,
        503,
        err
      );
    }

    if (err instanceof APIUserAbortError) {
      return new LLMError(
        'OmniRoute request was aborted',
        'OMNIROUTE_ABORTED',
        false,
        499,
        err
      );
    }

    if (err instanceof APIError) {
      const sanitized = sanitizeErrorMessage(err.message, this.apiKey);
      return new LLMError(
        `OmniRoute API error (${err.status}): ${sanitized}`,
        'OMNIROUTE_API_ERROR',
        err.status ? err.status >= 500 || err.status === 429 : false,
        err.status,
        err
      );
    }

    if (err instanceof Error) {
      return new LLMError(
        sanitizeErrorMessage(err.message, this.apiKey),
        'OMNIROUTE_UNKNOWN_ERROR',
        false,
        undefined,
        err
      );
    }

    return new LLMError('Unknown OmniRoute provider error occurred', 'OMNIROUTE_UNKNOWN_ERROR', false);
  }
}
