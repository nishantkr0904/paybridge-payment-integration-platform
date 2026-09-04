import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError
} from 'openai';
import {
  OpenAIProvider,
  createRawLLMProvider,
  getLLMProvider,
  setLLMProvider
} from '../../infrastructure/llm/index.js';
import {
  LLMConfigurationError,
  LLMError,
  LLMRequest
} from '../../infrastructure/llm/llm.types.js';
import { OrchestratedLLMProvider } from '../../infrastructure/llm/llm.provider.js';

describe('BT-B1: OpenAI Provider Adapter & Integration', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockOpenAIClient: OpenAI;
  let provider: OpenAIProvider;

  beforeEach(() => {
    mockCreate = vi.fn();
    mockOpenAIClient = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    } as unknown as OpenAI;

    provider = new OpenAIProvider({
      apiKey: 'sk-test-mock-key-1234567890',
      client: mockOpenAIClient,
      taskModelMapping: {
        diagnosis: 'gpt-4o-mini-test',
        decision: 'gpt-4o-test',
        summarisation: 'gpt-4o-mini-summary'
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLLMProvider(null);
  });

  describe('1. Request Construction & Message Translation', () => {
    it('constructs OpenAI messages array with user prompt when systemPrompt is omitted', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_001',
        model: 'gpt-4o-mini-test',
        choices: [
          {
            message: { content: 'Diagnosis analysis result' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 }
      });

      const request: LLMRequest = {
        task: 'diagnosis',
        prompt: 'Analyze payment failure for insufficient funds'
      };

      await provider.complete(request);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'Analyze payment failure for insufficient funds' }
      ]);
      expect(callArgs.temperature).toBe(0.1);
    });

    it('prepends systemPrompt as system message before user prompt when provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_002',
        model: 'gpt-4o-mini-test',
        choices: [
          {
            message: { content: '{"status":"ok"}' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 }
      });

      const request: LLMRequest = {
        task: 'diagnosis',
        systemPrompt: 'You are a payment diagnosis specialist.',
        prompt: 'Transaction failed with code 51'
      };

      await provider.complete(request);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: 'system', content: 'You are a payment diagnosis specialist.' },
        { role: 'user', content: 'Transaction failed with code 51' }
      ]);
    });

    it('passes custom temperature and maxTokens when specified', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_003',
        model: 'gpt-4o-test',
        choices: [{ message: { content: 'Plan output' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      });

      const request: LLMRequest = {
        task: 'decision',
        prompt: 'Select recovery playbook',
        temperature: 0.5,
        maxTokens: 500
      };

      await provider.complete(request);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.5);
      expect(callArgs.max_tokens).toBe(500);
    });

    it('sets response_format to json_object when prompt contains "json"', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_004',
        model: 'gpt-4o-mini-test',
        choices: [{ message: { content: '{"category":"INSUFFICIENT_FUNDS"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
      });

      const request: LLMRequest = {
        task: 'diagnosis',
        prompt: 'Return a structured JSON diagnosis for the case'
      };

      await provider.complete(request);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.response_format).toEqual({ type: 'json_object' });
    });

    it('sets response_format to json_object when schema is present in request', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_005',
        model: 'gpt-4o-mini-test',
        choices: [{ message: { content: '{"valid":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
      });

      const request: LLMRequest = {
        task: 'diagnosis',
        prompt: 'Output data',
        schema: { type: 'object', properties: { valid: { type: 'boolean' } } }
      };

      await provider.complete(request);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.response_format).toEqual({ type: 'json_object' });
    });

    it('does not set response_format when neither prompt mentions json nor schema is provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_006',
        model: 'gpt-4o-mini-test',
        choices: [{ message: { content: 'Brief summary of issue' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const request: LLMRequest = {
        task: 'summarisation',
        prompt: 'Provide a concise overview of what occurred'
      };

      await provider.complete(request);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.response_format).toBeUndefined();
    });

    it('throws 400 LLMError when prompt is missing or empty', async () => {
      await expect(
        provider.complete({ task: 'diagnosis', prompt: '' })
      ).rejects.toThrow(LLMError);
    });
  });

  describe('2. Task-Based Model Selection', () => {
    it('routes diagnosis task to configured diagnosis model', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_diag',
        model: 'gpt-4o-mini-test',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });

      await provider.complete({ task: 'diagnosis', prompt: 'test' });
      expect(mockCreate.mock.calls[0][0].model).toBe('gpt-4o-mini-test');
    });

    it('routes decision task to configured decision model', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_dec',
        model: 'gpt-4o-test',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });

      await provider.complete({ task: 'decision', prompt: 'test' });
      expect(mockCreate.mock.calls[0][0].model).toBe('gpt-4o-test');
    });

    it('routes summarisation task to configured summarisation model', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_sum',
        model: 'gpt-4o-mini-summary',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });

      await provider.complete({ task: 'summarisation', prompt: 'test' });
      expect(mockCreate.mock.calls[0][0].model).toBe('gpt-4o-mini-summary');
    });

    it('respects metadata.model override when provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_custom',
        model: 'custom-fine-tuned-model',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });

      await provider.complete({
        task: 'diagnosis',
        prompt: 'test',
        metadata: { model: 'custom-fine-tuned-model' }
      });

      expect(mockCreate.mock.calls[0][0].model).toBe('custom-fine-tuned-model');
    });
  });

  describe('3. Response-to-LLMResponse Mapping', () => {
    it('correctly maps successful OpenAI completion into canonical LLMResponse', async () => {
      const mockResult = {
        id: 'chatcmpl_full_001',
        model: 'gpt-4o-2024-08-06',
        choices: [
          {
            message: { content: '{"category":"AUTHENTICATION_FAILED","recoverable":true}' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 45,
          total_tokens: 165
        }
      };
      mockCreate.mockResolvedValueOnce(mockResult);

      const response = await provider.complete({
        task: 'diagnosis',
        prompt: 'Diagnose 3DS failure in JSON format',
        promptVersion: 'v2.0.0'
      });

      expect(response.content).toBe('{"category":"AUTHENTICATION_FAILED","recoverable":true}');
      expect(response.structuredData).toEqual({
        category: 'AUTHENTICATION_FAILED',
        recoverable: true
      });
      expect(response.modelId).toBe('gpt-4o-2024-08-06');
      expect(response.promptVersion).toBe('v2.0.0');
      expect(response.stopReason).toBe('stop');
      expect(response.providerRequestId).toBe('chatcmpl_full_001');
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
      expect(response.usage).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165
      });
    });

    it('sets structuredData to null when completion content is not valid JSON', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_text_002',
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'Non-JSON plain text explanation' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 }
      });

      const response = await provider.complete({
        task: 'diagnosis',
        prompt: 'Return a JSON diagnosis'
      });

      expect(response.content).toBe('Non-JSON plain text explanation');
      expect(response.structuredData).toBeNull();
    });

    it('handles missing usage object by defaulting token counts to 0', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_no_usage',
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'Result' }, finish_reason: 'stop' }],
        usage: undefined
      });

      const response = await provider.complete({
        task: 'diagnosis',
        prompt: 'Test prompt'
      });

      expect(response.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      });
    });
  });

  describe('4. Error Mapping & Redaction', () => {
    it('maps AuthenticationError (401) to non-transient LLMError without leaking API key', async () => {
      const authError = new AuthenticationError(
        401,
        { message: 'Incorrect API key provided: sk-test-mock-key-1234567890' },
        'Incorrect API key',
        new Headers()
      );
      mockCreate.mockRejectedValueOnce(authError);

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toMatchObject({
        name: 'LLMError',
        code: 'OPENAI_AUTH_ERROR',
        isTransient: false,
        statusCode: 401
      });

      try {
        await provider.complete({ task: 'diagnosis', prompt: 'test' });
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toContain('sk-test-mock-key-1234567890');
      }
    });

    it('maps RateLimitError (429) to transient LLMError', async () => {
      const rateLimitError = new RateLimitError(
        429,
        { message: 'Rate limit reached for requests' },
        'Rate limit reached',
        new Headers()
      );
      mockCreate.mockRejectedValueOnce(rateLimitError);

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toMatchObject({
        name: 'LLMError',
        code: 'OPENAI_RATE_LIMIT',
        isTransient: true,
        statusCode: 429
      });
    });

    it('maps BadRequestError (400) to non-transient LLMError', async () => {
      const badReqError = new BadRequestError(
        400,
        { message: 'Invalid model parameter' },
        'Invalid model parameter',
        new Headers()
      );
      mockCreate.mockRejectedValueOnce(badReqError);

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toMatchObject({
        name: 'LLMError',
        code: 'OPENAI_BAD_REQUEST',
        isTransient: false,
        statusCode: 400
      });
    });

    it('maps InternalServerError (500) to transient LLMProviderUnavailableError', async () => {
      const serverError = new InternalServerError(
        500,
        { message: 'OpenAI internal service error' },
        'Internal server error',
        new Headers()
      );
      mockCreate.mockRejectedValueOnce(serverError);

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toMatchObject({
        name: 'LLMProviderUnavailableError',
        isTransient: true,
        statusCode: 500
      });
    });

    it('maps APIConnectionTimeoutError to transient LLMTimeoutError', async () => {
      const timeoutError = new APIConnectionTimeoutError({ message: 'Request timed out' });
      mockCreate.mockRejectedValueOnce(timeoutError);

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test', timeoutMs: 5000 })
      ).rejects.toMatchObject({
        name: 'LLMTimeoutError',
        isTransient: true
      });
    });

    it('maps APIConnectionError to transient LLMProviderUnavailableError', async () => {
      const connError = new APIConnectionError({ message: 'Connection refused' });
      mockCreate.mockRejectedValueOnce(connError);

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toMatchObject({
        name: 'LLMProviderUnavailableError',
        isTransient: true
      });
    });

    it('sanitizes raw API key from generic APIError messages', async () => {
      const rawError = new APIError(
        403,
        { message: 'Access denied for token sk-test-mock-key-1234567890' },
        'Access denied',
        new Headers()
      );
      mockCreate.mockRejectedValueOnce(rawError);

      try {
        await provider.complete({ task: 'diagnosis', prompt: 'test' });
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toContain('sk-test-mock-key-1234567890');
        expect(error.message).toContain('[REDACTED_API_KEY]');
      }
    });
  });

  describe('5. Factory Routing & Configuration', () => {
    it('throws LLMConfigurationError when initialized without an API key', () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        expect(() => new OpenAIProvider()).toThrow(LLMConfigurationError);
        expect(() => new OpenAIProvider({ apiKey: '' })).toThrow(LLMConfigurationError);
      } finally {
        if (originalEnv) {
          process.env.OPENAI_API_KEY = originalEnv;
        }
      }
    });

    it('createRawLLMProvider returns MockLLMProvider when provider is "mock"', () => {
      const raw = createRawLLMProvider({
        aiEnabled: true,
        provider: 'mock',
        defaultTimeoutMs: 20000,
        maxConcurrency: 10,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 30000,
        taskModelMapping: {
          diagnosis: 'gpt-4o-mini',
          decision: 'gpt-4o',
          summarisation: 'gpt-4o-mini'
        }
      });

      expect(raw.constructor.name).toBe('MockLLMProvider');
    });

    it('createRawLLMProvider returns OpenAIProvider when provider is "openai" with API key', () => {
      const raw = createRawLLMProvider({
        aiEnabled: true,
        provider: 'openai',
        openaiApiKey: 'sk-test-valid-key',
        defaultTimeoutMs: 20000,
        maxConcurrency: 10,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 30000,
        taskModelMapping: {
          diagnosis: 'gpt-4o-mini',
          decision: 'gpt-4o',
          summarisation: 'gpt-4o-mini'
        }
      });

      expect(raw.constructor.name).toBe('OpenAIProvider');
    });

    it('createRawLLMProvider throws LLMConfigurationError when provider is "openai" without API key', () => {
      expect(() => {
        createRawLLMProvider({
          aiEnabled: true,
          provider: 'openai',
          openaiApiKey: undefined,
          defaultTimeoutMs: 20000,
          maxConcurrency: 10,
          circuitBreakerThreshold: 5,
          circuitBreakerResetMs: 30000,
          taskModelMapping: {
            diagnosis: 'gpt-4o-mini',
            decision: 'gpt-4o',
            summarisation: 'gpt-4o-mini'
          }
        });
      }).toThrow(LLMConfigurationError);
    });

    it('createRawLLMProvider throws LLMConfigurationError for unsupported provider type', () => {
      expect(() => {
        createRawLLMProvider({
          aiEnabled: true,
          provider: 'unsupported-provider' as never,
          defaultTimeoutMs: 20000,
          maxConcurrency: 10,
          circuitBreakerThreshold: 5,
          circuitBreakerResetMs: 30000,
          taskModelMapping: {
            diagnosis: 'gpt-4o-mini',
            decision: 'gpt-4o',
            summarisation: 'gpt-4o-mini'
          }
        });
      }).toThrow(LLMConfigurationError);
    });

    it('getLLMProvider instantiates OpenAIProvider when LLM_PROVIDER=openai and OPENAI_API_KEY is present', () => {
      const oldProvider = process.env.LLM_PROVIDER;
      const oldKey = process.env.OPENAI_API_KEY;

      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test-singleton-key';

      try {
        setLLMProvider(null);
        const orchestrated = getLLMProvider();
        expect(orchestrated.getRawProvider().constructor.name).toBe('OpenAIProvider');
      } finally {
        if (oldProvider) process.env.LLM_PROVIDER = oldProvider;
        else delete process.env.LLM_PROVIDER;

        if (oldKey) process.env.OPENAI_API_KEY = oldKey;
        else delete process.env.OPENAI_API_KEY;

        setLLMProvider(null);
      }
    });

    it('getLLMProvider defaults to MockLLMProvider when LLM_PROVIDER is unset or "mock"', () => {
      const oldProvider = process.env.LLM_PROVIDER;
      delete process.env.LLM_PROVIDER;

      try {
        setLLMProvider(null);
        const orchestrated = getLLMProvider();
        expect(orchestrated.getRawProvider().constructor.name).toBe('MockLLMProvider');
      } finally {
        if (oldProvider) process.env.LLM_PROVIDER = oldProvider;
        setLLMProvider(null);
      }
    });
  });

  describe('6. Orchestration Layer Preservation (Circuit Breaker & Retry with OpenAIProvider)', () => {
    it('retries transient 429 error and succeeds through OrchestratedLLMProvider wrapper', async () => {
      let attempts = 0;
      mockCreate.mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          throw new RateLimitError(429, { message: 'Rate limit' }, 'Rate limit', new Headers());
        }
        return {
          id: 'chatcmpl_retry_success',
          model: 'gpt-4o-mini-test',
          choices: [{ message: { content: 'Success on attempt 2' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        };
      });

      const orchestrated = new OrchestratedLLMProvider(provider, {
        aiEnabled: true,
        provider: 'openai',
        defaultTimeoutMs: 2000,
        maxConcurrency: 5,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        taskModelMapping: {
          diagnosis: 'gpt-4o-mini-test',
          decision: 'gpt-4o-test',
          summarisation: 'gpt-4o-mini-summary'
        }
      });

      const response = await orchestrated.complete({
        task: 'diagnosis',
        prompt: 'Retry test with OpenAIProvider'
      });

      expect(attempts).toBe(2);
      expect(response.content).toBe('Success on attempt 2');
    });

    it('fails fast on 401 Unauthorized without retrying', async () => {
      let attempts = 0;
      mockCreate.mockImplementation(async () => {
        attempts++;
        throw new AuthenticationError(401, { message: 'Invalid key' }, 'Invalid key', new Headers());
      });

      const orchestrated = new OrchestratedLLMProvider(provider, {
        aiEnabled: true,
        provider: 'openai',
        defaultTimeoutMs: 2000,
        maxConcurrency: 5,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        taskModelMapping: {
          diagnosis: 'gpt-4o-mini-test',
          decision: 'gpt-4o-test',
          summarisation: 'gpt-4o-mini-summary'
        }
      });

      await expect(
        orchestrated.complete({ task: 'diagnosis', prompt: 'Auth failure test' })
      ).rejects.toMatchObject({
        code: 'OPENAI_AUTH_ERROR'
      });

      expect(attempts).toBe(1);
    });

    it('trips circuit breaker after consecutive OpenAI provider 500 errors', async () => {
      mockCreate.mockRejectedValue(
        new InternalServerError(500, { message: 'Internal server error' }, '500 error', new Headers())
      );

      const orchestrated = new OrchestratedLLMProvider(provider, {
        aiEnabled: true,
        provider: 'openai',
        defaultTimeoutMs: 2000,
        maxConcurrency: 5,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        taskModelMapping: {
          diagnosis: 'gpt-4o-mini-test',
          decision: 'gpt-4o-test',
          summarisation: 'gpt-4o-mini-summary'
        }
      });

      const cb = orchestrated.getCircuitBreaker();
      expect(cb.getState()).toBe('CLOSED');

      // Trigger 3 failures
      for (let i = 0; i < 3; i++) {
        await expect(
          orchestrated.complete({ task: 'diagnosis', prompt: 'test' })
        ).rejects.toThrow();
      }

      expect(cb.getState()).toBe('OPEN');

      // Next call fast-fails with LLMCircuitOpenError without calling mockCreate
      const callCountBefore = mockCreate.mock.calls.length;
      await expect(
        orchestrated.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toThrow(/circuit breaker is OPEN/);
      expect(mockCreate.mock.calls.length).toBe(callCountBefore);
    });
  });

  describe('7. Deterministic Zero Outbound Network Requests Guarantee', () => {
    it('executes completely via mock boundary with zero outbound HTTP calls via fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_mock_no_net',
        model: 'gpt-4o-mini-test',
        choices: [{ message: { content: '{"status":"ok"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
      });

      const response = await provider.complete({
        task: 'diagnosis',
        prompt: 'Return json diagnosis'
      });

      expect(response.content).toBe('{"status":"ok"}');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  8. Opt-In Real OpenAI Integration Smoke Test                      */
  /* ------------------------------------------------------------------ */
  describe('8. Opt-In Real OpenAI Integration Smoke Test', () => {
    const shouldRunSmokeTest = Boolean(
      process.env.RUN_OPENAI_SMOKE_TEST === 'true' &&
      process.env.OPENAI_API_KEY &&
      process.env.OPENAI_API_KEY.trim() !== ''
    );

    it.runIf(shouldRunSmokeTest)(
      'executes live call against OpenAI API and returns valid LLMResponse contract',
      async () => {
        const liveProvider = new OpenAIProvider({
          apiKey: process.env.OPENAI_API_KEY
        });

        const response = await liveProvider.complete({
          task: 'diagnosis',
          prompt: 'Respond with a short JSON object: {"status": "ok", "provider": "openai"}'
        });

        expect(response).toBeDefined();
        expect(typeof response.content).toBe('string');
        expect(response.content.length).toBeGreaterThan(0);
        expect(response.modelId).toBeDefined();
        expect(response.usage.totalTokens).toBeGreaterThan(0);
        expect(response.usage.inputTokens).toBeGreaterThan(0);
        expect(response.usage.outputTokens).toBeGreaterThan(0);
        expect(response.latencyMs).toBeGreaterThan(0);
        expect(response.providerRequestId).toBeDefined();
        // Never log or assert API key
      },
      30000 // 30s timeout for live API call
    );
  });
});
