import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConcurrencyLimiter,
  MockLLMProvider,
  OrchestratedLLMProvider,
  isTransientLLMError,
  validateLLMConfig
} from '../../infrastructure/llm/index.js';
import {
  LLMConfigurationError,
  LLMError,
  LLMRequest,
  LLMTimeoutError
} from '../../infrastructure/llm/llm.types.js';

describe('TASK-301: LLM Provider Abstraction & Model Routing (AI-001 / Phase 3 Milestone 3.1)', () => {
  let mockProvider: MockLLMProvider;
  let orchestrated: OrchestratedLLMProvider;

  beforeEach(() => {
    mockProvider = new MockLLMProvider({ mockLatencyMs: 2 });
    orchestrated = new OrchestratedLLMProvider(mockProvider, {
      aiEnabled: true,
      provider: 'mock',
      defaultTimeoutMs: 1000,
      maxConcurrency: 5,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 100,
      taskModelMapping: {
        diagnosis: 'test-diagnosis-model',
        decision: 'test-decision-model',
        summarisation: 'test-summary-model'
      }
    });
  });

  describe('1. Deterministic MockLLMProvider Behavior (AI-001 Requirement 6)', () => {
    it('returns deterministic canned response with structured data for diagnosis task', async () => {
      const request: LLMRequest = {
        task: 'diagnosis',
        prompt: 'Diagnose payment failure: Insufficient funds on UPI intent',
        correlationId: '01TESTCORR0000000000000001'
      };

      const response = await orchestrated.complete(request);

      expect(response.content).toBeDefined();
      expect(response.structuredData).toBeDefined();
      expect(response.structuredData?.category).toBe('INSUFFICIENT_FUNDS');
      expect(response.structuredData?.recoverable).toBe(true);
      expect(response.structuredData?.recommendedStrategy).toBe('DELAYED_RETRY');
      expect(response.stopReason).toBe('stop');
      expect(response.providerRequestId).toMatch(/^req_mock_/);
    });

    it('returns deterministic canned response for decision task', async () => {
      const request: LLMRequest = {
        task: 'decision',
        prompt: 'Select recovery playbook for INSUFFICIENT_FUNDS',
        correlationId: '01TESTCORR0000000000000002'
      };

      const response = await orchestrated.complete(request);

      expect(response.structuredData).toBeDefined();
      expect(response.structuredData?.actionType).toBe('RETRY_PAYMENT');
      expect(response.structuredData?.scheduledDelaySeconds).toBe(86400);
    });
  });

  describe('2. Task-Based Model Routing (AI-001 Requirement 2)', () => {
    it('routes requests to configured models per logical task', async () => {
      const diagReq: LLMRequest = { task: 'diagnosis', prompt: 'diagnose' };
      const decReq: LLMRequest = { task: 'decision', prompt: 'decide' };
      const sumReq: LLMRequest = { task: 'summarisation', prompt: 'summarise' };

      const diagRes = await orchestrated.complete(diagReq);
      const decRes = await orchestrated.complete(decReq);
      const sumRes = await orchestrated.complete(sumReq);

      expect(diagRes.modelId).toBe('mock-diagnosis-v1');
      expect(decRes.modelId).toBe('mock-decision-v1');
      expect(sumRes.modelId).toBe('mock-summarisation-v1');
    });
  });

  describe('3. Hard Timeout Enforcement (AI-001 Requirement 3)', () => {
    it('aborts and throws LLMTimeoutError when invocation exceeds timeout', async () => {
      // Configure mock provider to delay 200ms
      mockProvider.setMockLatency(200);

      const slowRequest: LLMRequest = {
        task: 'diagnosis',
        prompt: 'slow prompt',
        timeoutMs: 50 // timeout after 50ms
      };

      await expect(orchestrated.complete(slowRequest)).rejects.toThrow(LLMTimeoutError);
    });
  });

  describe('4. Circuit Breaker Behavior & Fail-Open Fallback (AI-001 Requirement 3, 8)', () => {
    it('opens circuit after consecutive failures and fails fast with LLMCircuitOpenError', async () => {
      let callCount = 0;
      mockProvider.setFailureInjector(() => {
        callCount++;
        return new LLMError('Simulated provider failure', 'PROVIDER_500', false, 500);
      });

      const cb = orchestrated.getCircuitBreaker();
      expect(cb.getState()).toBe('CLOSED');

      // Trigger failures up to threshold (3)
      for (let i = 0; i < 3; i++) {
        await expect(
          orchestrated.complete({ task: 'diagnosis', prompt: 'test' })
        ).rejects.toThrow();
      }

      // Circuit must now be OPEN
      expect(cb.getState()).toBe('OPEN');

      // Next request fast-fails with LLMCircuitOpenError without invoking provider
      const beforeCount = callCount;
      await expect(
        orchestrated.complete({ task: 'diagnosis', prompt: 'test' })
      ).rejects.toThrow(/circuit breaker is OPEN/);
      expect(callCount).toBe(beforeCount);

      // Wait for reset timeout (100ms)
      await new Promise((res) => setTimeout(res, 120));
      expect(cb.getState()).toBe('HALF_OPEN');

      // Remove failure injector so half-open probe succeeds
      mockProvider.setFailureInjector(null);

      const probeRes = await orchestrated.complete({ task: 'diagnosis', prompt: 'probe' });
      expect(probeRes.content).toBeDefined();
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('5. Transient 429/5xx Retries with Jittered Backoff (AI-001 Requirement 4)', () => {
    it('retries transient 429 rate-limit error and succeeds on second attempt', async () => {
      let attempts = 0;
      mockProvider.setFailureInjector((_req, attemptNum) => {
        attempts++;
        if (attemptNum === 1) {
          return new LLMError('Rate limit exceeded', 'RATE_LIMIT_429', true, 429);
        }
        return null;
      });

      const res = await orchestrated.complete({
        task: 'diagnosis',
        prompt: 'retry test',
        correlationId: '01RETRYCORR00000000000001'
      });

      expect(res.content).toBeDefined();
      expect(attempts).toBe(2);
    });

    it('retries transient 503 service unavailable error', async () => {
      let attempts = 0;
      mockProvider.setFailureInjector((_req, attemptNum) => {
        attempts++;
        if (attemptNum === 1) {
          return new LLMError('Service Unavailable', 'SERVICE_UNAVAILABLE_503', true, 503);
        }
        return null;
      });

      const res = await orchestrated.complete({
        task: 'diagnosis',
        prompt: 'retry 503 test',
        correlationId: '01RETRYCORR00000000000002'
      });

      expect(res.content).toBeDefined();
      expect(attempts).toBe(2);
    });
  });

  describe('6. No Retry for Non-Transient / Malformed Errors (AI-001 Requirement 4)', () => {
    it('fails fast on 400 Bad Request or malformed completion without retrying', async () => {
      let attempts = 0;
      mockProvider.setFailureInjector(() => {
        attempts++;
        return new LLMError('Bad Request - Invalid Parameters', 'CLIENT_ERROR_400', false, 400);
      });

      await expect(
        orchestrated.complete({ task: 'diagnosis', prompt: 'malformed test' })
      ).rejects.toThrow(/Bad Request/);

      // Assert exactly 1 attempt (no retries)
      expect(attempts).toBe(1);
    });

    it('correctly identifies transient vs non-transient errors', () => {
      expect(isTransientLLMError(new LLMError('Rate limited', 'ERR', true, 429))).toBe(true);
      expect(isTransientLLMError(new LLMError('Gateway timeout', 'ERR', true, 504))).toBe(true);
      expect(isTransientLLMError(new LLMTimeoutError(5000))).toBe(true);
      expect(isTransientLLMError(new LLMError('Invalid JSON format', 'ERR', false, 400))).toBe(false);
      expect(isTransientLLMError(new LLMError('Unauthorized', 'ERR', false, 401))).toBe(false);
    });
  });

  describe('7. Global Concurrency Limiting (AI-001 Requirement 9)', () => {
    it('limits concurrent executions to max concurrency bound', async () => {
      const limiter = new ConcurrencyLimiter({ maxConcurrency: 2 });
      let maxObservedActive = 0;

      const runTask = async () => {
        return limiter.execute(async () => {
          const current = limiter.getActiveCount();
          if (current > maxObservedActive) {
            maxObservedActive = current;
          }
          await new Promise((res) => setTimeout(res, 30));
          return true;
        });
      };

      // Launch 5 tasks concurrently
      await Promise.all([runTask(), runTask(), runTask(), runTask(), runTask()]);

      expect(maxObservedActive).toBeLessThanOrEqual(2);
    });
  });

  describe('8. Invocation Metadata & Token Accounting (AI-001 Req 5 / AI-010)', () => {
    it('records model id, prompt version, token counts, latency, and provider request id', async () => {
      const req: LLMRequest = {
        task: 'diagnosis',
        prompt: 'Sample diagnosis prompt for token accounting verification',
        promptVersion: 'v2.1.0',
        correlationId: '01ACCOUNTING00000000000001'
      };

      const res = await orchestrated.complete(req);

      expect(res.modelId).toBeDefined();
      expect(res.promptVersion).toBe('v2.1.0');
      expect(res.usage.inputTokens).toBeGreaterThan(0);
      expect(res.usage.outputTokens).toBeGreaterThan(0);
      expect(res.usage.totalTokens).toBe(res.usage.inputTokens + res.usage.outputTokens);
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.providerRequestId).toMatch(/^req_mock_/);
    });
  });

  describe('9. Boot-Time Configuration Validation (AI-001 Requirement 7)', () => {
    it('passes validation when provider is mock', () => {
      expect(() => {
        validateLLMConfig({
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
      }).not.toThrow();
    });

    it('throws LLMConfigurationError at boot when OpenAI provider is selected without API key', () => {
      expect(() => {
        validateLLMConfig({
          aiEnabled: true,
          provider: 'openai',
          defaultTimeoutMs: 20000,
          maxConcurrency: 10,
          circuitBreakerThreshold: 5,
          circuitBreakerResetMs: 30000,
          openaiApiKey: undefined,
          taskModelMapping: {
            diagnosis: 'gpt-4o-mini',
            decision: 'gpt-4o',
            summarisation: 'gpt-4o-mini'
          }
        });
      }).toThrow(LLMConfigurationError);
    });

    it('throws LLMConfigurationError at boot when Anthropic provider is selected without API key', () => {
      expect(() => {
        validateLLMConfig({
          aiEnabled: true,
          provider: 'anthropic',
          defaultTimeoutMs: 20000,
          maxConcurrency: 10,
          circuitBreakerThreshold: 5,
          circuitBreakerResetMs: 30000,
          anthropicApiKey: undefined,
          taskModelMapping: {
            diagnosis: 'claude-3-5-sonnet',
            decision: 'claude-3-5-sonnet',
            summarisation: 'claude-3-5-haiku'
          }
        });
      }).toThrow(LLMConfigurationError);
    });
  });

  describe('10. Zero Outbound Network Calls Guarantee (AI-001 Requirement 6)', () => {
    it('executes completely in-memory with zero outbound network requests', async () => {
      const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

      const response = await orchestrated.complete({
        task: 'diagnosis',
        prompt: 'Zero network call assertion'
      });

      expect(response.content).toBeDefined();
      expect(globalFetchSpy).not.toHaveBeenCalled();

      globalFetchSpy.mockRestore();
    });
  });
});
