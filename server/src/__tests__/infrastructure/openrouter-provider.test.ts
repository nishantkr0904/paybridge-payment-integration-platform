import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import {
  OpenRouterGeminiProvider,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_TASK_MAX_TOKENS
} from '../../infrastructure/llm/openrouter-gemini-provider.js';
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

describe('OpenRouter Gemini Provider Adapter & OpenAI-Compatible Integration', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockOpenAIClient: OpenAI;
  let provider: OpenRouterGeminiProvider;

  beforeEach(() => {
    mockCreate = vi.fn();
    mockOpenAIClient = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    } as unknown as OpenAI;

    provider = new OpenRouterGeminiProvider({
      apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
      client: mockOpenAIClient,
      taskModelMapping: {
        diagnosis: 'google/gemini-3.6-flash-test',
        decision: 'google/gemini-3.1-pro-preview-test',
        summarisation: 'google/gemini-3.6-flash-summary'
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLLMProvider(null);
  });

  describe('1. Endpoint, Base URL & Model Configuration', () => {
    it('uses the standard OpenRouter base URL by default', () => {
      const defaultProvider = new OpenRouterGeminiProvider({
        apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getBaseURL()).toBe(DEFAULT_OPENROUTER_BASE_URL);
      expect(defaultProvider.getBaseURL()).toBe('https://openrouter.ai/api/v1');
    });

    it('allows overriding base URL via constructor options', () => {
      const customProvider = new OpenRouterGeminiProvider({
        apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
        client: mockOpenAIClient,
        baseURL: 'https://custom-openrouter-proxy.test/v1'
      });

      expect(customProvider.getBaseURL()).toBe('https://custom-openrouter-proxy.test/v1');
    });

    it('uses default OpenRouter Gemini model names when taskModelMapping is not supplied', () => {
      const defaultProvider = new OpenRouterGeminiProvider({
        apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getTaskModel('diagnosis')).toBe('google/gemini-3.6-flash');
      expect(defaultProvider.getTaskModel('decision')).toBe('google/gemini-3.1-pro-preview');
      expect(defaultProvider.getTaskModel('summarisation')).toBe('google/gemini-3.6-flash');
    });

    it('applies custom task model mapping when supplied', () => {
      expect(provider.getTaskModel('diagnosis')).toBe('google/gemini-3.6-flash-test');
      expect(provider.getTaskModel('decision')).toBe('google/gemini-3.1-pro-preview-test');
      expect(provider.getTaskModel('summarisation')).toBe('google/gemini-3.6-flash-summary');
    });

    it('defaults task max tokens to 1600 for diagnosis, 1600 for decision, and 800 for summarisation', () => {
      const defaultProvider = new OpenRouterGeminiProvider({
        apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
        client: mockOpenAIClient
      });

      expect(defaultProvider.getTaskMaxTokens('diagnosis')).toBe(DEFAULT_OPENROUTER_TASK_MAX_TOKENS.diagnosis);
      expect(defaultProvider.getTaskMaxTokens('diagnosis')).toBe(1600);
      expect(defaultProvider.getTaskMaxTokens('decision')).toBe(DEFAULT_OPENROUTER_TASK_MAX_TOKENS.decision);
      expect(defaultProvider.getTaskMaxTokens('decision')).toBe(1600);
      expect(defaultProvider.getTaskMaxTokens('summarisation')).toBe(DEFAULT_OPENROUTER_TASK_MAX_TOKENS.summarisation);
      expect(defaultProvider.getTaskMaxTokens('summarisation')).toBe(800);
    });

    it('applies constructor taskMaxTokens overrides when supplied', () => {
      const customProvider = new OpenRouterGeminiProvider({
        apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
        client: mockOpenAIClient,
        taskMaxTokens: {
          diagnosis: 1500,
          decision: 2000,
          summarisation: 600
        }
      });

      expect(customProvider.getTaskMaxTokens('diagnosis')).toBe(1500);
      expect(customProvider.getTaskMaxTokens('decision')).toBe(2000);
      expect(customProvider.getTaskMaxTokens('summarisation')).toBe(600);
    });

    it('respects environment variable overrides for task max tokens', () => {
      process.env.OPENROUTER_DIAGNOSIS_MAX_TOKENS = '1200';
      process.env.OPENROUTER_DECISION_MAX_TOKENS = '1500';

      try {
        const p = new OpenRouterGeminiProvider({
          apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
          client: mockOpenAIClient
        });

        expect(p.getTaskMaxTokens('diagnosis')).toBe(1200);
        expect(p.getTaskMaxTokens('decision')).toBe(1500);
        expect(p.getTaskMaxTokens('summarisation')).toBe(800);
      } finally {
        delete process.env.OPENROUTER_DIAGNOSIS_MAX_TOKENS;
        delete process.env.OPENROUTER_DECISION_MAX_TOKENS;
      }
    });

    it('respects general OPENROUTER_MAX_TOKENS environment variable override', () => {
      process.env.OPENROUTER_MAX_TOKENS = '900';

      try {
        const p = new OpenRouterGeminiProvider({
          apiKey: 'sk-or-v1-testmockkey1234567890abcdef',
          client: mockOpenAIClient
        });

        expect(p.getTaskMaxTokens('diagnosis')).toBe(900);
        expect(p.getTaskMaxTokens('decision')).toBe(900);
        expect(p.getTaskMaxTokens('summarisation')).toBe(900);
      } finally {
        delete process.env.OPENROUTER_MAX_TOKENS;
      }
    });
  });

  describe('2. Request Construction & Message Translation', () => {
    it('constructs messages array with user prompt when systemPrompt is omitted', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-001',
        model: 'google/gemini-3.6-flash-test',
        choices: [
          {
            message: { content: 'Diagnosis analysis result' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 }
      });

      const request: LLMRequest = {
        task: 'diagnosis',
        prompt: 'Analyze payment failure for insufficient funds'
      };

      await provider.complete(request);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe('google/gemini-3.6-flash-test');
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'Analyze payment failure for insufficient funds' }
      ]);
      expect(callArgs.temperature).toBe(0.1);
      expect(callArgs.max_tokens).toBe(1600);
    });

    it('prepends systemPrompt as system message before user prompt when provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-002',
        model: 'google/gemini-3.6-flash-test',
        choices: [
          {
            message: { content: '{"status":"ok"}' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 35, completion_tokens: 8, total_tokens: 43 }
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
      expect(callArgs.max_tokens).toBe(1600);
    });

    it('enforces JSON mode (response_format: { type: "json_object" }) when schema is provided or json is mentioned', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-003',
        model: 'google/gemini-3.1-pro-preview-test',
        choices: [
          {
            message: { content: '{"category":"CUSTOMER_ABANDONED","recoverable":true}' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 45, completion_tokens: 18, total_tokens: 63 }
      });

      const request: LLMRequest = {
        task: 'decision',
        prompt: 'Formulate recovery plan in JSON format',
        schema: { type: 'object' }
      };

      const response = await provider.complete(request);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.response_format).toEqual({ type: 'json_object' });
      expect(callArgs.max_tokens).toBe(1600);
      expect(response.structuredData).toEqual({
        category: 'CUSTOMER_ABANDONED',
        recoverable: true
      });
    });

    it('sets max_tokens to 800 for summarisation task when request.maxTokens is omitted', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-sum-001',
        model: 'google/gemini-3.6-flash-summary',
        choices: [
          {
            message: { content: 'Case summarized successfully' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
      });

      await provider.complete({
        task: 'summarisation',
        prompt: 'Summarize recovery case'
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_tokens).toBe(800);
    });

    it('passes custom maxTokens and temperature overrides when provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-004',
        model: 'google/gemini-3.6-flash-test',
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
        temperature: 0.25,
        maxTokens: 200
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.25);
      expect(callArgs.max_tokens).toBe(200);
    });

    it('uses metadata.model if provided', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-005',
        model: 'google/gemini-custom',
        choices: [
          {
            message: { content: 'Custom model response' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      await provider.complete({
        task: 'diagnosis',
        prompt: 'Custom model test',
        metadata: { model: 'google/gemini-custom' }
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe('google/gemini-custom');
    });

    it('throws LLMError if prompt is missing or empty', async () => {
      await expect(
        provider.complete({ task: 'diagnosis', prompt: '' })
      ).rejects.toThrow(LLMError);
    });
  });

  describe('3. Response Normalization Contract', () => {
    it('normalizes OpenAI-compatible OpenRouter completion into LLMResponse contract', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-resp-001',
        model: 'google/gemini-3.6-flash',
        choices: [
          {
            message: { content: '{"actionType":"CUSTOMER_OUTREACH"}' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 140,
          completion_tokens: 50,
          total_tokens: 190
        }
      });

      const response = await provider.complete({
        task: 'decision',
        prompt: 'Output decision JSON',
        schema: { type: 'object' }
      });

      expect(response.content).toBe('{"actionType":"CUSTOMER_OUTREACH"}');
      expect(response.structuredData).toEqual({ actionType: 'CUSTOMER_OUTREACH' });
      expect(response.modelId).toBe('google/gemini-3.6-flash');
      expect(response.promptVersion).toBe('v1.0.0');
      expect(response.usage).toEqual({
        inputTokens: 140,
        outputTokens: 50,
        totalTokens: 190
      });
      expect(response.stopReason).toBe('stop');
      expect(response.providerRequestId).toBe('gen-openrouter-resp-001');
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('handles unparseable structured data gracefully', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-resp-002',
        model: 'google/gemini-3.6-flash',
        choices: [
          {
            message: { content: 'not-valid-json' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });

      const response = await provider.complete({
        task: 'decision',
        prompt: 'Output JSON',
        schema: { type: 'object' }
      });

      expect(response.content).toBe('not-valid-json');
      expect(response.structuredData).toBeNull();
    });

    it('proves 1600-token output limit is sufficient for complete valid diagnosis JSON output', async () => {
      const fullDiagnosisOutput = {
        category: 'CUSTOMER_ABANDONED',
        reasonCode: 'CHECKOUT_TIMEOUT_DWELL',
        rootCause: 'Customer abandoned checkout session after entering personal details with no further interaction',
        contributingFactors: [
          'High dwell time on payment selection step (>180s)',
          'No prior payment attempt registered at gateway',
          'Mobile browser session with high abandonment propensity'
        ],
        recoverable: true,
        recommendedStrategy: 'CUSTOMER_OUTREACH',
        confidence: 0.94,
        explanation: 'The customer completed shipping and contact information but stalled at the payment method selection screen. Inactivity timeout triggered after 15 minutes. Dispatching a targeted recovery link with instant payment options is recommended.',
        evidence: [
          'dwell_time_seconds: 180',
          'last_stage: details_entered',
          'cart_value_inr: 500'
        ]
      };

      const jsonStr = JSON.stringify(fullDiagnosisOutput);
      expect(jsonStr.length).toBeLessThan(6400); // 6400 chars ≈ 1600 tokens

      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-diag-valid-001',
        model: 'google/gemini-3.6-flash',
        choices: [
          {
            message: { content: jsonStr },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 250, completion_tokens: 180, total_tokens: 430 }
      });

      const response = await provider.complete({
        task: 'diagnosis',
        prompt: 'Diagnose case',
        schema: { type: 'object' }
      });

      expect(response.usage.outputTokens).toBeLessThanOrEqual(1600);
      const parsed = DiagnosisRawOutputSchema.safeParse(response.structuredData);
      expect(parsed.success).toBe(true);
    });

    it('proves 1600-token output limit is sufficient for complete valid decision JSON output with 3 actions', async () => {
      const fullDecisionOutput = {
        planRationale: 'Formulate multi-stage autonomous recovery playbook: immediate customer recovery link, followed by incentive offering if unopened, and final merchant notification.',
        actions: [
          {
            actionType: 'CUSTOMER_OUTREACH',
            toolName: 'send_recovery_link',
            scheduledDelaySeconds: 900,
            costMinorUnits: 0,
            incentivePercent: 0,
            rationale: 'Send instant recovery link via WhatsApp and SMS to prompt customer to resume session',
            parameters: { channel: 'whatsapp_sms' }
          },
          {
            actionType: 'OFFER_INCENTIVE',
            toolName: 'apply_recovery_incentive',
            scheduledDelaySeconds: 7200,
            costMinorUnits: 2500,
            incentivePercent: 5,
            rationale: 'Provide 5% completion discount if recovery link has not been converted within 2 hours',
            parameters: { discountPercent: 5 }
          },
          {
            actionType: 'ESCALATE_TO_SUPPORT',
            toolName: 'escalate_to_human_operator',
            scheduledDelaySeconds: 86400,
            costMinorUnits: 0,
            incentivePercent: 0,
            rationale: 'Escalate to merchant recovery queue if high-value cart remains unconverted after 24 hours',
            parameters: { queue: 'high_value_abandonment' }
          }
        ],
        costOrderingRespect: true
      };

      const jsonStr = JSON.stringify(fullDecisionOutput);
      expect(jsonStr.length).toBeLessThan(6400); // 6400 chars ≈ 1600 tokens

      mockCreate.mockResolvedValueOnce({
        id: 'gen-openrouter-dec-valid-001',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            message: { content: jsonStr },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 380, completion_tokens: 220, total_tokens: 600 }
      });

      const response = await provider.complete({
        task: 'decision',
        prompt: 'Formulate recovery plan',
        schema: { type: 'object' }
      });

      expect(response.usage.outputTokens).toBeLessThanOrEqual(1600);
      const parsed = DecisionRawOutputSchema.safeParse(response.structuredData);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.actions).toHaveLength(3);
      }
    });
  });

  describe('4. Error Mapping & Safe Failure Handling', () => {
    it('maps AuthenticationError into OPENROUTER_AUTH_ERROR (HTTP 401)', async () => {
      mockCreate.mockRejectedValueOnce(
        new AuthenticationError(401, { message: 'Invalid API key provided' }, 'Invalid API key', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('OPENROUTER_AUTH_ERROR');
        expect(llmErr.isTransient).toBe(false);
        expect(llmErr.statusCode).toBe(401);
        expect(llmErr.message).toContain('OpenRouter authentication failed');
        return true;
      });
    });

    it('maps RateLimitError into transient OPENROUTER_RATE_LIMIT (HTTP 429)', async () => {
      mockCreate.mockRejectedValueOnce(
        new RateLimitError(429, { message: 'Rate limit exceeded' }, 'Rate limit exceeded', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('OPENROUTER_RATE_LIMIT');
        expect(llmErr.isTransient).toBe(true);
        expect(llmErr.statusCode).toBe(429);
        return true;
      });
    });

    it('maps BadRequestError into non-transient OPENROUTER_BAD_REQUEST (HTTP 400)', async () => {
      mockCreate.mockRejectedValueOnce(
        new BadRequestError(400, { message: 'Invalid payload' }, 'Bad Request', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('OPENROUTER_BAD_REQUEST');
        expect(llmErr.isTransient).toBe(false);
        expect(llmErr.statusCode).toBe(400);
        return true;
      });
    });

    it('maps InternalServerError into LLMProviderUnavailableError', async () => {
      mockCreate.mockRejectedValueOnce(
        new InternalServerError(500, { message: 'OpenRouter internal error' }, 'Server error', new Headers())
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
        new APIConnectionError({ message: 'Connection refused to openrouter.ai' })
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

    it('maps APIUserAbortError into OPENROUTER_ABORTED', async () => {
      mockCreate.mockRejectedValueOnce(
        new APIUserAbortError({ message: 'User aborted' })
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('OPENROUTER_ABORTED');
        expect(llmErr.isTransient).toBe(false);
        expect(llmErr.statusCode).toBe(499);
        return true;
      });
    });

    it('maps generic APIError with 502 status to transient OPENROUTER_API_ERROR', async () => {
      mockCreate.mockRejectedValueOnce(
        new APIError(502, { message: 'Bad Gateway' }, '502 Bad Gateway', new Headers())
      );

      await expect(
        provider.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(LLMError);
        const llmErr = err as LLMError;
        expect(llmErr.code).toBe('OPENROUTER_API_ERROR');
        expect(llmErr.isTransient).toBe(true);
        expect(llmErr.statusCode).toBe(502);
        return true;
      });
    });
  });

  describe('5. Zero Credential Leakage & Sanitization', () => {
    it('sanitizes OpenRouter API key from error messages and logs', async () => {
      const secretKey = 'sk-or-v1-secretkeytest1234567890abcdef12345';
      const secretProvider = new OpenRouterGeminiProvider({
        apiKey: secretKey,
        client: {
          chat: {
            completions: {
              create: vi.fn().mockRejectedValue(
                new Error(`Authentication failed for key ${secretKey} at endpoint`)
              )
            }
          }
        } as unknown as OpenAI
      });

      await expect(
        secretProvider.complete({ task: 'diagnosis', prompt: 'test prompt' })
      ).rejects.toSatisfy((err: Error) => {
        expect(err.message).not.toContain(secretKey);
        expect(err.message).toContain('[REDACTED_API_KEY]');
        return true;
      });
    });

    it('sanitizes standard OpenAI and Gemini keys if present in error text', async () => {
      const secretProvider = new OpenRouterGeminiProvider({
        apiKey: 'sk-or-v1-validkey1234567890',
        client: {
          chat: {
            completions: {
              create: vi.fn().mockRejectedValue(
                new Error('Upstream error with sk-1234567890abcdef1234567890 and AIzaSy1234567890abcdef12345')
              )
            }
          }
        } as unknown as OpenAI
      });

      await expect(
        secretProvider.complete({ task: 'diagnosis', prompt: 'test prompt' })
      ).rejects.toSatisfy((err: Error) => {
        expect(err.message).not.toContain('sk-1234567890abcdef1234567890');
        expect(err.message).not.toContain('AIzaSy1234567890abcdef12345');
        expect(err.message).toContain('[REDACTED_API_KEY]');
        return true;
      });
    });
  });

  describe('6. Factory Integration & Boot Validation', () => {
    it('throws LLMConfigurationError when initialized without OPENROUTER_API_KEY', () => {
      const originalEnv = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;

      try {
        expect(() => new OpenRouterGeminiProvider()).toThrow(LLMConfigurationError);
        expect(() => new OpenRouterGeminiProvider()).toThrow(/OPENROUTER_API_KEY is required/i);
      } finally {
        if (originalEnv) process.env.OPENROUTER_API_KEY = originalEnv;
      }
    });

    it('creates OpenRouterGeminiProvider via createRawLLMProvider when provider is openrouter', () => {
      const p = createRawLLMProvider({
        aiEnabled: true,
        provider: 'openrouter',
        openrouterApiKey: 'sk-or-v1-factorykeytest1234567890',
        defaultTimeoutMs: 20000,
        maxConcurrency: 5,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
        taskModelMapping: {
          diagnosis: 'google/gemini-3.6-flash',
          decision: 'google/gemini-3.1-pro-preview',
          summarisation: 'google/gemini-3.6-flash'
        }
      });

      expect(p).toBeInstanceOf(OpenRouterGeminiProvider);
    });

    it('fails validateLLMConfig at boot when provider is openrouter and OPENROUTER_API_KEY is missing', () => {
      expect(() => {
        validateLLMConfig({
          aiEnabled: true,
          provider: 'openrouter',
          defaultTimeoutMs: 20000,
          maxConcurrency: 5,
          circuitBreakerThreshold: 3,
          circuitBreakerResetMs: 1000,
          taskModelMapping: {
            diagnosis: 'google/gemini-3.6-flash',
            decision: 'google/gemini-3.1-pro-preview',
            summarisation: 'google/gemini-3.6-flash'
          }
        });
      }).toThrow(LLMConfigurationError);
    });

    it('passes validateLLMConfig at boot when provider is openrouter and OPENROUTER_API_KEY is present', () => {
      expect(() => {
        validateLLMConfig({
          aiEnabled: true,
          provider: 'openrouter',
          openrouterApiKey: 'sk-or-v1-validbootkey12345',
          defaultTimeoutMs: 20000,
          maxConcurrency: 5,
          circuitBreakerThreshold: 3,
          circuitBreakerResetMs: 1000,
          taskModelMapping: {
            diagnosis: 'google/gemini-3.6-flash',
            decision: 'google/gemini-3.1-pro-preview',
            summarisation: 'google/gemini-3.6-flash'
          }
        });
      }).not.toThrow();
    });
  });
});
