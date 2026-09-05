import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { pool } from '../../config/database.js';
import {
  runRealLLMDemo,
  resolveDemoProvider,
  formatDemoOutput,
  ObservingLLMProviderWrapper,
  type RealLLMDemoResult
} from '../../demo/real-llm-demo.js';
import { LLMConfigurationError } from '../../infrastructure/llm/llm.types.js';
import { MockLLMProvider } from '../../infrastructure/llm/mock-provider.js';
import { OpenAIProvider } from '../../infrastructure/llm/openai-provider.js';

describe('E1: Real LLM Demonstration Scenario & Deterministic Safety', () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Ensure DB connection is ready
    const conn = await pool.getConnection();
    conn.release();
  });

  afterAll(async () => {
    process.env = { ...originalEnv };
  });

  describe('1. Provider Resolution & Mode Selection (AI-001 / E1 Mode Gates)', () => {
    it('selects MockLLMProvider in deterministic mode without requiring an API key', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.LLM_PROVIDER;

      const { provider, providerName, models } = resolveDemoProvider('deterministic');

      expect(provider).toBeInstanceOf(ObservingLLMProviderWrapper);
      expect(providerName).toContain('MockLLMProvider');
      expect(models.diagnosis).toBeDefined();
      expect(models.decision).toBeDefined();
    });

    it('refuses real OpenAI mode when OPENAI_API_KEY is missing from environment', () => {
      delete process.env.OPENAI_API_KEY;

      expect(() => {
        resolveDemoProvider('openai');
      }).toThrow(LLMConfigurationError);

      expect(() => {
        resolveDemoProvider('openai');
      }).toThrow(/OPENAI_API_KEY is required/i);
    });

    it('refuses real OpenAI mode when OPENAI_API_KEY is empty whitespace', () => {
      process.env.OPENAI_API_KEY = '   ';

      expect(() => {
        resolveDemoProvider('openai');
      }).toThrow(LLMConfigurationError);
    });

    it('correctly selects OpenAIProvider through the provider factory when configured with an API key', () => {
      process.env.OPENAI_API_KEY = 'sk-mock-test-key-for-provider-factory-unit-test';
      process.env.LLM_MODEL_DIAGNOSIS = 'gpt-4o-mini-custom';
      process.env.LLM_MODEL_DECISION = 'gpt-4o-custom';

      try {
        const { provider, providerName, models } = resolveDemoProvider('openai');

        expect(provider).toBeInstanceOf(ObservingLLMProviderWrapper);
        expect(providerName).toContain('OpenAIProvider');
        expect(models.diagnosis).toBe('gpt-4o-mini-custom');
        expect(models.decision).toBe('gpt-4o-custom');
      } finally {
        delete process.env.OPENAI_API_KEY;
        delete process.env.LLM_MODEL_DIAGNOSIS;
        delete process.env.LLM_MODEL_DECISION;
      }
    });

    it('refuses real Gemini mode when GEMINI_API_KEY is missing from environment', () => {
      delete process.env.GEMINI_API_KEY;

      expect(() => {
        resolveDemoProvider('gemini');
      }).toThrow(LLMConfigurationError);

      expect(() => {
        resolveDemoProvider('gemini');
      }).toThrow(/GEMINI_API_KEY is required/i);
    });

    it('refuses real Gemini mode when GEMINI_API_KEY is empty whitespace', () => {
      process.env.GEMINI_API_KEY = '   ';

      expect(() => {
        resolveDemoProvider('gemini');
      }).toThrow(LLMConfigurationError);
    });

    it('correctly selects GeminiProvider through the provider factory when configured with GEMINI_API_KEY', () => {
      process.env.GEMINI_API_KEY = 'AIzaSyMockKeyForDemoFactoryTest12345';
      process.env.GEMINI_DIAGNOSIS_MODEL = 'gemini-1.5-flash-custom';
      process.env.GEMINI_DECISION_MODEL = 'gemini-1.5-pro-custom';

      try {
        const { provider, providerName, models } = resolveDemoProvider('gemini');

        expect(provider).toBeInstanceOf(ObservingLLMProviderWrapper);
        expect(providerName).toContain('GeminiProvider');
        expect(models.diagnosis).toBe('gemini-1.5-flash-custom');
        expect(models.decision).toBe('gemini-1.5-pro-custom');
      } finally {
        delete process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_DIAGNOSIS_MODEL;
        delete process.env.GEMINI_DECISION_MODEL;
      }
    });

    it('refuses real OpenRouter mode when OPENROUTER_API_KEY is missing from environment', () => {
      delete process.env.OPENROUTER_API_KEY;

      expect(() => {
        resolveDemoProvider('openrouter');
      }).toThrow(LLMConfigurationError);

      expect(() => {
        resolveDemoProvider('openrouter');
      }).toThrow(/OPENROUTER_API_KEY is required/i);
    });

    it('refuses real OpenRouter mode when OPENROUTER_API_KEY is empty whitespace', () => {
      process.env.OPENROUTER_API_KEY = '   ';

      expect(() => {
        resolveDemoProvider('openrouter');
      }).toThrow(LLMConfigurationError);
    });

    it('correctly selects OpenRouterGeminiProvider through the provider factory when configured with OPENROUTER_API_KEY', () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-mockkeyforfactorytest12345';
      process.env.OPENROUTER_DIAGNOSIS_MODEL = 'google/gemini-flash-custom';
      process.env.OPENROUTER_DECISION_MODEL = 'google/gemini-pro-custom';

      try {
        const { provider, providerName, models } = resolveDemoProvider('openrouter');

        expect(provider).toBeInstanceOf(ObservingLLMProviderWrapper);
        expect(providerName).toContain('OpenRouterGeminiProvider');
        expect(models.diagnosis).toBe('google/gemini-flash-custom');
        expect(models.decision).toBe('google/gemini-pro-custom');
      } finally {
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.OPENROUTER_DIAGNOSIS_MODEL;
        delete process.env.OPENROUTER_DECISION_MODEL;
      }
    });

    it('refuses real OmniRoute mode when OMNIROUTE_API_KEY is missing from environment', () => {
      const origOmni = process.env.OMNIROUTE_API_KEY;
      const origAnth = process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.OMNIROUTE_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;

      try {
        expect(() => {
          resolveDemoProvider('omniroute');
        }).toThrow(LLMConfigurationError);

        expect(() => {
          resolveDemoProvider('omniroute');
        }).toThrow(/OMNIROUTE_API_KEY .* is required/i);
      } finally {
        if (origOmni !== undefined) process.env.OMNIROUTE_API_KEY = origOmni;
        if (origAnth !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origAnth;
      }
    });

    it('correctly selects OmniRouteProvider through the provider factory when configured', () => {
      process.env.OMNIROUTE_API_KEY = 'sk-d4c1f343e-test-key-mock';
      process.env.OMNIROUTE_DIAGNOSIS_MODEL = 'antigravity/gemini-flash-custom';
      process.env.OMNIROUTE_DECISION_MODEL = 'antigravity/gemini-pro-custom';

      try {
        const { provider, providerName, models } = resolveDemoProvider('omniroute');

        expect(provider).toBeInstanceOf(ObservingLLMProviderWrapper);
        expect(providerName).toContain('OmniRouteProvider');
        expect(models.diagnosis).toBe('antigravity/gemini-flash-custom');
        expect(models.decision).toBe('antigravity/gemini-pro-custom');
      } finally {
        delete process.env.OMNIROUTE_API_KEY;
        delete process.env.OMNIROUTE_DIAGNOSIS_MODEL;
        delete process.env.OMNIROUTE_DECISION_MODEL;
      }
    });

    it('supports custom provider injection via options without mutating global configuration', () => {
      const customMock = new MockLLMProvider();
      const { provider, providerName } = resolveDemoProvider('deterministic', customMock);

      expect(provider).toBeInstanceOf(ObservingLLMProviderWrapper);
      expect(providerName).toContain('custom (injected)');
    });
  });

  describe('2. Deterministic Scenario Execution (Full Autonomous Pipeline Verification)', () => {
    it('executes the complete abandonment recovery scenario deterministically under Tier T1', async () => {
      const result = await runRealLLMDemo({
        mode: 'deterministic',
        autonomyTier: 'T1',
        stage: 'details_entered',
        amountMinorUnits: 75000 // ₹750.00
      });

      // Verification of demonstration outcome
      expect(result.success).toBe(true);
      expect(result.mode).toBe('deterministic');
      expect(result.provider).toContain('MockLLMProvider');

      // Scenario entity verification
      expect(result.scenario.caseRef).toMatch(/^01/);
      expect(result.scenario.caseId).toBeGreaterThan(0);
      expect(result.scenario.orderRef).toBeDefined();
      expect(result.scenario.amountMinorUnits).toBe(75000);
      expect(result.scenario.amountFormatted).toBe('₹750.00');
      expect(result.scenario.currency).toBe('INR');
      expect(result.scenario.stage).toBe('details_entered');

      // AI Diagnosis verification
      expect(result.diagnosis).not.toBeNull();
      expect(result.diagnosis?.category).toBe('CUSTOMER_ABANDONED');
      expect(result.diagnosis?.strategy).toBe('CUSTOMER_OUTREACH');
      expect(result.diagnosis?.confidence).toBeGreaterThan(0.5);
      expect(result.diagnosis?.recoverable).toBe(true);

      // AI Decision & Action plan verification
      expect(result.decision).not.toBeNull();
      expect(result.decision?.planRationale).toBeDefined();
      expect(result.decision?.primaryAction?.actionType).toBe('CUSTOMER_OUTREACH');

      // Policy gate verification (Tier T1 requires human review for customer outreach)
      expect(result.policy).not.toBeNull();
      expect(result.policy?.governingTier).toBe('T1');
      expect(result.policy?.decision).toBe('REQUIRES_HUMAN');
      expect(result.policy?.targetStatus).toBe('awaiting_approval');

      // Observability & explainability verification
      expect(result.observability.correlationId).toMatch(/^01DEMOCORR_/);
      expect(result.observability.traceId).toMatch(/^01DEMOTRACE_/);
      expect(result.observability.providerRequestId).toMatch(/^req_mock_/);
      expect(result.observability.totalTokens).toBeGreaterThan(0);
      expect(result.observability.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.explainabilityRef).toBe(result.scenario.caseRef);
      expect(result.zeroPiiVerified).toBe(true);
    });

    it('executes the abandonment recovery scenario autonomously under Tier T3', async () => {
      const result = await runRealLLMDemo({
        mode: 'deterministic',
        autonomyTier: 'T3',
        stage: 'method_selected',
        selectedPaymentMethod: 'upi',
        amountMinorUnits: 120000 // ₹1200.00
      });

      expect(result.success).toBe(true);
      expect(result.policy?.governingTier).toBe('T3');
      expect(result.policy?.decision).toBe('APPROVED');
      expect(result.policy?.targetStatus).toBe('executing');
    });
  });

  describe('3. Network Safety & Zero External Calls Verification', () => {
    it('guarantees zero external network calls during deterministic demo runs', async () => {
      // Spy on globalThis.fetch, http.request, and https.request
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const httpRequestSpy = vi.spyOn(http, 'request');
      const httpsRequestSpy = vi.spyOn(https, 'request');

      const result = await runRealLLMDemo({
        mode: 'deterministic',
        autonomyTier: 'T1'
      });

      expect(result.success).toBe(true);

      // Assert global fetch was never invoked
      expect(fetchSpy).not.toHaveBeenCalled();

      // Assert https.request (used by OpenAI or external APIs) was never invoked
      expect(httpsRequestSpy).not.toHaveBeenCalled();

      // Filter http.request calls: only local database/test sockets if any, never external host
      for (const call of httpRequestSpy.mock.calls) {
        const options = call[0];
        if (typeof options === 'object' && options !== null) {
          const host = (options as { host?: string; hostname?: string }).host ||
                       (options as { host?: string; hostname?: string }).hostname || '';
          expect(host).not.toContain('openai.com');
        }
      }

      fetchSpy.mockRestore();
      httpRequestSpy.mockRestore();
      httpsRequestSpy.mockRestore();
    });
  });

  describe('4. Credentials & PII Safety (Zero Credential Leakage)', () => {
    it('does not leak API keys or secrets in error messages when real provider fails', () => {
      const secretKey = 'sk-live-test-super-secret-key-1234567890';
      const provider = new OpenAIProvider({
        apiKey: secretKey,
        client: {
          chat: {
            completions: {
              create: vi.fn().mockRejectedValue(
                new Error(`Authentication failed with key ${secretKey}`)
              )
            }
          }
        } as unknown as OpenAIProvider['client']
      });

      return expect(
        provider.complete({
          task: 'diagnosis',
          prompt: 'test prompt'
        })
      ).rejects.toSatisfy((err: Error) => {
        expect(err.message).not.toContain(secretKey);
        expect(err.message).toContain('[REDACTED_API_KEY]');
        return true;
      });
    });

    it('does not include API keys, passwords, or raw sensitive credentials in demo formatted output', async () => {
      const result = await runRealLLMDemo({
        mode: 'deterministic',
        autonomyTier: 'T1'
      });

      const output = formatDemoOutput(result);

      // Verify no credential tokens or unmasked secrets in output
      expect(output).not.toContain('sk-');
      expect(output).not.toContain('password');
      expect(output).not.toContain('secret');
      expect(output).toContain('DEMO COMPLETED SUCCESSFULLY');
      expect(output).toContain('Zero PII Check:       PASSED');
      expect(output).toContain('CUSTOMER_ABANDONED');
    });
  });

  describe('5. CLI Formatter Structure Verification', () => {
    it('renders all five structured audit sections cleanly', () => {
      const mockResult: RealLLMDemoResult = {
        success: true,
        mode: 'openai',
        provider: 'openai (OpenAIProvider via OrchestratedLLMProvider)',
        models: {
          diagnosis: 'gpt-4o-mini',
          decision: 'gpt-4o'
        },
        scenario: {
          merchantId: 1,
          orderId: 100,
          orderRef: '01TESTORDER000000000000001',
          caseId: 200,
          caseRef: '01TESTCASE0000000000000001',
          stage: 'details_entered',
          amountMinorUnits: 50000,
          amountFormatted: '₹500.00',
          currency: 'INR'
        },
        diagnosis: {
          category: 'CUSTOMER_ABANDONED',
          strategy: 'CUSTOMER_OUTREACH',
          confidence: 0.94,
          rootCause: 'Customer dropped off at payment step',
          recoverable: true,
          source: 'model'
        },
        decision: {
          planRationale: 'Dispatch instant payment recovery link',
          primaryAction: {
            actionType: 'CUSTOMER_OUTREACH',
            toolName: 'send_recovery_link',
            costMinorUnits: 0,
            incentivePercent: 0,
            scheduledDelaySeconds: 900
          },
          source: 'model'
        },
        policy: {
          governingTier: 'T1',
          decision: 'REQUIRES_HUMAN',
          ruleId: 'RULE_HUMAN_APPROVAL_REQUIRED',
          message: 'Human approval required',
          targetStatus: 'awaiting_approval'
        },
        observability: {
          correlationId: '01DEMOCORR_TEST',
          traceId: '01DEMOTRACE_TEST',
          providerRequestId: 'chatcmpl_test_12345',
          latencyMs: 850,
          inputTokens: 420,
          outputTokens: 110,
          totalTokens: 530
        },
        explainabilityRef: '01TESTCASE0000000000000001',
        zeroPiiVerified: true
      };

      const output = formatDemoOutput(mockResult);

      expect(output).toContain('REAL OPENAI MODE');
      expect(output).toContain('Provider Request ID:  chatcmpl_test_12345');
      expect(output).toContain('--- 1. SCENARIO / ABANDONED CHECKOUT ---');
      expect(output).toContain('--- 2. AI DIAGNOSIS (AI-002 / AI-007) ---');
      expect(output).toContain('--- 3. RECOVERY DECISION & PLAYBOOK (AI-005 / AI-006) ---');
      expect(output).toContain('--- 4. DETERMINISTIC POLICY GATE (RCV-002 / Invariant I5) ---');
      expect(output).toContain('--- 5. OBSERVABILITY & ZERO-PII PROVENANCE ---');
      expect(output).toContain('Status: DEMO COMPLETED SUCCESSFULLY');
    });

    it('renders Gemini mode header cleanly when mode is gemini', () => {
      const mockResult: RealLLMDemoResult = {
        success: true,
        mode: 'gemini',
        provider: 'gemini (GeminiProvider via OrchestratedLLMProvider)',
        models: {
          diagnosis: 'gemini-3.6-flash',
          decision: 'gemini-3.1-pro-preview'
        },
        scenario: {
          merchantId: 1,
          orderId: 100,
          orderRef: '01TESTORDER000000000000001',
          caseId: 200,
          caseRef: '01TESTCASE0000000000000001',
          stage: 'details_entered',
          amountMinorUnits: 50000,
          amountFormatted: '₹500.00',
          currency: 'INR'
        },
        diagnosis: null,
        decision: null,
        policy: null,
        observability: {
          correlationId: '01DEMOCORR_GEMINI',
          traceId: '01DEMOTRACE_GEMINI',
          latencyMs: 400,
          inputTokens: 300,
          outputTokens: 80,
          totalTokens: 380
        },
        explainabilityRef: '01TESTCASE0000000000000001',
        zeroPiiVerified: true
      };

      const output = formatDemoOutput(mockResult);
      expect(output).toContain('REAL GEMINI MODE');
      expect(output).toContain('gemini (GeminiProvider via OrchestratedLLMProvider)');
    });

    it('renders OpenRouter mode header cleanly when mode is openrouter', () => {
      const mockResult: RealLLMDemoResult = {
        success: true,
        mode: 'openrouter',
        provider: 'openrouter (OpenRouterGeminiProvider via OrchestratedLLMProvider)',
        models: {
          diagnosis: 'google/gemini-3.6-flash',
          decision: 'google/gemini-3.1-pro-preview'
        },
        scenario: {
          merchantId: 1,
          orderId: 100,
          orderRef: '01TESTORDER000000000000001',
          caseId: 200,
          caseRef: '01TESTCASE0000000000000001',
          stage: 'details_entered',
          amountMinorUnits: 50000,
          amountFormatted: '₹500.00',
          currency: 'INR'
        },
        diagnosis: null,
        decision: null,
        policy: null,
        observability: {
          correlationId: '01DEMOCORR_OPENROUTER',
          traceId: '01DEMOTRACE_OPENROUTER',
          latencyMs: 350,
          inputTokens: 250,
          outputTokens: 70,
          totalTokens: 320
        },
        explainabilityRef: '01TESTCASE0000000000000001',
        zeroPiiVerified: true
      };

      const output = formatDemoOutput(mockResult);
      expect(output).toContain('REAL OPENROUTER MODE');
      expect(output).toContain('openrouter (OpenRouterGeminiProvider via OrchestratedLLMProvider)');
    });

    it('renders OmniRoute mode header cleanly when mode is omniroute', () => {
      const mockResult: RealLLMDemoResult = {
        success: true,
        mode: 'omniroute',
        provider: 'omniroute (OmniRouteProvider via OrchestratedLLMProvider)',
        models: {
          diagnosis: 'antigravity/gemini-3.6-flash-low',
          decision: 'antigravity/gemini-3.1-pro-low'
        },
        scenario: {
          merchantId: 1,
          orderId: 100,
          orderRef: '01TESTORDER000000000000001',
          caseId: 200,
          caseRef: '01TESTCASE0000000000000001',
          stage: 'details_entered',
          amountMinorUnits: 50000,
          amountFormatted: '₹500.00',
          currency: 'INR'
        },
        diagnosis: null,
        decision: null,
        policy: null,
        observability: {
          correlationId: '01DEMOCORR_OMNIROUTE',
          traceId: '01DEMOTRACE_OMNIROUTE',
          latencyMs: 350,
          inputTokens: 250,
          outputTokens: 70,
          totalTokens: 320
        },
        explainabilityRef: '01TESTCASE0000000000000001',
        zeroPiiVerified: true
      };

      const output = formatDemoOutput(mockResult);
      expect(output).toContain('REAL OMNIROUTE MODE');
      expect(output).toContain('omniroute (OmniRouteProvider via OrchestratedLLMProvider)');
    });
  });
});
