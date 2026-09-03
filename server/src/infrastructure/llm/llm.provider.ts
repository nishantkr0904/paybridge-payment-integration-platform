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
  taskModelMapping: Record<LLMTask, string>;
}

export function loadLLMConfig(): LLMConfig {
  const aiEnabled = process.env.AI_ENABLED === 'true';
  const provider = (process.env.LLM_PROVIDER as LLMProviderType) || 'mock';
  const defaultTimeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 20000;
  const maxConcurrency = Number(process.env.LLM_MAX_CONCURRENCY) || 10;
  const circuitBreakerThreshold = Number(process.env.LLM_CIRCUIT_BREAKER_THRESHOLD) || 5;
  const circuitBreakerResetMs = Number(process.env.LLM_CIRCUIT_BREAKER_RESET_MS) || 30000;

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  const taskModelMapping: Record<LLMTask, string> = {
    diagnosis: process.env.LLM_MODEL_DIAGNOSIS || 'gpt-4o-mini',
    decision: process.env.LLM_MODEL_DECISION || 'gpt-4o',
    summarisation: process.env.LLM_MODEL_SUMMARISATION || 'gpt-4o-mini'
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
    if (config.provider === 'anthropic' && !config.anthropicApiKey) {
      throw new LLMConfigurationError(
        'AI is enabled with LLM_PROVIDER=anthropic, but ANTHROPIC_API_KEY is missing from environment.'
      );
    }
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
    this.rawProvider = rawProvider ?? new MockLLMProvider();
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
    const rawProvider = new MockLLMProvider();
    defaultProviderInstance = new OrchestratedLLMProvider(rawProvider, config);
  }
  return defaultProviderInstance;
}

export function setLLMProvider(provider: OrchestratedLLMProvider | null): void {
  defaultProviderInstance = provider;
}
