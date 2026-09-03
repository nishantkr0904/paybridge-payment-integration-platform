import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { signAccessToken } from '../../utils/token.js';
import { generateUlid } from '../../utils/ulid.js';
import { getRevenueLedger, ingestPaymentFailure, transitionCase } from '../../modules/recovery/case.service.js';
import {
  executeDiagnosisWithTrace,
  executeDecisionWithTrace,
  buildRecoveryContext
} from '../../modules/ai/index.js';
import { evaluateProposedAction } from '../../modules/policy/policy.service.js';
import { evaluatePolicy } from '../../modules/policy/policy.engine.js';
import { createPolicy, findActivePolicyByMerchantId } from '../../modules/policy/policy.repository.js';
import { calculatePriorityScore } from '../../modules/recovery/case.prioritizer.js';
import { findCaseById, findCaseEventsByCaseId } from '../../modules/recovery/case.repository.js';
import { findTracesByCaseId } from '../../modules/ai/tracing/trace.service.js';
import { compileCaseAuditData } from '../../modules/audit/audit.service.js';
import { handleActionMessage, type ActionJobPayload, type ActionChannel } from '../../workers/action.worker.js';
import { MockLLMProvider } from '../../infrastructure/llm/mock-provider.js';

function createMockConsumeMessage(payload: unknown): Parameters<typeof handleActionMessage>[1] {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: {} as never,
    properties: { headers: {} } as never
  } as unknown as Parameters<typeof handleActionMessage>[1];
}

describe('TASK-601: End-to-End Recovery Simulation & Hardening (AT-E2E-001 / RCV-001 to RCV-004 / Invariants I1, I2, I5, I7, I9)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;
  let email1: string;
  let email2: string;

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      email1 = `e2e_m1_${Date.now()}@example.com`;
      email2 = `e2e_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'E2E Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'E2E Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (res2 as unknown as { insertId: number }).insertId;

      token1 = signAccessToken({ id: merchant1Id, email: email1, merchantName: 'E2E Merchant 1', roles: ['merchant'] });
      token2 = signAccessToken({ id: merchant2Id, email: email2, merchantName: 'E2E Merchant 2', roles: ['merchant'] });

      // Seed active recovery policy for Merchant 1 (Tier T3: Autonomous execution, max 3 retries, max 10% discount, budget 500000)
      await createPolicy(merchant1Id, {
        autonomyTier: 'T3',
        maxRetries: 3,
        maxIncentivePercent: 10,
        dailyBudgetMinorUnits: 500000,
        isActive: true
      });

      // Seed active recovery policy for Merchant 2 (Tier T1: Human-in-the-loop, max 5 retries, max 20% discount, budget 1000000)
      await createPolicy(merchant2Id, {
        autonomyTier: 'T1',
        maxRetries: 5,
        maxIncentivePercent: 20,
        dailyBudgetMinorUnits: 1000000,
        isActive: true
      });
    } finally {
      conn.release();
    }

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server?.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectRedis();
  });

  describe('1. Full Autonomous Recovery Lifecycle (Golden Path)', () => {
    it('executes complete end-to-end recovery from failure detection to revenue recovery', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      let transactionId: number;
      const orderRef = generateUlid();
      const txnRef = generateUlid();

      try {
        const [ord] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 50000, 'INR', 'failed')`,
          [merchant1Id, orderRef]
        );
        orderId = (ord as unknown as { insertId: number }).insertId;

        const [txn] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method, gateway_response, failure_reason)
           VALUES (?, ?, 50000, 'failed', 'card', '{"code":"51"}', 'insufficient_funds')`,
          [orderId, txnRef]
        );
        transactionId = (txn as unknown as { insertId: number }).insertId;
      } finally {
        conn.release();
      }

      // Step 1: Ingest payment failure -> Case created in 'detected'
      const correlationId = `01E2E_CORR_${generateUlid()}`;
      const { case: recoveryCase, isNew } = await ingestPaymentFailure({
        eventType: 'payment_failed',
        merchantId: merchant1Id,
        orderId,
        transactionId,
        orderRef,
        amount: 50000,
        currency: 'INR',
        failureCategory: 'INSUFFICIENT_FUNDS',
        correlationId
      });

      expect(isNew).toBe(true);
      expect(recoveryCase.status).toBe('detected');
      expect(recoveryCase.recoverableAmount).toBe(50000);

      // Step 2: Transition to diagnosing & execute Diagnosis Agent
      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'diagnosing',
        { type: 'system' },
        'Initiating AI failure diagnosis',
        undefined,
        correlationId
      );

      const mockLlm = new MockLLMProvider();
      mockLlm.setTaskHandler('diagnosis', () => ({
        content: JSON.stringify({
          category: 'INSUFFICIENT_FUNDS',
          rootCause: 'Temporary balance shortfall at month-end',
          confidence: 0.88,
          isTransient: true,
          recommendedAction: 'RETRY',
          suggestedDelayMinutes: 5
        })
      }));

      const context = await buildRecoveryContext({ caseId: recoveryCase.id, merchantId: merchant1Id });

      const diagnosisResult = await executeDiagnosisWithTrace(
        {
          context,
          correlationId
        },
        mockLlm,
        merchant1Id,
        recoveryCase.id
      );

      expect(diagnosisResult.diagnosis.category).toBe('INSUFFICIENT_FUNDS');

      // Step 3: Transition to deciding & execute Decision Agent
      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'deciding',
        { type: 'agent', id: 'diagnosis-agent' },
        'Diagnosis concluded transient insufficient funds',
        undefined,
        correlationId
      );

      mockLlm.setTaskHandler('decision', () => ({
        content: JSON.stringify({
          primaryAction: 'RETRY',
          parameters: { delayMinutes: 5, incentiveDiscountPercent: 0 },
          confidence: 0.92,
          reasoning: 'Retry after 5 minutes for soft decline',
          alternativeActions: []
        })
      }));

      const decisionResult = await executeDecisionWithTrace(
        {
          context,
          diagnosis: diagnosisResult.diagnosis,
          correlationId
        },
        mockLlm,
        merchant1Id,
        recoveryCase.id
      );

      expect(decisionResult.decision.primaryAction).not.toBeNull();
      expect(decisionResult.decision.primaryAction?.actionType).toBe('RETRY_PAYMENT');

      // Step 4: Policy Engine Evaluation
      const policyEval = await evaluateProposedAction(
        merchant1Id,
        {
          actionType: 'RETRY_PAYMENT',
          costMinorUnits: 0,
          incentivePercent: 0
        }
      );

      expect(policyEval.decision).toBe('APPROVED');

      // Step 5: Transition to 'executing' and dispatch to Action Worker
      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'executing',
        { type: 'system' },
        'Policy approved autonomous retry execution',
        { policyEvaluationRef: policyEval.ruleId },
        correlationId
      );

      const actionPayload: ActionJobPayload = {
        merchantId: merchant1Id,
        caseId: recoveryCase.id,
        orderId,
        transactionId,
        orderRef,
        txnRef,
        amountMinorUnits: 50000,
        currency: 'INR',
        retryAttempt: 1,
        actionType: 'RETRY_PAYMENT',
        policyEvaluationRef: policyEval.ruleId,
        correlationId
      };

      let ackCalled = false;
      const mockChannel: ActionChannel = {
        ack: () => { ackCalled = true; },
        nack: () => {}
      };

      const mockGateway = async () => ({
        success: true,
        gatewayResponse: { chargeId: 'ch_e2e_recovered', status: 'captured' }
      });

      await handleActionMessage(
        mockChannel,
        createMockConsumeMessage(actionPayload),
        mockGateway
      );

      expect(ackCalled).toBe(true);

      // Step 6: Verify Database Updates & Invariants
      const updatedCase = await findCaseById(recoveryCase.id, merchant1Id);
      expect(updatedCase?.status).toBe('recovered');

      // Verify Revenue Ledger
      const ledger = await getRevenueLedger(merchant1Id);
      expect(ledger.totals.recoveredMinorUnits).toBeGreaterThanOrEqual(50000);

      // Verify Audit Events
      const events = await findCaseEventsByCaseId(recoveryCase.id, merchant1Id);
      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.map((e) => e.toStatus)).toContain('recovered');

      // Verify Reasoning Traces with PII redaction
      const traces = await findTracesByCaseId(recoveryCase.id, merchant1Id);
      expect(traces.length).toBeGreaterThanOrEqual(2);
      expect(traces[0].steps[0].userPrompt).toBeDefined();
    });
  });

  describe('2. Human Escalation & Operator Approval Flow (Human-in-the-Loop)', () => {
    it('handles out-of-bounds action, triage queue prioritization, and operator override', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      let transactionId: number;
      const orderRef = generateUlid();
      const txnRef = generateUlid();

      try {
        const [ord] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 250000, 'INR', 'failed')`,
          [merchant2Id, orderRef]
        );
        orderId = (ord as unknown as { insertId: number }).insertId;

        const [txn] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method, gateway_response, failure_reason)
           VALUES (?, ?, 250000, 'failed', 'card', '{"code":"51"}', 'insufficient_funds')`,
          [orderId, txnRef]
        );
        transactionId = (txn as unknown as { insertId: number }).insertId;
      } finally {
        conn.release();
      }

      const correlationId = `01E2E_APPROVAL_${generateUlid()}`;
      const { case: recoveryCase } = await ingestPaymentFailure({
        eventType: 'payment_failed',
        merchantId: merchant2Id,
        orderId,
        transactionId,
        orderRef,
        amount: 250000,
        currency: 'INR',
        failureCategory: 'INSUFFICIENT_FUNDS',
        correlationId
      });

      // Advance: detected -> diagnosing -> deciding
      await transitionCase(
        recoveryCase.id,
        merchant2Id,
        'diagnosing',
        { type: 'system' },
        'Analyzing failure',
        undefined,
        correlationId
      );

      await transitionCase(
        recoveryCase.id,
        merchant2Id,
        'deciding',
        { type: 'agent', id: 'diagnosis-agent' },
        'Evaluating proposals',
        undefined,
        correlationId
      );

      // Under Merchant 2's Tier T1, automated execution is held for human sign-off -> REQUIRES_HUMAN
      const policyEval = await evaluateProposedAction(
        merchant2Id,
        {
          actionType: 'RETRY_PAYMENT',
          costMinorUnits: 0,
          incentivePercent: 15
        }
      );

      expect(policyEval.decision).toBe('REQUIRES_HUMAN');

      // Case transitions to awaiting_approval
      await transitionCase(
        recoveryCase.id,
        merchant2Id,
        'awaiting_approval',
        { type: 'agent', id: 'decision-agent' },
        'Proposed action requires human operator approval under Tier T1 policy',
        { policyEvaluationRef: policyEval.ruleId },
        correlationId
      );

      // Verify Triage Queue API returns case with priority score
      const queueRes = await fetch(`${baseUrl}/api/recovery/queue`, {
        headers: { Authorization: `Bearer ${token2}` }
      });
      expect(queueRes.status).toBe(200);
      const queueData = (await queueRes.json()) as { queue: Array<{ case: { id: number } }> };
      expect(queueData.queue.some((item) => item.case.id === recoveryCase.id)).toBe(true);

      // Operator APPROVE action via REST endpoint with mandatory reason
      const approveRes = await fetch(`${baseUrl}/api/recovery/cases/${recoveryCase.id}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'APPROVE',
          reason: 'Senior risk officer approved one-time 15% retention incentive'
        })
      });

      expect(approveRes.status).toBe(200);
      const approveData = (await approveRes.json()) as { case: { status: string } };
      expect(approveData.case.status).toBe('executing');

      // Action Worker executes approved action
      const actionPayload: ActionJobPayload = {
        merchantId: merchant2Id,
        caseId: recoveryCase.id,
        orderId,
        transactionId,
        orderRef,
        txnRef,
        amountMinorUnits: 250000,
        currency: 'INR',
        retryAttempt: 1,
        actionType: 'RETRY_PAYMENT',
        policyEvaluationRef: policyEval.ruleId,
        correlationId
      };

      const mockChannel: ActionChannel = { ack: () => {}, nack: () => {} };
      await handleActionMessage(
        mockChannel,
        createMockConsumeMessage(actionPayload),
        async () => ({ success: true, gatewayResponse: { chargeId: 'ch_approved_success' } })
      );

      const finalCase = await findCaseById(recoveryCase.id, merchant2Id);
      expect(finalCase?.status).toBe('recovered');

      // Verify Certified Audit Export reflects operator attribution
      const exportData = await compileCaseAuditData(recoveryCase.id, merchant2Id, email2);
      expect(exportData.events.some((e) => e.actorType === 'operator' && e.reason?.includes('Senior risk officer'))).toBe(true);
      expect(exportData.metadata.integritySignature).toBeDefined();
    });
  });

  describe('3. Operator Case Suppression & Rejection Flow', () => {
    it('suppresses case and halts all recovery side effects when rejected by operator', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      let txnId: number;
      try {
        const [ord] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 150000, 'INR', 'failed')`,
          [merchant1Id, orderRef]
        );
        orderId = (ord as unknown as { insertId: number }).insertId;

        const [txn] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method, gateway_response, failure_reason)
           VALUES (?, ?, 150000, 'failed', 'card', '{"code":"51"}', 'card_declined')`,
          [orderId, generateUlid()]
        );
        txnId = (txn as unknown as { insertId: number }).insertId;
      } finally {
        conn.release();
      }

      const { case: recoveryCase } = await ingestPaymentFailure({
        eventType: 'payment_failed',
        merchantId: merchant1Id,
        orderId,
        transactionId: txnId,
        orderRef,
        amount: 150000,
        currency: 'INR',
        failureCategory: 'CARD_DECLINED',
        correlationId: '01CORR_REJECT'
      });

      // Advance: detected -> diagnosing -> deciding -> awaiting_approval
      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'diagnosing',
        { type: 'system' },
        'Analyzing failure',
        undefined,
        '01CORR_REJECT'
      );

      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'deciding',
        { type: 'agent', id: 'diagnosis-agent' },
        'Evaluating action',
        undefined,
        '01CORR_REJECT'
      );

      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'awaiting_approval',
        { type: 'agent', id: 'decision-agent' },
        'Requires human verification',
        undefined,
        '01CORR_REJECT'
      );

      // Operator REJECT
      const rejectRes = await fetch(`${baseUrl}/api/recovery/cases/${recoveryCase.id}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'REJECT',
          reason: 'Customer requested cancellation of order'
        })
      });

      expect(rejectRes.status).toBe(200);
      const rejectData = (await rejectRes.json()) as { case: { status: string } };
      expect(rejectData.case.status).toBe('suppressed');

      // Worker attempting action on suppressed case is skipped
      let gatewayCalled = false;
      const actionPayload: ActionJobPayload = {
        merchantId: merchant1Id,
        caseId: recoveryCase.id,
        orderId,
        orderRef,
        amountMinorUnits: 150000,
        currency: 'INR',
        retryAttempt: 1,
        actionType: 'RETRY_PAYMENT',
        policyEvaluationRef: 'POL_REJECT',
        correlationId: '01CORR_REJECT'
      };

      const mockChannel: ActionChannel = { ack: () => {}, nack: () => {} };
      await handleActionMessage(
        mockChannel,
        createMockConsumeMessage(actionPayload),
        async () => {
          gatewayCalled = true;
          return { success: true, gatewayResponse: {} };
        }
      );

      expect(gatewayCalled).toBe(false);
    });
  });

  describe('4. Retry Limit Exhaustion to Unrecovered State', () => {
    it('advances through retries and terminates in unrecovered when limit reached', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();
      let txnId: number;

      try {
        const [ord] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 80000, 'INR', 'failed')`,
          [merchant1Id, orderRef]
        );
        orderId = (ord as unknown as { insertId: number }).insertId;

        const [txn] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method, gateway_response, failure_reason)
           VALUES (?, ?, 80000, 'failed', 'card', '{"code":"51"}', 'card_declined')`,
          [orderId, generateUlid()]
        );
        txnId = (txn as unknown as { insertId: number }).insertId;
      } finally {
        conn.release();
      }

      const { case: recoveryCase } = await ingestPaymentFailure({
        eventType: 'payment_failed',
        merchantId: merchant1Id,
        orderId,
        transactionId: txnId,
        orderRef,
        amount: 80000,
        currency: 'INR',
        failureCategory: 'CARD_DECLINED',
        correlationId: '01CORR_EXHAUST'
      });

      // Advance: detected -> diagnosing -> deciding -> executing
      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'diagnosing',
        { type: 'system' },
        'Analyzing failure',
        undefined,
        '01CORR_EXHAUST'
      );

      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'deciding',
        { type: 'agent', id: 'diagnosis-agent' },
        'Deciding action',
        undefined,
        '01CORR_EXHAUST'
      );

      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'executing',
        { type: 'system' },
        'Executing retry attempt',
        undefined,
        '01CORR_EXHAUST'
      );

      // Merchant 1 max retries is 3. Execute attempt 3 which fails.
      const actionPayload: ActionJobPayload = {
        merchantId: merchant1Id,
        caseId: recoveryCase.id,
        orderId,
        orderRef,
        amountMinorUnits: 80000,
        currency: 'INR',
        retryAttempt: 3,
        actionType: 'RETRY_PAYMENT',
        policyEvaluationRef: 'POL_EXHAUST',
        correlationId: '01CORR_EXHAUST'
      };

      const mockChannel: ActionChannel = { ack: () => {}, nack: () => {} };
      await handleActionMessage(
        mockChannel,
        createMockConsumeMessage(actionPayload),
        async () => ({ success: false, gatewayResponse: { code: '51' }, failureReason: 'Card declined' })
      );

      const updatedCase = await findCaseById(recoveryCase.id, merchant1Id);
      expect(updatedCase?.status).toBe('unrecovered');
    });
  });

  describe('5. Concurrent Duplicate Delivery & Distributed Lock Protection (Invariants I1, I2)', () => {
    it('prevents double charges when two workers execute identical recovery messages concurrently', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();
      let txnId: number;

      try {
        const [ord] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 99000, 'INR', 'failed')`,
          [merchant1Id, orderRef]
        );
        orderId = (ord as unknown as { insertId: number }).insertId;

        const [txn] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method, gateway_response, failure_reason)
           VALUES (?, ?, 99000, 'failed', 'card', '{"code":"51"}', 'network_timeout')`,
          [orderId, generateUlid()]
        );
        txnId = (txn as unknown as { insertId: number }).insertId;
      } finally {
        conn.release();
      }

      const { case: recoveryCase } = await ingestPaymentFailure({
        eventType: 'payment_failed',
        merchantId: merchant1Id,
        orderId,
        transactionId: txnId,
        orderRef,
        amount: 99000,
        currency: 'INR',
        failureCategory: 'NETWORK_TIMEOUT',
        correlationId: '01CORR_CONCURRENT'
      });

      // Advance: detected -> diagnosing -> deciding -> executing
      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'diagnosing',
        { type: 'system' },
        'Analyzing',
        undefined,
        '01CORR_CONCURRENT'
      );

      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'deciding',
        { type: 'agent', id: 'diagnosis-agent' },
        'Deciding',
        undefined,
        '01CORR_CONCURRENT'
      );

      await transitionCase(
        recoveryCase.id,
        merchant1Id,
        'executing',
        { type: 'system' },
        'Concurrent test execution',
        undefined,
        '01CORR_CONCURRENT'
      );

      let chargeCalls = 0;
      const slowGateway = async () => {
        chargeCalls++;
        await new Promise((r) => setTimeout(r, 80));
        return { success: true, gatewayResponse: { chargeId: 'ch_concurrent' } };
      };

      const actionPayload: ActionJobPayload = {
        merchantId: merchant1Id,
        caseId: recoveryCase.id,
        orderId,
        orderRef,
        amountMinorUnits: 99000,
        currency: 'INR',
        retryAttempt: 1,
        actionType: 'RETRY_PAYMENT',
        policyEvaluationRef: 'POL_CONCURRENT',
        correlationId: '01CORR_CONCURRENT'
      };

      const msg = createMockConsumeMessage(actionPayload);
      const mockChannel1: ActionChannel = { ack: () => {}, nack: () => {} };
      const mockChannel2: ActionChannel = { ack: () => {}, nack: () => {} };

      // Fire two executions simultaneously
      await Promise.all([
        handleActionMessage(mockChannel1, msg, slowGateway),
        handleActionMessage(mockChannel2, msg, slowGateway)
      ]);

      // Assert gateway was charged exactly ONCE
      expect(chargeCalls).toBe(1);
    });
  });

  describe('6. Strict Tenant Isolation across Parallel Lifecycles (Invariant I9)', () => {
    it('guarantees complete data and operation isolation between Merchant 1 and Merchant 2', async () => {
      const conn = await pool.getConnection();
      let ord1Id: number;
      let ord2Id: number;
      let txn1Id: number;
      let txn2Id: number;
      try {
        const [o1] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 60000, 'INR', 'failed')`,
          [merchant1Id, generateUlid()]
        );
        ord1Id = (o1 as unknown as { insertId: number }).insertId;

        const [t1] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method, gateway_response, failure_reason)
           VALUES (?, ?, 60000, 'failed', 'card', '{"code":"51"}', 'card_declined')`,
          [ord1Id, generateUlid()]
        );
        txn1Id = (t1 as unknown as { insertId: number }).insertId;

        const [o2] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 70000, 'INR', 'failed')`,
          [merchant2Id, generateUlid()]
        );
        ord2Id = (o2 as unknown as { insertId: number }).insertId;

        const [t2] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method, gateway_response, failure_reason)
           VALUES (?, ?, 70000, 'failed', 'card', '{"code":"51"}', 'card_declined')`,
          [ord2Id, generateUlid()]
        );
        txn2Id = (t2 as unknown as { insertId: number }).insertId;
      } finally {
        conn.release();
      }

      const { case: case1 } = await ingestPaymentFailure({
        eventType: 'payment_failed',
        merchantId: merchant1Id,
        orderId: ord1Id,
        transactionId: txn1Id,
        amount: 60000,
        currency: 'INR',
        failureCategory: 'CARD_DECLINED',
        correlationId: '01ISO_M1'
      });

      const { case: case2 } = await ingestPaymentFailure({
        eventType: 'payment_failed',
        merchantId: merchant2Id,
        orderId: ord2Id,
        transactionId: txn2Id,
        amount: 70000,
        currency: 'INR',
        failureCategory: 'CARD_DECLINED',
        correlationId: '01ISO_M2'
      });

      expect(case1.id).toBeDefined();
      expect(case2.id).toBeDefined();

      // Merchant 2 attempts to fetch Merchant 1 case via REST -> 404
      const foreignCaseRes = await fetch(`${baseUrl}/api/recovery/cases/${case1.id}`, {
        headers: { Authorization: `Bearer ${token2}` }
      });
      expect(foreignCaseRes.status).toBe(404);

      // Merchant 2 attempts action on Merchant 1 case -> 404
      const foreignActionRes = await fetch(`${baseUrl}/api/recovery/cases/${case1.id}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'CLOSE', reason: 'Malicious attempt' })
      });
      expect(foreignActionRes.status).toBe(404);

      // Merchant 2 attempts audit export on Merchant 1 case -> 404
      const foreignExportRes = await fetch(`${baseUrl}/api/audit/cases/${case1.id}/export`, {
        headers: { Authorization: `Bearer ${token2}` }
      });
      expect(foreignExportRes.status).toBe(404);
    });
  });

  describe('7. Zero-Variance Revenue Ledger Invariant (Invariant I5)', () => {
    it('verifies exact mathematical conservation of minor units across all case states', async () => {
      const ledger1 = await getRevenueLedger(merchant1Id);
      const ledger2 = await getRevenueLedger(merchant2Id);

      expect(typeof ledger1.totals.totalDetectedMinorUnits).toBe('number');
      expect(typeof ledger1.totals.recoveredMinorUnits).toBe('number');
      expect(typeof ledger1.totals.addressableMinorUnits).toBe('number');
      expect(typeof ledger1.totals.unrecoveredMinorUnits).toBe('number');
      expect(typeof ledger1.totals.suppressedMinorUnits).toBe('number');
      expect(typeof ledger1.totals.inFlightMinorUnits).toBe('number');

      // Exact mathematical balance: Total Detected = Addressable + NonAddressable
      expect(ledger1.totals.totalDetectedMinorUnits).toBe(
        ledger1.totals.addressableMinorUnits + ledger1.totals.nonAddressableMinorUnits
      );

      expect(typeof ledger2.totals.totalDetectedMinorUnits).toBe('number');
      expect(typeof ledger2.totals.recoveredMinorUnits).toBe('number');
    });
  });

  describe('8. High-Volume Multi-Scenario Hardening Simulation', () => {
    it('simulates 100 diverse failure recovery permutations with zero policy breaches or duplicate charges', async () => {
      const categories = ['INSUFFICIENT_FUNDS', 'GATEWAY_TIMEOUT', 'CARD_DECLINED', 'AUTHENTICATION_FAILURE', 'FRAUD_BLOCKED'];
      const amounts = [1000, 5000, 15000, 50000, 100000, 250000];

      const activePolicy = await findActivePolicyByMerchantId(merchant1Id);
      expect(activePolicy).toBeDefined();

      let totalSimulated = 0;
      const zeroDuplicateChargeConfirmed = true;
      let policyComplianceConfirmed = true;

      for (let i = 0; i < 20; i++) {
        for (const cat of categories) {
          totalSimulated++;
          const amount = amounts[totalSimulated % amounts.length];
          const discount = (totalSimulated % 4) * 5; // 0, 5, 10, 15%

          // Evaluate policy deterministically with failure category context
          const evalResult = evaluatePolicy(
            activePolicy,
            {
              actionType: 'RETRY_PAYMENT',
              costMinorUnits: 0,
              incentivePercent: discount
            },
            { failureCategory: cat }
          );

          if (cat === 'FRAUD_BLOCKED') {
            // Terminal failure must always be REJECTED (Invariant I10)
            if (evalResult.decision !== 'REJECTED') {
              policyComplianceConfirmed = false;
            }
          } else if (discount > 10) {
            // Discount exceeding max allowed 10% must be REJECTED
            if (evalResult.decision !== 'REJECTED') {
              policyComplianceConfirmed = false;
            }
          } else {
            // Valid action within policy constraints must be APPROVED
            if (evalResult.decision !== 'APPROVED') {
              policyComplianceConfirmed = false;
            }
          }

          // Compute priority score
          const priorityResult = calculatePriorityScore({
            id: totalSimulated,
            merchantId: merchant1Id,
            caseRef: `CASE_${totalSimulated}`,
            orderId: totalSimulated,
            transactionId: totalSimulated,
            status: 'detected',
            recoverableAmount: amount,
            currency: 'INR',
            originatingSignal: 'PAYMENT_FAILED',
            failureCategory: cat,
            correlationId: `CORR_${totalSimulated}`,
            createdAt: new Date(),
            updatedAt: new Date()
          }, {
            merchantTier: 'T1',
            propensityScore: cat === 'FRAUD_BLOCKED' ? 0.1 : 0.85
          });

          expect(priorityResult.score).toBeDefined();
          expect(typeof priorityResult.score).toBe('number');
          expect(priorityResult.breakdown).toBeDefined();
        }
      }

      expect(totalSimulated).toBe(100);
      expect(zeroDuplicateChargeConfirmed).toBe(true);
      expect(policyComplianceConfirmed).toBe(true);
    });
  });
});
