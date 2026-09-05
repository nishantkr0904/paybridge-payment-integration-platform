import { logger } from '../../utils/logger.js';
import { generateUlid } from '../../utils/ulid.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import {
  LLMConfigurationError,
  LLMProvider,
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  LLMTask,
  LLMTimeoutError
} from './llm.types.js';
import { MockLLMProvider } from './mock-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { OpenRouterGeminiProvider } from './openrouter-gemini-provider.js';
import { OmniRouteProvider } from './omniroute-provider.js';
import { executeWithRetry } from './retry.js';

/* ------------------------------------------------------------------ */
/*  LLM Provider Configuration & Routing (AI-001 / TASK-301)          */
/* ------------------------------------------------------------------ */

export interface LLMConfig {
  aiEnabled: boolean;
  provider: LLMProviderType;
  defaultTimeoutMs: number;
  maxConcurrency: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  geminiBaseURL?: string;
  openrouterApiKey?: string;
  openrouterBaseURL?: string;
  omnirouteApiKey?: string;
  omnirouteBaseURL?: string;
  taskModelMapping: Record<LLMTask, string>;
}

export function loadLLMConfig(overrideProvider?: LLMProviderType): LLMConfig {
  const aiEnabled = process.env.AI_ENABLED === 'true';
  const provider = overrideProvider || (process.env.LLM_PROVIDER as LLMProviderType) || 'mock';
  const defaultTimeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 20000;
  const maxConcurrency = Number(process.env.LLM_MAX_CONCURRENCY) || 10;
  const circuitBreakerThreshold = Number(process.env.LLM_CIRCUIT_BREAKER_THRESHOLD) || 5;
  const circuitBreakerResetMs = Number(process.env.LLM_CIRCUIT_BREAKER_RESET_MS) || 30000;

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiBaseURL = process.env.GEMINI_BASE_URL;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const openrouterBaseURL = process.env.OPENROUTER_BASE_URL;
  const omnirouteApiKey = process.env.OMNIROUTE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const omnirouteBaseURL = process.env.OMNIROUTE_BASE_URL;

  const isGemini = provider === 'gemini';
  const isOpenRouter = provider === 'openrouter';
  const isOmniRoute = provider === 'omniroute';

  const taskModelMapping: Record<LLMTask, string> = {
    diagnosis: isOmniRoute
      ? (process.env.OMNIROUTE_DIAGNOSIS_MODEL || process.env.OMNIROUTE_MODEL_DIAGNOSIS || process.env.LLM_MODEL_DIAGNOSIS || 'antigravity/gemini-3.6-flash-low')
      : isOpenRouter
        ? (process.env.OPENROUTER_DIAGNOSIS_MODEL || process.env.OPENROUTER_MODEL_DIAGNOSIS || process.env.LLM_MODEL_DIAGNOSIS || 'google/gemini-3.6-flash')
        : isGemini
          ? (process.env.GEMINI_DIAGNOSIS_MODEL || process.env.GEMINI_MODEL_DIAGNOSIS || process.env.LLM_MODEL_DIAGNOSIS || 'gemini-3.6-flash')
          : (process.env.LLM_MODEL_DIAGNOSIS || 'gpt-4o-mini'),
    decision: isOmniRoute
      ? (process.env.OMNIROUTE_DECISION_MODEL || process.env.OMNIROUTE_MODEL_DECISION || process.env.LLM_MODEL_DECISION || 'antigravity/gemini-3.1-pro-low')
      : isOpenRouter
        ? (process.env.OPENROUTER_DECISION_MODEL || process.env.OPENROUTER_MODEL_DECISION || process.env.LLM_MODEL_DECISION || 'google/gemini-3.1-pro-preview')
        : isGemini
          ? (process.env.GEMINI_DECISION_MODEL || process.env.GEMINI_MODEL_DECISION || process.env.LLM_MODEL_DECISION || 'gemini-3.1-pro-preview')
          : (process.env.LLM_MODEL_DECISION || 'gpt-4o'),
    summarisation: isOmniRoute
      ? (process.env.OMNIROUTE_SUMMARISATION_MODEL || process.env.OMNIROUTE_MODEL_SUMMARISATION || process.env.LLM_MODEL_SUMMARISATION || 'antigravity/gemini-3.6-flash-low')
      : isOpenRouter
        ? (process.env.OPENROUTER_SUMMARISATION_MODEL || process.env.OPENROUTER_MODEL_SUMMARISATION || process.env.LLM_MODEL_SUMMARISATION || 'google/gemini-3.6-flash')
        : isGemini
          ? (process.env.GEMINI_SUMMARISATION_MODEL || process.env.GEMINI_MODEL_SUMMARISATION || process.env.LLM_MODEL_SUMMARISATION || 'gemini-3.6-flash')
          : (process.env.LLM_MODEL_SUMMARISATION || 'gpt-4o-mini')
  };

  return {
    aiEnabled,
    provider,
    defaultTimeoutMs,
    maxConcurrency,
    circuitBreakerThreshold,
    circuitBreakerResetMs,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    geminiBaseURL,
    openrouterApiKey,
    openrouterBaseURL,
    omnirouteApiKey,
    omnirouteBaseURL,
    taskModelMapping
  };
}

/**
 * Validates LLM configuration at boot time.
 * If AI is enabled and a non-mock provider is configured, fails at boot if the required API key is missing.
 * (AI-001 Requirement 7)
 */
export function validateLLMConfig(config = loadLLMConfig()): void {
  if (config.aiEnabled && config.provider !== 'mock') {
    if (config.provider === 'openai' && !config.openaiApiKey) {
      throw new LLMConfigurationError(
        'AI is enabled with LLM_PROVIDER=openai, but OPENAI_API_KEY is missing from environment.'
      );
    }
    if (config.provider === 'gemini' && !config.geminiApiKey) {
      throw new LLMConfigurationError(
        'AI is enabled with LLM_PROVIDER=gemini, but GEMINI_API_KEY is missing from environment.'
      );
    }
    if (config.provider === 'openrouter' && !config.openrouterApiKey) {
      throw new LLMConfigurationError(
        'AI is enabled with LLM_PROVIDER=openrouter, but OPENROUTER_API_KEY is missing from environment.'
      );
    }
    if (config.provider === 'omniroute' && !config.omnirouteApiKey) {
      throw new LLMConfigurationError(
        'AI is enabled with LLM_PROVIDER=omniroute, but OMNIROUTE_API_KEY is missing from environment.'
      );
    }
    if (config.provider === 'anthropic' && !config.anthropicApiKey) {
      throw new LLMConfigurationError(
        'AI is enabled with LLM_PROVIDER=anthropic, but ANTHROPIC_API_KEY is missing from environment.'
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Raw Provider Factory                                              */
/* ------------------------------------------------------------------ */

/**
 * Factory for creating raw LLM providers based on configuration.
 */
export function createRawLLMProvider(config = loadLLMConfig()): LLMProvider {
  switch (config.provider) {
    case 'mock':
      return new MockLLMProvider();
    case 'openai':
      if (!config.openaiApiKey || config.openaiApiKey.trim() === '') {
        throw new LLMConfigurationError(
          'OPENAI_API_KEY is required to initialize OpenAIProvider.'
        );
      }
      return new OpenAIProvider({
        apiKey: config.openaiApiKey,
        taskModelMapping: config.taskModelMapping
      });
    case 'gemini':
      if (!config.geminiApiKey || config.geminiApiKey.trim() === '') {
        throw new LLMConfigurationError(
          'GEMINI_API_KEY is required to initialize GeminiProvider.'
        );
      }
      return new GeminiProvider({
        apiKey: config.geminiApiKey,
        baseURL: config.geminiBaseURL,
        taskModelMapping: config.taskModelMapping
      });
    case 'openrouter':
      if (!config.openrouterApiKey || config.openrouterApiKey.trim() === '') {
        throw new LLMConfigurationError(
          'OPENROUTER_API_KEY is required to initialize OpenRouterGeminiProvider.'
        );
      }
      return new OpenRouterGeminiProvider({
        apiKey: config.openrouterApiKey,
        baseURL: config.openrouterBaseURL,
        taskModelMapping: config.taskModelMapping
      });
    case 'omniroute':
      if (!config.omnirouteApiKey || config.omnirouteApiKey.trim() === '') {
        throw new LLMConfigurationError(
          'OMNIROUTE_API_KEY is required to initialize OmniRouteProvider.'
        );
      }
      return new OmniRouteProvider({
        apiKey: config.omnirouteApiKey,
        baseURL: config.omnirouteBaseURL,
        taskModelMapping: config.taskModelMapping
      });
    case 'anthropic':
      throw new LLMConfigurationError(
        'Anthropic provider is not implemented yet. Use LLM_PROVIDER=mock, LLM_PROVIDER=openai, LLM_PROVIDER=gemini, LLM_PROVIDER=openrouter, or LLM_PROVIDER=omniroute.'
      );
    default:
      throw new LLMConfigurationError(
        `Unsupported LLM provider: '${config.provider}'. Supported providers are: 'mock', 'openai', 'gemini', 'openrouter', 'omniroute'.`
      );
  }
}

/* ------------------------------------------------------------------ */
/*  Orchestrated LLM Provider Wrapper                                 */
/* ------------------------------------------------------------------ */

export class OrchestratedLLMProvider implements LLMProvider {
  private readonly rawProvider: LLMProvider;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly concurrencyLimiter: ConcurrencyLimiter;
  private readonly config: LLMConfig;

  constructor(
    rawProvider?: LLMProvider,
    config?: LLMConfig,
    circuitBreaker?: CircuitBreaker,
    concurrencyLimiter?: ConcurrencyLimiter
  ) {
    this.config = config ?? loadLLMConfig();
    this.rawProvider = rawProvider ?? createRawLLMProvider(this.config);
    this.circuitBreaker =
      circuitBreaker ??
      new CircuitBreaker({
        failureThreshold: this.config.circuitBreakerThreshold,
        resetTimeoutMs: this.config.circuitBreakerResetMs
      });
    this.concurrencyLimiter =
      concurrencyLimiter ??
      new ConcurrencyLimiter({
        maxConcurrency: this.config.maxConcurrency
      });
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  public getConcurrencyLimiter(): ConcurrencyLimiter {
    return this.concurrencyLimiter;
  }

  public getRawProvider(): LLMProvider {
    return this.rawProvider;
  }

  /**
   * Executes a model completion request with task-based routing, hard timeout,
   * concurrency bounding, circuit breaking, retry on transient transport errors,
   * and invocation telemetry. (AI-001 Requirements 1–10)
   */
  public async complete(request: LLMRequest): Promise<LLMResponse> {
    const correlationId = request.correlationId || generateUlid();
    const timeoutMs = request.timeoutMs ?? this.config.defaultTimeoutMs;
    const modelId = this.config.taskModelMapping[request.task] || 'default-model';

    const childLogger = logger.child({
      correlationId,
      traceId: correlationId,
      task: request.task,
      modelId,
      merchantId: request.merchantId
    });

    const startTime = Date.now();

    // 1. Concurrency Limiter
    return this.concurrencyLimiter.execute(async () => {
      // 2. Circuit Breaker
      return this.circuitBreaker.execute(async () => {
        // 3. Retry on transient transport/429 errors only
        return executeWithRetry(
          async (attempt: number) => {
            if (attempt > 1) {
              childLogger.warn(
                { attempt, task: request.task },
                `[LLM] Retrying transient failure for task ${request.task} (Attempt ${attempt})`
              );
            }

            // 4. Hard Timeout Enforcement via Promise.race
            let timer: NodeJS.Timeout | null = null;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new LLMTimeoutError(timeoutMs));
              }, timeoutMs);
            });

            try {
              const response = await Promise.race([
                this.rawProvider.complete({
                  ...request,
                  timeoutMs,
                  correlationId
                }),
                timeoutPromise
              ]);

              const durationMs = Date.now() - startTime;

              childLogger.info(
                {
                  modelId: response.modelId,
                  promptVersion: response.promptVersion,
                  inputTokens: response.usage.inputTokens,
                  outputTokens: response.usage.outputTokens,
                  totalTokens: response.usage.totalTokens,
                  latencyMs: durationMs,
                  stopReason: response.stopReason,
                  providerRequestId: response.providerRequestId
                },
                `[LLM] Model invocation complete for task '${request.task}' in ${durationMs}ms (Tokens: ${response.usage.totalTokens})`
              );

              return response;
            } catch (err: unknown) {
              const durationMs = Date.now() - startTime;
              childLogger.error(
                {
                  err,
                  latencyMs: durationMs,
                  task: request.task,
                  attempt
                },
                `[LLM] Model invocation failed for task '${request.task}' after ${durationMs}ms`
              );
              throw err;
            } finally {
              if (timer) {
                clearTimeout(timer);
              }
            }
          },
          { maxRetries: 2, initialDelayMs: 100 }
        );
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton Factory Instance                                        */
/* ------------------------------------------------------------------ */

let defaultProviderInstance: OrchestratedLLMProvider | null = null;

export function getLLMProvider(): OrchestratedLLMProvider {
  if (!defaultProviderInstance) {
    const config = loadLLMConfig();
    const rawProvider = createRawLLMProvider(config);
    defaultProviderInstance = new OrchestratedLLMProvider(rawProvider, config);
  }
  return defaultProviderInstance;
}

export function setLLMProvider(provider: OrchestratedLLMProvider | null): void {
  defaultProviderInstance = provider;
}
