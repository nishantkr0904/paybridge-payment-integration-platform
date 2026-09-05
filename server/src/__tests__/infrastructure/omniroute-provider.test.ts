import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError
} from 'openai';
import {
  OmniRouteProvider,
  DEFAULT_OMNIROUTE_BASE_URL
} from '../../infrastructure/llm/omniroute-provider.js';
import {
  createRawLLMProvider,
  validateLLMConfig,
  setLLMProvider
} from '../../infrastructure/llm/llm.provider.js';
import {
  LLMConfigurationError,
  LLMError,
  LLMRequest,
  LLMTimeoutError,
  LLMProviderUnavailableError
} from '../../infrastructure/llm/llm.types.js';
import { DiagnosisRawOutputSchema } from '../../modules/ai/diagnosis/diagnosis.types.js';
import { DecisionRawOutputSchema } from '../../modules/ai/decision/decision.types.js';

describe('OmniRoute Provider Adapter & Local OpenAI-Compatible Gateway Integration', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockOpenAIClient: OpenAI;
  let provider: OmniRouteProvider;

  beforeEach(() => {
    mockCreate = vi.fn();
    mockOpenAIClient = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    } as unknown as OpenAI;

    provider = new OmniRouteProvider({
      apiKey: 'sk-d4c1f343e01234567890abcdef',
      client: mockOpenAIClient,
      taskModelMapping: {
        diagnosis: 'antigravity/gemini-3.6-flash-low-test',
        decision: 'antigravity/gemini-3.1-pro-low-test',
        summarisation: 'antigravity/gemini-3.6-flash-low-summary'
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLLMProvider(null);
  });

  describe('1. Endpoint, Base URL & Model Configuration', () => {
    it('uses the standard OmniRoute base URL by default', () => {
      const defaultProvider = new OmniRouteProvider({
        apiKey: 'sk-d4c1f343e01234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getBaseURL()).toBe(DEFAULT_OMNIROUTE_BASE_URL);
      expect(defaultProvider.getBaseURL()).toBe('http://localhost:20128/v1');
    });

    it('allows overriding base URL via constructor options', () => {
      const customProvider = new OmniRouteProvider({
        apiKey: 'sk-d4c1f343e01234567890abcdef',
        client: mockOpenAIClient,
        baseURL: 'http://127.0.0.1:20128/v1'
      });

      expect(customProvider.getBaseURL()).toBe('http://127.0.0.1:20128/v1');
    });

    it('uses default OmniRoute model names when taskModelMapping is not supplied', () => {
      const defaultProvider = new OmniRouteProvider({
        apiKey: 'sk-d4c1f343e01234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getTaskModel('diagnosis')).toBe('antigravity/gemini-3.6-flash-low');
      expect(defaultProvider.getTaskModel('decision')).toBe('antigravity/gemini-3.1-pro-low');
      expect(defaultProvider.getTaskModel('summarisation')).toBe('antigravity/gemini-3.6-flash-low');
    });

    it('applies custom task model mapping when supplied', () => {
      expect(provider.getTaskModel('diagnosis')).toBe('antigravity/gemini-3.6-flash-low-test');
      expect(provider.getTaskModel('decision')).toBe('antigravity/gemini-3.1-pro-low-test');
      expect(provider.getTaskModel('summarisation')).toBe('antigravity/gemini-3.6-flash-low-summary');
    });

    it('respects task-specific environment variable overrides', () => {
      const origDiag = process.env.OMNIROUTE_DIAGNOSIS_MODEL;
      const origDec = process.env.OMNIROUTE_DECISION_MODEL;
      try {
        process.env.OMNIROUTE_DIAGNOSIS_MODEL = 'github/gpt-4o-mini';
        process.env.OMNIROUTE_DECISION_MODEL = 'github/gpt-4o';

        expect(provider.getTaskModel('diagnosis')).toBe('github/gpt-4o-mini');
        expect(provider.getTaskModel('decision')).toBe('github/gpt-4o');
      } finally {
        if (origDiag !== undefined) process.env.OMNIROUTE_DIAGNOSIS_MODEL = origDiag;
        else delete process.env.OMNIROUTE_DIAGNOSIS_MODEL;
        if (origDec !== undefined) process.env.OMNIROUTE_DECISION_MODEL = origDec;
        else delete process.env.OMNIROUTE_DECISION_MODEL;
      }
    });
  });

  describe('2. Request Translation & Execution (OpenAI-Compatible Format)', () => {
    it('translates LLMRequest into OpenAI Chat Completion with stream: false and correct messages', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-omniroute-001',
        model: 'antigravity/gemini-3.6-flash-low',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '{"status": "ok"}'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 25,
          completion_tokens: 10,
          total_tokens: 35
        }
      });

      const request: LLMRequest = {
        task: 'diagnosis',
        prompt: 'Diagnose the failure payload',
        systemPrompt: 'You are a diagnostic specialist. Return JSON.',
        temperature: 0.2,
        correlationId: '01TESTOMNICORR00000000001'
      };

      const response = await provider.complete(request);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];

      // CRITICAL: stream MUST be false for OmniRoute
      expect(callArgs.stream).toBe(false);
      expect(callArgs.model).toBe('antigravity/gemini-3.6-flash-low-test');
      expect(callArgs.temperature).toBe(0.2);
      expect(callArgs.messages).toEqual([
        { role: 'system', content: 'You are a diagnostic specialist. Return JSON.' },
        { role: 'user', content: 'Diagnose the failure payload' }
      ]);
      expect(callArgs.response_format).toEqual({ type: 'json_object' });

      // Verify response formatting
      expect(response.content).toBe('{"status": "ok"}');
      expect(response.structuredData).toEqual({ status: 'ok' });
      expect(response.modelId).toBe('antigravity/gemini-3.6-flash-low');
      expect(response.usage.inputTokens).toBe(25);
      expect(response.usage.outputTokens).toBe(10);
      expect(response.usage.totalTokens).toBe(35);
      expect(response.stopReason).toBe('stop');
      expect(response.providerRequestId).toBe('chatcmpl-omniroute-001');
    });

    it('strips markdown code fences when parsing structuredData', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-omniroute-fence',
        model: 'antigravity/gemini-3.1-pro-low',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '```json\n{"planRationale": "Test plan", "actions": []}\n```'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 20,
          total_tokens: 50
        }
      });

      const response = await provider.complete({
        task: 'decision',
        prompt: 'Generate plan in JSON format'
      });

      expect(response.structuredData).toEqual({
        planRationale: 'Test plan',
        actions: []
      });
    });

    it('throws LLMError when prompt is missing or empty', async () => {
      await expect(
        provider.complete({ task: 'diagnosis', prompt: '' })
      ).rejects.toThrow(LLMError);
    });
  });

  describe('3. Token Budget Limits', () => {
    it('uses standard default task token limits', () => {
      const defaultProvider = new OmniRouteProvider({
        apiKey: 'sk-d4c1f343e01234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getTaskMaxTokens('diagnosis')).toBe(1600);
      expect(defaultProvider.getTaskMaxTokens('decision')).toBe(1600);
      expect(defaultProvider.getTaskMaxTokens('summarisation')).toBe(800);
    });

    it('passes effectiveMaxTokens in chat completion create params', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl-omniroute-tokens',
        model: 'antigravity/gemini-3.6-flash-low',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      await provider.complete({
        task: 'diagnosis',
        prompt: 'test prompt'
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_tokens).toBe(1600);
    });
  });

  describe('4. Credential Redaction & Security Invariants', () => {
    it('sanitizes API keys from error messages thrown during invocation', async () => {
      const secretKey = 'sk-d4c1f343e-super-secret-key-do-not-leak';
      const leakProvider = new OmniRouteProvider({
        apiKey: secretKey,
        client: {
          chat: {
            completions: {
              create: vi.fn().mockRejectedValue(
                new Error(`Authentication failed with key ${secretKey}`)
              )
            }
          }
        } as unknown as OpenAI
      });

      await expect(
        leakProvider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: Error) => {
        expect(err.message).not.toContain(secretKey);
        expect(err.message).toContain('[REDACTED_API_KEY]');
        return true;
      });
    });

    it('sanitizes ANTHROPIC_AUTH_TOKEN if present in environment', async () => {
      const orig = process.env.ANTHROPIC_AUTH_TOKEN;
      try {
        process.env.ANTHROPIC_AUTH_TOKEN = 'sk-d4c1f343e-env-token-123456789';
        const leakProvider = new OmniRouteProvider({
          apiKey: 'other-key',
          client: {
            chat: {
              completions: {
                create: vi.fn().mockRejectedValue(
                  new Error(`Failure mentioning token: sk-d4c1f343e-env-token-123456789`)
                )
              }
            }
          } as unknown as OpenAI
        });

        await expect(
          leakProvider.complete({ task: 'diagnosis', prompt: 'test' })
        ).rejects.toSatisfy((err: Error) => {
          expect(err.message).not.toContain('sk-d4c1f343e-env-token-123456789');
          expect(err.message).toContain('[REDACTED_API_KEY]');
          return true;
        });
      } finally {
        if (orig !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = orig;
        else delete process.env.ANTHROPIC_AUTH_TOKEN;
      }
    });
  });

  describe('5. Error Mapping Hierarchy', () => {
    it('maps AuthenticationError to LLMError with code OMNIROUTE_AUTH_ERROR (401)', async () => {
      mockCreate.mockRejectedValueOnce(
        new AuthenticationError(401, { error: { message: 'Invalid API key' } }, 'Invalid API key', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: LLMError) => {
        expect(err.code).toBe('OMNIROUTE_AUTH_ERROR');
        expect(err.statusCode).toBe(401);
        expect(err.isTransient).toBe(false);
        return true;
      });
    });

    it('maps RateLimitError to LLMError with code OMNIROUTE_RATE_LIMIT (429, transient)', async () => {
      mockCreate.mockRejectedValueOnce(
        new RateLimitError(429, { error: { message: 'Rate limit exceeded' } }, 'Rate limit', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: LLMError) => {
        expect(err.code).toBe('OMNIROUTE_RATE_LIMIT');
        expect(err.statusCode).toBe(429);
        expect(err.isTransient).toBe(true);
        return true;
      });
    });

    it('maps APIConnectionError to LLMProviderUnavailableError (503, transient)', async () => {
      mockCreate.mockRejectedValueOnce(
        new APIConnectionError({ message: 'Connection refused to port 20128' })
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: LLMError) => {
        expect(err).toBeInstanceOf(LLMProviderUnavailableError);
        expect(err.statusCode).toBe(503);
        expect(err.isTransient).toBe(true);
        return true;
      });
    });

    it('maps APIConnectionTimeoutError to LLMTimeoutError (transient)', async () => {
      mockCreate.mockRejectedValueOnce(
        new APIConnectionTimeoutError({ message: 'Request timed out' })
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test', timeoutMs: 5000 })
      ).rejects.toSatisfy((err: LLMError) => {
        expect(err).toBeInstanceOf(LLMTimeoutError);
        expect(err.code).toBe('LLM_TIMEOUT');
        expect(err.isTransient).toBe(true);
        return true;
      });
    });
  });

  describe('6. Provider Factory & Configuration Validation', () => {
    it('throws LLMConfigurationError when OMNIROUTE_API_KEY is missing at boot validation', () => {
      expect(() => {
        validateLLMConfig({
          aiEnabled: true,
          provider: 'omniroute',
          defaultTimeoutMs: 20000,
          maxConcurrency: 10,
          circuitBreakerThreshold: 5,
          circuitBreakerResetMs: 30000,
          omnirouteApiKey: undefined,
          taskModelMapping: {
            diagnosis: 'antigravity/gemini-3.6-flash-low',
            decision: 'antigravity/gemini-3.1-pro-low',
            summarisation: 'antigravity/gemini-3.6-flash-low'
          }
        });
      }).toThrow(LLMConfigurationError);
    });

    it('creates OmniRouteProvider via createRawLLMProvider when configured', () => {
      const raw = createRawLLMProvider({
        aiEnabled: true,
        provider: 'omniroute',
        defaultTimeoutMs: 20000,
        maxConcurrency: 10,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 30000,
        omnirouteApiKey: 'sk-d4c1f343e-test-key-factory',
        taskModelMapping: {
          diagnosis: 'antigravity/gemini-3.6-flash-low',
          decision: 'antigravity/gemini-3.1-pro-low',
          summarisation: 'antigravity/gemini-3.6-flash-low'
        }
      });

      expect(raw).toBeInstanceOf(OmniRouteProvider);
    });
  });

  describe('7. Schema Adequacy for Diagnosis and Decision JSON', () => {
    it('validates a complete DiagnosisRawOutputSchema successfully', () => {
      const sampleDiagnosis = {
        category: 'CUSTOMER_ABANDONED',
        reasonCode: 'CHECKOUT_DROP_OFF',
        rootCause: 'User abandoned checkout during payment details stage',
        contributingFactors: ['High transaction value', 'Dwell time > 600s'],
        recoverable: true,
        recommendedStrategy: 'CUSTOMER_OUTREACH',
        confidence: 0.94,
        explanation: 'Customer remained idle at payment step before closing tab.',
        evidence: ['dwell_time_seconds: 600', 'stage: details_entered']
      };

      const result = DiagnosisRawOutputSchema.safeParse(sampleDiagnosis);
      expect(result.success).toBe(true);
    });

    it('validates a complete DecisionRawOutputSchema successfully', () => {
      const sampleDecision = {
        planRationale: 'Automated outreach recovery link with high-intent recovery strategy',
        actions: [
          {
            actionType: 'CUSTOMER_OUTREACH',
            toolName: 'send_recovery_link',
            scheduledDelaySeconds: 1800,
            costMinorUnits: 0,
            incentivePercent: 0,
            rationale: 'Email recovery link with preserved cart state',
            parameters: { channel: 'email' }
          }
        ],
        costOrderingRespect: true
      };

      const result = DecisionRawOutputSchema.safeParse(sampleDecision);
      expect(result.success).toBe(true);
    });
  });
});
