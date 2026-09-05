import type { Server } from 'node:http';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { signAccessToken } from '../../utils/token.js';
import {
  TraceCollector,
  findTraceByRef,
  findTracesByCaseId,
  replayAgentTrace,
  executeDiagnosisWithTrace,
  executeDecisionWithTrace,
  buildRecoveryContext
} from '../../modules/ai/index.js';
import { MockLLMProvider } from '../../infrastructure/llm/mock-provider.js';
import { LLMError } from '../../infrastructure/llm/llm.types.js';
import { ingestPaymentFailure } from '../../modules/recovery/case.service.js';
import type { PaymentFailedEvent } from '../../modules/recovery/case.types.js';

describe('TASK-305: Agent Reasoning Trace & Audit Capture (AI-007 / AUD-002 / OBS-005)', () => {
  let server: Server;
  let baseUrl: string;
  let merchantToken: string;
  let merchantId: number;
  let caseId: number;

  beforeAll(async () => {
    // 1. Seed test merchant & order & case
    const merchantEmail = `trace_m_${Date.now()}@example.com`;
    const [mResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (email, password_hash, merchant_name) VALUES (?, 'hash', 'Trace Merchant')`,
      [merchantEmail]
    );
    merchantId = mResult.insertId;

    merchantToken = signAccessToken({
      id: merchantId,
      email: merchantEmail,
      roles: ['merchant'],
      merchantName: 'Trace Merchant'
    });

    const [oResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 75000, 'INR', 'pending')`,
      [merchantId, `ORD_TRACE_${Date.now()}`]
    );
    const orderId = oResult.insertId;

    const txnRef = `TXN_TRACE_${Date.now()}`;
    const [tResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO transactions (order_id, txn_ref, amount, payment_method, status) VALUES (?, ?, 750.00, 'card', 'failed')`,
      [orderId, txnRef]
    );
    const txnId = tResult.insertId;

    const failureEvent: PaymentFailedEvent = {
      eventType: 'payment.failed',
      merchantId,
      orderId,
      transactionId: txnId,
      amount: 75000,
      currency: 'INR',
      failureCategory: 'TECHNICAL_TRANSIENT',
      failureReason: 'Upstream gateway timed out',
      correlationId: `01TRACEINIT${Date.now()}`
    };

    const { case: recoveryCase } = await ingestPaymentFailure(failureEvent);
    caseId = recoveryCase.id;

    // Start HTTP server for route testing
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /*  1. Trace Collector & Persistence Tests                            */
  /* ------------------------------------------------------------------ */

  describe('1. Trace Collector & Transactional Persistence', () => {
    it('persists a complete multi-step trace atomically with accurate aggregation', async () => {
      const collector = new TraceCollector();

      collector.addStep({
        stepType: 'prompt_render',
        promptId: 'payment_failure_diagnosis',
        promptVersion: 'v1.0.0',
        systemPrompt: 'You are an AI payments diagnostics engine.',
        userPrompt: 'Context payload data',
        durationMs: 5
      });

      collector.addStep({
        stepType: 'model_completion',
        modelId: 'claude-3-5-sonnet',
        rawResponse: JSON.stringify({ category: 'TECHNICAL_TRANSIENT', confidence: 0.95 }),
        parsedOutput: { category: 'TECHNICAL_TRANSIENT', confidence: 0.95 },
        validationStatus: 'passed',
        durationMs: 450,
        inputTokens: 320,
        outputTokens: 110
      });

      const trace = await collector.flush({
        merchantId,
        caseId,
        agentType: 'diagnosis',
        status: 'success',
        correlationId: '01TRACEPERSIST0000000001'
      });

      expect(trace.id).toBeDefined();
      expect(trace.traceRef).toBeDefined();
      expect(trace.agentType).toBe('diagnosis');
      expect(trace.status).toBe('success');
      expect(trace.totalDurationMs).toBe(455);
      expect(trace.totalInputTokens).toBe(320);
      expect(trace.totalOutputTokens).toBe(110);
      expect(trace.steps).toHaveLength(2);
      expect(trace.steps[0]?.stepType).toBe('prompt_render');
      expect(trace.steps[1]?.stepType).toBe('model_completion');
      expect(trace.steps[1]?.parsedOutput).toEqual({
        category: 'TECHNICAL_TRANSIENT',
        confidence: 0.95
      });

      // Fetch from DB via findTraceByRef
      const fetched = await findTraceByRef(trace.traceRef);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(trace.id);
      expect(fetched?.steps).toHaveLength(2);
    });

    it('enforces mandatory pre-persistence PII redaction and zero-PII guarantee (AI-007 Req 3 / AI-009)', async () => {
      const collector = new TraceCollector();

      const piiUserPrompt = 'Customer email is alice.smith@example.com with phone +919876543210 and card 4111222233334444';
      collector.addStep({
        stepType: 'prompt_render',
        promptId: 'recovery_decision_planner',
        promptVersion: 'v1.0.0',
        userPrompt: piiUserPrompt,
        rawResponse: 'Response for alice.smith@example.com'
      });

      const trace = await collector.flush({
        merchantId,
        caseId,
        agentType: 'decision',
        status: 'success',
        correlationId: '01PIITRACE00000000000001'
      });

      // Verify that stored prompt in trace object does not have raw email, phone, or PAN
      expect(trace.steps[0]?.userPrompt).not.toContain('alice.smith@example.com');
      expect(trace.steps[0]?.userPrompt).not.toContain('+919876543210');
      expect(trace.steps[0]?.userPrompt).not.toContain('4111222233334444');
      expect(trace.steps[0]?.userPrompt).toContain('[EMAIL_REDACTED]');
      expect(trace.steps[0]?.userPrompt).toContain('[PHONE_REDACTED]');
      expect(trace.steps[0]?.userPrompt).toContain('[CARD_REDACTED]');

      // Scan MySQL database rows directly
      interface StoredStepRow extends RowDataPacket {
        user_prompt: string | null;
        raw_response: string | null;
      }
      const [rows] = await pool.query<StoredStepRow[]>(
        'SELECT user_prompt, raw_response FROM agent_trace_steps WHERE trace_id = ?',
        [trace.id]
      );
      expect(rows[0]?.user_prompt).not.toContain('alice.smith@example.com');
      expect(rows[0]?.user_prompt).not.toContain('+919876543210');
      expect(rows[0]?.raw_response).not.toContain('alice.smith@example.com');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Agent Execution Tracing Orchestrator Tests                     */
  /* ------------------------------------------------------------------ */

  describe('2. Agent Execution Tracing Orchestrator (AI-007 / AUD-002)', () => {
    it('executeDiagnosisWithTrace records model completion, duration, tokens and provenance', async () => {
      const mockProvider = new MockLLMProvider();
      const context = await buildRecoveryContext({ caseId, merchantId });

      const { diagnosis, trace } = await executeDiagnosisWithTrace(
        { context, correlationId: '01DIAGTRACETEST00000001' },
        mockProvider,
        merchantId,
        caseId
      );

      expect(diagnosis.category).toBeDefined();
      expect(trace.id).toBeDefined();
      expect(trace.agentType).toBe('diagnosis');
      expect(trace.status).toBe('success');
      expect(trace.totalInputTokens).toBeGreaterThan(0);
      expect(trace.totalOutputTokens).toBeGreaterThan(0);
      expect(trace.steps.length).toBeGreaterThanOrEqual(1);

      const tracesForCase = await findTracesByCaseId(caseId, merchantId);
      expect(tracesForCase.length).toBeGreaterThanOrEqual(1);
    });

    it('executeDecisionWithTrace records decision reasoning, proposed tools, and provenance', async () => {
      const mockProvider = new MockLLMProvider();
      const context = await buildRecoveryContext({ caseId, merchantId });

      const { diagnosis } = await executeDiagnosisWithTrace(
        { context, correlationId: '01DECTRACETEST000000001' },
        mockProvider,
        merchantId,
        caseId
      );

      const { decision, trace } = await executeDecisionWithTrace(
        { context, diagnosis, correlationId: '01DECTRACETEST000000001' },
        mockProvider,
        merchantId,
        caseId
      );

      expect(decision.actions.length).toBeGreaterThanOrEqual(1);
      expect(trace.id).toBeDefined();
      expect(trace.agentType).toBe('decision');
      expect(trace.status).toBe('success');
      expect(trace.steps[0]?.toolInvoked).toBeDefined();
    });

    it('records trace on provider failure with fallback rules step (AI-007 Req 5)', async () => {
      const failingMock = new MockLLMProvider({
        failureInjector: () => {
          throw new Error('Provider 500 Internal Error');
        }
      });
      const context = await buildRecoveryContext({ caseId, merchantId });

      const { diagnosis, trace } = await executeDiagnosisWithTrace(
        { context, correlationId: '01FALLBACKTRACE00000001' },
        failingMock,
        merchantId,
        caseId
      );

      expect(diagnosis.provenance.source).toBe('rules');
      expect(trace.id).toBeDefined();
      expect(trace.steps[0]?.validationStatus).toBe('fallback');
      expect(trace.terminationReason).toContain('Provider 500 Internal Error');
    });

    it('handles provider error with payload exceeding VARCHAR(255) without database column overflow (E1 fix)', async () => {
      const longErrorMessage =
        'Gemini API error (404): 404 models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods. ' +
        'Detailed diagnostic JSON payload: ' + JSON.stringify({ error: { details: 'X'.repeat(600) } });

      const failingMock = new MockLLMProvider({
        failureInjector: () => {
          throw new LLMError(longErrorMessage, 'GEMINI_API_ERROR', false, 404);
        }
      });
      const context = await buildRecoveryContext({ caseId, merchantId });

      const { diagnosis, trace } = await executeDiagnosisWithTrace(
        { context, correlationId: '01LONGOVERFLOWTRACE001' },
        failingMock,
        merchantId,
        caseId
      );

      expect(diagnosis.provenance.source).toBe('rules');
      expect(trace.id).toBeDefined();
      expect(trace.status).toBe('success');
      expect(trace.steps[0]?.validationStatus).toBe('fallback');
      expect(trace.terminationReason).toBeDefined();
      expect(trace.terminationReason!.length).toBeLessThanOrEqual(255);
      expect(trace.terminationReason).toContain('GEMINI_API_ERROR');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Trace Replay Engine Tests (AI-007 Requirement 8)               */
  /* ------------------------------------------------------------------ */

  describe('3. Deterministic Trace Replay Engine (AI-007 Requirement 8)', () => {
    it('replays a stored diagnosis trace and verifies identical determinism', async () => {
      const mockProvider = new MockLLMProvider();
      const context = await buildRecoveryContext({ caseId, merchantId });

      const { trace } = await executeDiagnosisWithTrace(
        { context, correlationId: '01REPLAYTEST00000000001' },
        mockProvider,
        merchantId,
        caseId
      );

      const replayResult = await replayAgentTrace(trace.traceRef, mockProvider);
      expect(replayResult.traceRef).toBe(trace.traceRef);
      expect(replayResult.isDeterministic).toBe(true);
      expect(replayResult.matchScore).toBe(1.0);
      expect(replayResult.originalStatus).toBe('success');
      expect(replayResult.replayedStatus).toBe('success');
    });

    it('replays a stored decision trace and verifies deterministic reproduction', async () => {
      const mockProvider = new MockLLMProvider();
      const context = await buildRecoveryContext({ caseId, merchantId });
      const { diagnosis } = await executeDiagnosisWithTrace({ context }, mockProvider, merchantId, caseId);

      const { trace } = await executeDecisionWithTrace(
        { context, diagnosis, correlationId: '01REPLAYDECTEST0000001' },
        mockProvider,
        merchantId,
        caseId
      );

      const replayResult = await replayAgentTrace(trace.traceRef, mockProvider);
      expect(replayResult.isDeterministic).toBe(true);
      expect(replayResult.matchScore).toBe(1.0);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. REST Endpoints & Role-Based Views Separation                   */
  /* ------------------------------------------------------------------ */

  describe('4. REST Endpoints & Views Separation (AI-007 Requirements 7 & 11)', () => {
    it('GET /api/v1/ops/agent-traces/:traceRef returns full trace with step details for operators', async () => {
      const mockProvider = new MockLLMProvider();
      const context = await buildRecoveryContext({ caseId, merchantId });
      const { trace } = await executeDiagnosisWithTrace({ context }, mockProvider, merchantId, caseId);

      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${trace.traceRef}`, {
        headers: { Authorization: `Bearer ${merchantToken}` }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.traceRef).toBe(trace.traceRef);
      expect(data.steps).toBeInstanceOf(Array);
      expect(data.steps.length).toBeGreaterThanOrEqual(1);
      expect(data.totalDurationMs).toBeDefined();
    });

    it('POST /api/v1/ops/agent-traces/:traceRef/replay triggers deterministic replay via HTTP', async () => {
      const mockProvider = new MockLLMProvider();
      const context = await buildRecoveryContext({ caseId, merchantId });
      const { trace } = await executeDiagnosisWithTrace({ context }, mockProvider, merchantId, caseId);

      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${trace.traceRef}/replay`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${merchantToken}` }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.isDeterministic).toBe(true);
      expect(data.matchScore).toBe(1.0);
    });

    it('GET /api/merchants/recovery/cases/:caseId/trace returns sanitized rationale summary for merchants', async () => {
      const mockProvider = new MockLLMProvider();
      const context = await buildRecoveryContext({ caseId, merchantId });
      await executeDecisionWithTrace(
        {
          context,
          diagnosis: {
            category: 'TECHNICAL_TRANSIENT',
            reasonCode: 'GW_TIMEOUT',
            rootCause: 'Gateway Timeout',
            contributingFactors: ['Network latency'],
            recoverable: true,
            recommendedStrategy: 'DELAYED_RETRY',
            confidence: 0.95,
            explanation: 'Transient failure suitable for automatic retry',
            evidence: ['504 Gateway Timeout'],
            provenance: {
              source: 'model',
              promptId: 'payment_failure_diagnosis',
              promptVersion: 'v1.0.0',
              modelId: 'claude-3-5-sonnet',
              tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
              latencyMs: 250,
              contextVersion: 'v1.0.0',
              rulesVersion: null,
              repairAttempted: false,
              fallbackReason: null
            }
          }
        },
        mockProvider,
        merchantId,
        caseId
      );

      const res = await fetch(`${baseUrl}/api/merchants/recovery/cases/${caseId}/trace`, {
        headers: { Authorization: `Bearer ${merchantToken}` }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.caseId).toBe(caseId);
      expect(data.rationaleSummary).toBeDefined();
      expect(data.isAutonomous).toBe(true);

      // Verify internal prompts/system instructions are NOT exposed in merchant summary view
      expect(data.systemPrompt).toBeUndefined();
      expect(data.rawResponse).toBeUndefined();
      expect(data.steps).toBeUndefined();
    });

    it('GET /api/v1/ops/agent-traces/:traceRef returns 404 for unknown trace', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/01NONEXISTENTTRACE0000000`, {
        headers: { Authorization: `Bearer ${merchantToken}` }
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('TRACE_NOT_FOUND');
    });

    it('GET /api/v1/ops/agent-traces without auth returns 401', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/01SOME_TRACE`);
      expect(res.status).toBe(401);
    });
  });
});
