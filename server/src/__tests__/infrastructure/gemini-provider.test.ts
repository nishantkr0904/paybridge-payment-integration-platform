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
  GeminiProvider,
  DEFAULT_GEMINI_BASE_URL
} from '../../infrastructure/llm/gemini-provider.js';
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

describe('Gemini Provider Adapter & OpenAI-Compatible Integration', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockOpenAIClient: OpenAI;
  let provider: GeminiProvider;

  beforeEach(() => {
    mockCreate = vi.fn();
    mockOpenAIClient = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    } as unknown as OpenAI;

    provider = new GeminiProvider({
      apiKey: 'AIzaSyTestMockKey1234567890abcdef',
      client: mockOpenAIClient,
      taskModelMapping: {
        diagnosis: 'gemini-1.5-flash-test',
        decision: 'gemini-1.5-pro-test',
        summarisation: 'gemini-1.5-flash-summary'
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLLMProvider(null);
  });

  describe('1. Endpoint, Base URL & Model Configuration', () => {
    it('uses the standard Google AI Studio OpenAI-compatible base URL by default', () => {
      const defaultProvider = new GeminiProvider({
        apiKey: 'AIzaSyTestMockKey1234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getBaseURL()).toBe(DEFAULT_GEMINI_BASE_URL);
      expect(defaultProvider.getBaseURL()).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
    });

    it('allows overriding base URL via constructor options', () => {
      const customProvider = new GeminiProvider({
        apiKey: 'AIzaSyTestMockKey1234567890abcdef',
        client: mockOpenAIClient,
        baseURL: 'https://custom-gateway.test/v1/openai/'
      });

      expect(customProvider.getBaseURL()).toBe('https://custom-gateway.test/v1/openai/');
    });

    it('uses default Gemini model names when taskModelMapping is not supplied', () => {
      const defaultProvider = new GeminiProvider({
        apiKey: 'AIzaSyTestMockKey1234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getTaskModel('diagnosis')).toBe('gemini-3.6-flash');
      expect(defaultProvider.getTaskModel('decision')).toBe('gemini-3.1-pro-preview');
      expect(defaultProvider.getTaskModel('summarisation')).toBe('gemini-3.6-flash');
    });

    it('applies custom task model mapping when supplied', () => {
      expect(provider.getTaskModel('diagnosis')).toBe('gemini-1.5-flash-test');
      expect(provider.getTaskModel('decision')).toBe('gemini-1.5-pro-test');
      expect(provider.getTaskModel('summarisation')).toBe('gemini-1.5-flash-summary');
    });
  });

  describe('2. Request Construction & Message Translation', () => {
    it('constructs messages array with user prompt when systemPrompt is omitted', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_gemini_001',
        model: 'gemini-1.5-flash-test',
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
      expect(callArgs.model).toBe('gemini-1.5-flash-test');
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'Analyze payment failure for insufficient funds' }
      ]);
      expect(callArgs.temperature).toBe(0.1);
    });

    it('prepends systemPrompt as system message before user prompt when provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_gemini_002',
        model: 'gemini-1.5-flash-test',
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
        systemPrompt: 'You are an autonomous payment recovery specialist.',
        prompt: 'Customer abandoned checkout at details_entered'
      };

      await provider.complete(request);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: 'system', content: 'You are an autonomous payment recovery specialist.' },
        { role: 'user', content: 'Customer abandoned checkout at details_entered' }
      ]);
    });

    it('enforces JSON mode (response_format: { type: "json_object" }) when schema is provided or json is mentioned', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_gemini_003',
        model: 'gemini-1.5-pro-test',
        choices: [
          {
            message: { content: '{"category":"CUSTOMER_ABANDONED","recoverable":true}' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 }
      });

      const request: LLMRequest = {
        task: 'decision',
        prompt: 'Formulate recovery plan in JSON format',
        schema: { type: 'object' }
      };

      const response = await provider.complete(request);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.response_format).toEqual({ type: 'json_object' });
      expect(response.structuredData).toEqual({
        category: 'CUSTOMER_ABANDONED',
        recoverable: true
      });
    });

    it('passes custom maxTokens and temperature overrides when provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_gemini_004',
        model: 'gemini-1.5-flash-test',
        choices: [
          {
            message: { content: 'Short diagnosis' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      await provider.complete({
        task: 'diagnosis',
        prompt: 'Quick diagnose',
        temperature: 0.2,
        maxTokens: 150
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.2);
      expect(callArgs.max_tokens).toBe(150);
    });
  });

  describe('3. Response Normalization Contract', () => {
    it('normalizes OpenAI-compatible Gemini completion into LLMResponse contract', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'chatcmpl_gemini_resp_001',
        model: 'gemini-1.5-flash',
        choices: [
          {
            message: { content: '{"actionType":"CUSTOMER_OUTREACH"}' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 45,
          total_tokens: 165
        }
      });

      const response = await provider.complete({
        task: 'decision',
        prompt: 'Output decision JSON',
        schema: { type: 'object' }
      });

      expect(response.content).toBe('{"actionType":"CUSTOMER_OUTREACH"}');
      expect(response.structuredData).toEqual({ actionType: 'CUSTOMER_OUTREACH' });
      expect(response.modelId).toBe('gemini-1.5-flash');
      expect(response.promptVersion).toBe('v1.0.0');
      expect(response.usage).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165
      });
      expect(response.stopReason).toBe('stop');
      expect(response.providerRequestId).toBe('chatcmpl_gemini_resp_001');
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('4. Error Mapping & Safe Failure Handling', () => {
    it('maps AuthenticationError into GEMINI_AUTH_ERROR (HTTP 401)', async () => {
      mockCreate.mockRejectedValueOnce(
        new AuthenticationError(401, { message: 'Invalid API key provided' }, 'Invalid API key', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('GEMINI_AUTH_ERROR');
        expect(llmErr.isTransient).toBe(false);
        expect(llmErr.statusCode).toBe(401);
        expect(llmErr.message).toContain('Gemini authentication failed');
        return true;
      });
    });

    it('maps RateLimitError into transient GEMINI_RATE_LIMIT (HTTP 429)', async () => {
      mockCreate.mockRejectedValueOnce(
        new RateLimitError(429, { message: 'Quota exceeded for model' }, 'Rate limit exceeded', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('GEMINI_RATE_LIMIT');
        expect(llmErr.isTransient).toBe(true);
        expect(llmErr.statusCode).toBe(429);
        return true;
      });
    });

    it('maps BadRequestError into non-transient GEMINI_BAD_REQUEST (HTTP 400)', async () => {
      mockCreate.mockRejectedValueOnce(
        new BadRequestError(400, { message: 'Invalid request payload' }, 'Bad Request', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('GEMINI_BAD_REQUEST');
        expect(llmErr.isTransient).toBe(false);
        expect(llmErr.statusCode).toBe(400);
        return true;
      });
    });

    it('maps InternalServerError into LLMProviderUnavailableError', async () => {
      mockCreate.mockRejectedValueOnce(
        new InternalServerError(500, { message: 'Internal service error' }, 'Server error', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMProviderUnavailableError);
        const llmErr = err as LLMProviderUnavailableError;
        expect(llmErr.code).toBe('LLM_PROVIDER_UNAVAILABLE');
        expect(llmErr.isTransient).toBe(true);
        return true;
      });
    });

    it('maps APIConnectionTimeoutError into LLMTimeoutError', async () => {
      mockCreate.mockRejectedValueOnce(
        new APIConnectionTimeoutError({ message: 'Request timed out' })
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test', timeoutMs: 5000 })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMTimeoutError);
        const llmErr = err as LLMTimeoutError;
        expect(llmErr.code).toBe('LLM_TIMEOUT');
        expect(llmErr.isTransient).toBe(true);
        return true;
      });
    });

    it('maps APIConnectionError into LLMProviderUnavailableError', async () => {
      mockCreate.mockRejectedValueOnce(
        new APIConnectionError({ message: 'Connection refused to generativelanguage.googleapis.com' })
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMProviderUnavailableError);
        const llmErr = err as LLMProviderUnavailableError;
        expect(llmErr.code).toBe('LLM_PROVIDER_UNAVAILABLE');
        expect(llmErr.isTransient).toBe(true);
        return true;
      });
    });

    it('maps generic APIError with 503 status to transient GEMINI_API_ERROR', async () => {
      mockCreate.mockRejectedValueOnce(
        new APIError(503, { message: 'Service Unavailable' }, '503 Service Unavailable', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('GEMINI_API_ERROR');
        expect(llmErr.isTransient).toBe(true);
        expect(llmErr.statusCode).toBe(503);
        return true;
      });
    });
  });

  describe('5. Zero Credential Leakage & Sanitization', () => {
    it('sanitizes Gemini API key from error messages and logs', async () => {
      const secretGeminiKey = 'AIzaSySuperSecretLiveGeminiKey9876543210';
      const secretProvider = new GeminiProvider({
        apiKey: secretGeminiKey,
        client: {
          chat: {
            completions: {
              create: vi.fn().mockRejectedValue(
                new Error(`Authentication failed for key ${secretGeminiKey} at endpoint`)
              )
            }
          }
        } as unknown as OpenAI
      });

      await expect(
        secretProvider.complete({ task: 'diagnosis', prompt: 'test prompt' })
      ).rejects.toSatisfy((err: Error) => {
        expect(err.message).not.toContain(secretGeminiKey);
        expect(err.message).toContain('[REDACTED_API_KEY]');
        return true;
      });
    });

    it('sanitizes OpenAI-style keys if accidentally present in error text', async () => {
      const secretProvider = new GeminiProvider({
        apiKey: 'AIzaSyTestKey1234567890',
        client: {
          chat: {
            completions: {
              create: vi.fn().mockRejectedValue(
                new Error('Upstream error mentioning sk-1234567890abcdef1234567890')
              )
            }
          }
        } as unknown as OpenAI
      });

      await expect(
        secretProvider.complete({ task: 'diagnosis', prompt: 'test prompt' })
      ).rejects.toSatisfy((err: Error) => {
        expect(err.message).not.toContain('sk-1234567890abcdef1234567890');
        expect(err.message).toContain('[REDACTED_API_KEY]');
        return true;
      });
    });
  });

  describe('6. Factory Integration & Boot Validation', () => {
    it('throws LLMConfigurationError when initialized without GEMINI_API_KEY', () => {
      const originalEnv = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        expect(() => new GeminiProvider()).toThrow(LLMConfigurationError);
        expect(() => new GeminiProvider()).toThrow(/GEMINI_API_KEY is required/i);
      } finally {
        if (originalEnv) process.env.GEMINI_API_KEY = originalEnv;
      }
    });

    it('creates GeminiProvider via createRawLLMProvider when provider is gemini', () => {
      const p = createRawLLMProvider({
        aiEnabled: true,
        provider: 'gemini',
        geminiApiKey: 'AIzaSyFactoryKeyTest1234567890',
        defaultTimeoutMs: 20000,
        maxConcurrency: 5,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        taskModelMapping: {
          diagnosis: 'gemini-3.6-flash',
          decision: 'gemini-3.1-pro-preview',
          summarisation: 'gemini-3.6-flash'
        }
      });

      expect(p).toBeInstanceOf(GeminiProvider);
    });

    it('fails validateLLMConfig at boot when provider is gemini and GEMINI_API_KEY is missing', () => {
      expect(() => {
        validateLLMConfig({
          aiEnabled: true,
          provider: 'gemini',
          defaultTimeoutMs: 20000,
          maxConcurrency: 5,
          circuitBreakerThreshold: 3,
          circuitBreakerResetMs: 1000,
          taskModelMapping: {
            diagnosis: 'gemini-3.6-flash',
            decision: 'gemini-3.1-pro-preview',
            summarisation: 'gemini-3.6-flash'
          }
        });
      }).toThrow(LLMConfigurationError);
    });

    it('passes validateLLMConfig at boot when provider is gemini and GEMINI_API_KEY is present', () => {
      expect(() => {
        validateLLMConfig({
          aiEnabled: true,
          provider: 'gemini',
          geminiApiKey: 'AIzaSyTestValidBootKey12345',
          defaultTimeoutMs: 20000,
          maxConcurrency: 5,
          circuitBreakerThreshold: 3,
          circuitBreakerResetMs: 1000,
          taskModelMapping: {
            diagnosis: 'gemini-3.6-flash',
            decision: 'gemini-3.1-pro-preview',
            summarisation: 'gemini-3.6-flash'
          }
        });
      }).not.toThrow();
    });
  });
});
