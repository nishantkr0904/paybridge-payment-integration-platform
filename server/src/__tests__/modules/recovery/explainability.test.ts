import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import YAML from 'yamljs';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../../../app.js';
import { pool } from '../../../config/database.js';
import { connectRedis, disconnectRedis } from '../../../infrastructure/redis.js';
import { signAccessToken } from '../../../utils/token.js';
import { generateUlid } from '../../../utils/ulid.js';
import { createAgentTrace } from '../../../modules/ai/tracing/trace.repository.js';
import { assertZeroPII } from '../../../modules/ai/redaction.service.js';
import {
  createCaseWithEvent,
  transitionCaseStatus
} from '../../../modules/recovery/case.repository.js';
import type { UnifiedExplainabilityPayload } from '../../../modules/recovery/explainability.types.js';

describe('BT-C4: Unified Explainability Payload Endpoint (BC-7.5 / BEX-003)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;

  let m1Case1Id: number;
  let m1Case1Ref: string;
  let m1Case2Id: number;
  let m1Case2Ref: string;
  let m1Case3Id: number;
  let m1Case3Ref: string;

  let m2CaseId: number;
  let m2CaseRef: string;

  beforeAll(async () => {
    await connectRedis();

    const app = createApp();
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;

    const conn = await pool.getConnection();
    try {
      const email1 = `explain_m1_${Date.now()}@example.com`;
      const email2 = `explain_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Explainability Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Explainability Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (res2 as unknown as { insertId: number }).insertId;

      token1 = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Explainability Merchant 1',
        roles: ['merchant']
      });

      token2 = signAccessToken({
        id: merchant2Id,
        email: email2,
        merchantName: 'Explainability Merchant 2',
        roles: ['merchant']
      });

      // Seed active policy for Merchant 1
      await conn.query(
        `INSERT INTO policies (
          merchant_id, autonomy_tier, max_retries, max_contacts_per_customer_per_week,
          daily_budget_minor_units, max_incentive_percent, timezone, is_active, version
        ) VALUES (?, 'T2', 3, 2, 100000, 10, 'Asia/Kolkata', TRUE, 1)`,
        [merchant1Id]
      );

      // Seed orders with unique refs
      const [ord1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 50000, 'INR', 'failed')`,
        [merchant1Id, generateUlid()]
      );
      const m1Order1Id = (ord1 as unknown as { insertId: number }).insertId;

      const [ord2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 120000, 'INR', 'failed')`,
        [merchant1Id, generateUlid()]
      );
      const m1Order2Id = (ord2 as unknown as { insertId: number }).insertId;

      const [ord3] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 75000, 'INR', 'failed')`,
        [merchant1Id, generateUlid()]
      );
      const m1Order3Id = (ord3 as unknown as { insertId: number }).insertId;

      const [ordM2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 88000, 'INR', 'failed')`,
        [merchant2Id, generateUlid()]
      );
      const m2OrderId = (ordM2 as unknown as { insertId: number }).insertId;

      // -------------------------------------------------------------
      // Case 1: Fully populated case with traces, diagnosis, decision, policy, recovered
      // -------------------------------------------------------------
      const c1 = await createCaseWithEvent(
        merchant1Id,
        {
          orderId: m1Order1Id,
          recoverableAmount: 50000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILED',
          failureCategory: 'INSUFFICIENT_FUNDS',
          correlationId: 'CORR_EXP_CASE_1',
          initialStatus: 'detected'
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'payment_worker',
          reason: 'Initial gateway card charge failed due to insufficient funds',
          correlationId: 'CORR_EXP_CASE_1'
        }
      );
      m1Case1Id = c1.id;
      m1Case1Ref = c1.caseRef;

      // Transition to diagnosing
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'diagnosing',
        actorType: 'system',
        actorId: 'diagnosis_worker',
        reason: 'Diagnosis initiated',
        correlationId: 'CORR_EXP_CASE_1'
      });

      // Transition to deciding
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'deciding',
        actorType: 'agent',
        actorId: 'diagnosis-agent',
        reason: 'Diagnosis completed, transitioning to decision',
        correlationId: 'CORR_EXP_CASE_1'
      });

      // Transition to executing
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'executing',
        actorType: 'system',
        actorId: 'action_worker',
        reason: 'Action execution initiated for retry attempt 1',
        payload: {
          actionType: 'RETRY_PAYMENT',
          retryAttempt: 1,
          policyEvaluation: {
            decision: 'APPROVED',
            reasonCode: 'ACTION_ALLOWED',
            ruleId: 'RULE_RETRY_LIMIT',
            message: 'Retry attempt 1 within max allowable 3',
            evaluatedTier: 'T2',
            evaluatedAt: new Date().toISOString(),
            proposedAction: { actionType: 'RETRY_PAYMENT', costMinorUnits: 0 }
          }
        },
        correlationId: 'CORR_EXP_CASE_1'
      });

      // Transition to recovered
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'recovered',
        actorType: 'system',
        actorId: 'action_worker',
        reason: 'Payment successfully captured on retry attempt 1',
        payload: {
          actionType: 'RETRY_PAYMENT',
          amountRecovered: 50000
        },
        correlationId: 'CORR_EXP_CASE_1'
      });

      // Add diagnosis trace for Case 1
      await createAgentTrace({
        merchantId: merchant1Id,
        caseId: m1Case1Id,
        traceRef: generateUlid(),
        agentType: 'diagnosis',
        status: 'success',
        correlationId: 'CORR_EXP_CASE_1',
        totalDurationMs: 450,
        totalInputTokens: 320,
        totalOutputTokens: 110,
        steps: [
          {
            stepNumber: 1,
            stepType: 'model_completion',
            promptId: 'diag_prompt_v1',
            promptVersion: '1.0.0',
            modelId: 'gpt-4o',
            durationMs: 450,
            inputTokens: 320,
            outputTokens: 110,
            validationStatus: 'passed',
            parsedOutput: {
              category: 'INSUFFICIENT_FUNDS',
              reasonCode: 'SOFT_DECLINE_BALANCE',
              rootCause: 'Account balance temporarily below total transaction amount',
              contributingFactors: ['Month-end salary delay', 'High ticket item'],
              recoverable: true,
              recommendedStrategy: 'DELAYED_RETRY',
              confidence: 0.92,
              explanation: 'The cardholder balance is insufficient but historically replenished within 48 hours.',
              evidence: ['Gateway code: 51', 'Customer tenure: 14 months'],
              provenance: {
                source: 'model',
                promptId: 'diag_prompt_v1',
                promptVersion: '1.0.0',
                modelId: 'gpt-4o',
                tokens: { inputTokens: 320, outputTokens: 110, totalTokens: 430 },
                latencyMs: 450,
                contextVersion: 'v1',
                rulesVersion: null,
                repairAttempted: false,
                fallbackReason: null
              }
            }
          }
        ]
      });

      // Add decision trace for Case 1
      await createAgentTrace({
        merchantId: merchant1Id,
        caseId: m1Case1Id,
        traceRef: generateUlid(),
        agentType: 'decision',
        status: 'success',
        correlationId: 'CORR_EXP_CASE_1',
        totalDurationMs: 380,
        totalInputTokens: 410,
        totalOutputTokens: 95,
        steps: [
          {
            stepNumber: 1,
            stepType: 'model_completion',
            promptId: 'dec_prompt_v1',
            promptVersion: '1.0.0',
            modelId: 'gpt-4o',
            durationMs: 380,
            inputTokens: 410,
            outputTokens: 95,
            validationStatus: 'passed',
            parsedOutput: {
              planRationale: 'Execute immediate retry followed by smart notification if secondary decline occurs.',
              actions: [
                {
                  actionType: 'RETRY_PAYMENT',
                  toolName: 'schedule_payment_retry',
                  scheduledDelaySeconds: 60,
                  costMinorUnits: 0,
                  incentivePercent: 0,
                  rationale: 'Immediate retry via primary payment method.',
                  parameters: { retryAttempt: 1 }
                }
              ],
              primaryAction: {
                actionType: 'RETRY_PAYMENT',
                toolName: 'schedule_payment_retry',
                scheduledDelaySeconds: 60,
                costMinorUnits: 0,
                incentivePercent: 0,
                rationale: 'Immediate retry via primary payment method.',
                parameters: { retryAttempt: 1 }
              },
              costOrderingRespect: true,
              provenance: {
                source: 'model',
                promptId: 'dec_prompt_v1',
                promptVersion: '1.0.0',
                modelId: 'gpt-4o',
                tokens: { inputTokens: 410, outputTokens: 95, totalTokens: 505 },
                latencyMs: 380,
                contextVersion: 'v1',
                diagnosisCategory: 'INSUFFICIENT_FUNDS',
                rulesVersion: null,
                repairAttempted: false,
                fallbackReason: null
              }
            }
          }
        ]
      });

      // -------------------------------------------------------------
      // Case 2: Minimal newly detected case (partial / missing components)
      // -------------------------------------------------------------
      const c2 = await createCaseWithEvent(
        merchant1Id,
        {
          orderId: m1Order2Id,
          recoverableAmount: 120000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILED',
          failureCategory: 'NETWORK_TIMEOUT',
          correlationId: 'CORR_EXP_CASE_2',
          initialStatus: 'detected'
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'payment_worker',
          reason: 'Network timeout during transaction routing',
          correlationId: 'CORR_EXP_CASE_2'
        }
      );
      m1Case2Id = c2.id;
      m1Case2Ref = c2.caseRef;

      // -------------------------------------------------------------
      // Case 3: Case with PII in reason string to verify deep redaction
      // -------------------------------------------------------------
      const c3 = await createCaseWithEvent(
        merchant1Id,
        {
          orderId: m1Order3Id,
          recoverableAmount: 75000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILED',
          failureCategory: 'CARD_EXPIRED',
          correlationId: 'CORR_EXP_CASE_3',
          initialStatus: 'detected'
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'payment_worker',
          reason: 'Initial gateway decline',
          correlationId: 'CORR_EXP_CASE_3'
        }
      );
      m1Case3Id = c3.id;
      m1Case3Ref = c3.caseRef;

      // Transition to failed with PII in reason
      await transitionCaseStatus(m1Case3Id, merchant1Id, {
        toStatus: 'failed',
        actorType: 'system',
        actorId: 'payment_worker',
        reason: 'Customer user_secret@example.com reported failure with card 4111111111111111 and phone +1-555-555-1234',
        payload: {
          customerEmail: 'user_secret@example.com',
          rawCardNum: '4111111111111111'
        },
        correlationId: 'CORR_EXP_CASE_3'
      });

      // -------------------------------------------------------------
      // Case for Merchant 2 (for tenant isolation testing)
      // -------------------------------------------------------------
      const cM2 = await createCaseWithEvent(
        merchant2Id,
        {
          orderId: m2OrderId,
          recoverableAmount: 88000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILED',
          failureCategory: 'AUTHENTICATION_FAILED',
          correlationId: 'CORR_EXP_CASE_M2',
          initialStatus: 'detected'
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'payment_worker',
          reason: '3D Secure OTP verification failed',
          correlationId: 'CORR_EXP_CASE_M2'
        }
      );
      m2CaseId = cM2.id;
      m2CaseRef = cM2.caseRef;
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    const conn = await pool.getConnection();
    try {
      if (merchant1Id) {
        await conn.query(`DELETE FROM users WHERE id IN (?, ?)`, [merchant1Id, merchant2Id]);
      }
    } finally {
      conn.release();
    }
    await disconnectRedis();
  });

  /* ------------------------------------------------------------------ */
  /*  1. Full Unified Explainability Payload (All Components Available) */
  /* ------------------------------------------------------------------ */

  describe('1. Full Unified Explainability Payload', () => {
    it('returns 200 with complete diagnosis, decision, policy, trace, and recoveryOutcome', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const payload: UnifiedExplainabilityPayload = await res.json();

      // Verify Case Identity
      expect(payload.case).toBeDefined();
      expect(payload.case.id).toBe(m1Case1Id);
      expect(payload.case.caseRef).toBe(m1Case1Ref);
      expect(payload.case.merchantId).toBe(merchant1Id);
      expect(payload.case.status).toBe('recovered');
      expect(payload.case.recoverableAmountMinorUnits).toBe(50000);
      expect(payload.case.currency).toBe('INR');
      expect(payload.case.failureCategory).toBe('INSUFFICIENT_FUNDS');
      expect(payload.case.correlationId).toBe('CORR_EXP_CASE_1');
      expect(payload.case.createdAt).toBeDefined();

      // Verify Recovery Outcome
      expect(payload.recoveryOutcome).toBeDefined();
      expect(payload.recoveryOutcome.status).toBe('recovered');
      expect(payload.recoveryOutcome.isTerminal).toBe(true);
      expect(payload.recoveryOutcome.recoveredAmountMinorUnits).toBe(50000);
      expect(payload.recoveryOutcome.terminalReason).toContain('Payment successfully captured');
      expect(payload.recoveryOutcome.completedAt).toBeDefined();

      // Verify Diagnosis Result
      expect(payload.diagnosis).not.toBeNull();
      expect(payload.diagnosis!.category).toBe('INSUFFICIENT_FUNDS');
      expect(payload.diagnosis!.rootCause).toContain('Account balance temporarily below');
      expect(payload.diagnosis!.recoverable).toBe(true);
      expect(payload.diagnosis!.confidence).toBe(0.92);
      expect(payload.diagnosis!.explanation).toContain('48 hours');
      expect(payload.diagnosis!.provenance.source).toBe('model');
      expect(payload.diagnosis!.provenance.modelId).toBe('gpt-4o');

      // Verify Decision Plan
      expect(payload.decision).not.toBeNull();
      expect(payload.decision!.planRationale).toContain('Execute immediate retry');
      expect(payload.decision!.actions).toHaveLength(1);
      expect(payload.decision!.primaryAction).toBeDefined();
      expect(payload.decision!.primaryAction!.actionType).toBe('RETRY_PAYMENT');
      expect(payload.decision!.primaryAction!.costMinorUnits).toBe(0);

      // Verify Deterministic Policy Evaluation & Governing Rules
      expect(payload.policy).not.toBeNull();
      expect(payload.policy!.evaluation).toBeDefined();
      expect(payload.policy!.evaluation!.decision).toBe('APPROVED');
      expect(payload.policy!.evaluation!.ruleId).toBe('RULE_RETRY_LIMIT');
      expect(payload.policy!.evaluation!.evaluatedTier).toBe('T2');

      expect(payload.policy!.governingPolicy).toBeDefined();
      expect(payload.policy!.governingPolicy!.autonomyTier).toBe('T2');
      expect(payload.policy!.governingPolicy!.maxRetries).toBe(3);
      expect(payload.policy!.governingPolicy!.isActive).toBe(true);

      // Verify Agent Reasoning Traces
      expect(payload.trace).not.toBeNull();
      expect(payload.trace!.primaryTraceRef).toBeDefined();
      expect(payload.trace!.traces).toHaveLength(2); // diagnosis + decision traces
      expect(payload.trace!.summary).toBeDefined();
      expect(payload.trace!.summary!.status).toBe('success');
    });

    it('resolves identically using external ULID case reference (caseRef)', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Ref}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const payload: UnifiedExplainabilityPayload = await res.json();
      expect(payload.case.id).toBe(m1Case1Id);
      expect(payload.case.caseRef).toBe(m1Case1Ref);
      expect(payload.recoveryOutcome.status).toBe('recovered');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Partial / Missing Components (Graceful Degradation)            */
  /* ------------------------------------------------------------------ */

  describe('2. Partial / Missing Components', () => {
    it('handles newly detected case gracefully with null diagnosis, decision, and trace', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case2Id}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const payload: UnifiedExplainabilityPayload = await res.json();

      // Case & outcome populated
      expect(payload.case.id).toBe(m1Case2Id);
      expect(payload.case.status).toBe('detected');
      expect(payload.recoveryOutcome.status).toBe('detected');
      expect(payload.recoveryOutcome.isTerminal).toBe(false);
      expect(payload.recoveryOutcome.recoveredAmountMinorUnits).toBeNull();
      expect(payload.recoveryOutcome.completedAt).toBeNull();

      // Missing components return null gracefully
      expect(payload.diagnosis).toBeNull();
      expect(payload.decision).toBeNull();
      expect(payload.trace).toBeNull();

      // Governing policy is still available from merchant active policy
      expect(payload.policy).toBeDefined();
      expect(payload.policy!.governingPolicy).toBeDefined();
      expect(payload.policy!.governingPolicy!.autonomyTier).toBe('T2');
      expect(payload.policy!.evaluation).toBeNull();
    });

    it('supports retrieval of partial case by string caseRef', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case2Ref}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const payload: UnifiedExplainabilityPayload = await res.json();
      expect(payload.case.id).toBe(m1Case2Id);
      expect(payload.case.caseRef).toBe(m1Case2Ref);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Tenant Isolation & Security Boundary (SEC-002)                 */
  /* ------------------------------------------------------------------ */

  describe('3. Tenant Isolation & Authorization', () => {
    it('returns 404 when Merchant 2 attempts to access Merchant 1 case by numeric ID', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, {
        headers: { Authorization: `Bearer ${token2}` }
      });

      expect(res.status).toBe(404);
      const err = await res.json();
      expect(err.error?.code ?? err.code).toBe('CASE_NOT_FOUND');
    });

    it('returns 404 when Merchant 2 attempts to access Merchant 1 case by caseRef', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Ref}/explainability`, {
        headers: { Authorization: `Bearer ${token2}` }
      });

      expect(res.status).toBe(404);
      const err = await res.json();
      expect(err.error?.code ?? err.code).toBe('CASE_NOT_FOUND');
    });

    it('returns 404 when Merchant 1 attempts to access Merchant 2 case by numeric ID', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m2CaseId}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(404);
      const err = await res.json();
      expect(err.error?.code ?? err.code).toBe('CASE_NOT_FOUND');
    });

    it('returns 404 when Merchant 1 attempts to access Merchant 2 case by caseRef', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m2CaseRef}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(404);
      const err = await res.json();
      expect(err.error?.code ?? err.code).toBe('CASE_NOT_FOUND');
    });

    it('returns 404 for nonexistent case ID', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/99999999/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(404);
      const err = await res.json();
      expect(err.error?.code ?? err.code).toBe('CASE_NOT_FOUND');
    });

    it('returns 404 for nonexistent case reference string', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/01NONEXISTENTREF0000000/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(404);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`);
      expect(res.status).toBe(401);
    });

    it('returns 401 when Authorization token is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, {
        headers: { Authorization: 'Bearer invalid.token.payload' }
      });
      expect(res.status).toBe(401);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. PII Minimisation & Redaction (SEC-002 / AI-009)                */
  /* ------------------------------------------------------------------ */

  describe('4. PII Minimisation & Redaction', () => {
    it('redacts sensitive customer PII from reason strings and event payloads', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case3Id}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const payload: UnifiedExplainabilityPayload = await res.json();

      const rawJson = JSON.stringify(payload);

      // Raw credentials and card PANs must NEVER appear in the response payload
      expect(rawJson).not.toContain('user_secret@example.com');
      expect(rawJson).not.toContain('4111111111111111');
      expect(rawJson).not.toContain('+1-555-555-1234');

      // Redacted replacement tokens should appear
      expect(rawJson).toContain('[EMAIL_REDACTED]');
      expect(rawJson).toContain('[CARD_REDACTED]');
      expect(rawJson).toContain('[PHONE_REDACTED]');

      // assertZeroPII validator must pass cleanly on the returned payload
      expect(() => assertZeroPII(payload)).not.toThrow();
    });

    it('supports retrieval of PII-sanitized case by string caseRef', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case3Ref}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const payload: UnifiedExplainabilityPayload = await res.json();
      expect(payload.case.id).toBe(m1Case3Id);
      expect(payload.case.caseRef).toBe(m1Case3Ref);
      expect(() => assertZeroPII(payload)).not.toThrow();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. Read-Only Invariance & Financial Integrity                     */
  /* ------------------------------------------------------------------ */

  describe('5. Read-Only Invariance & Money Representation', () => {
    it('does not mutate case status, timeline, or database state on explainability requests', async () => {
      const [beforeRows] = await pool.query<RowDataPacket[]>(
        `SELECT status, updated_at FROM cases WHERE id = ?`,
        [m1Case1Id]
      );
      const [beforeEvents] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) as count FROM case_events WHERE case_id = ?`,
        [m1Case1Id]
      );

      // Execute 3 concurrent GET requests
      await Promise.all([
        fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, { headers: { Authorization: `Bearer ${token1}` } }),
        fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, { headers: { Authorization: `Bearer ${token1}` } }),
        fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, { headers: { Authorization: `Bearer ${token1}` } })
      ]);

      const [afterRows] = await pool.query<RowDataPacket[]>(
        `SELECT status, updated_at FROM cases WHERE id = ?`,
        [m1Case1Id]
      );
      const [afterEvents] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) as count FROM case_events WHERE case_id = ?`,
        [m1Case1Id]
      );

      expect(afterRows[0]?.status).toBe(beforeRows[0]?.status);
      expect(afterEvents[0]?.count).toBe(beforeEvents[0]?.count);
    });

    it('preserves integer minor units for all monetary values without floats', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      const payload: UnifiedExplainabilityPayload = await res.json();

      expect(Number.isInteger(payload.case.recoverableAmountMinorUnits)).toBe(true);
      expect(Number.isInteger(payload.recoveryOutcome.recoveredAmountMinorUnits!)).toBe(true);
      expect(Number.isInteger(payload.policy!.governingPolicy!.dailyBudgetMinorUnits)).toBe(true);
      expect(Number.isInteger(payload.decision!.primaryAction!.costMinorUnits)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  6. OpenAPI Specification Alignment                                */
  /* ------------------------------------------------------------------ */

  describe('6. OpenAPI Specification Alignment', () => {
    it('documents /recovery/cases/{idOrRef}/explainability in docs/openapi.yaml', () => {
      const openApiPath = fs.existsSync(path.join(process.cwd(), 'docs/openapi.yaml'))
        ? path.join(process.cwd(), 'docs/openapi.yaml')
        : path.resolve(process.cwd(), '../docs/openapi.yaml');
      const doc = YAML.load(openApiPath);

      const explainPath = doc.paths['/recovery/cases/{idOrRef}/explainability'];
      expect(explainPath).toBeDefined();
      expect(explainPath.get).toBeDefined();
      expect(explainPath.get.summary).toBeDefined();
      expect(explainPath.get.responses['200']).toBeDefined();

      const schemas = doc.components.schemas;
      expect(schemas.UnifiedExplainabilityPayload).toBeDefined();
      expect(schemas.CaseIdentitySummary).toBeDefined();
      expect(schemas.RecoveryOutcomeSummary).toBeDefined();
      expect(schemas.GoverningPolicySummary).toBeDefined();
      expect(schemas.PolicyExplanation).toBeDefined();
      expect(schemas.TraceExplanation).toBeDefined();
      expect(schemas.TraceItemSummary).toBeDefined();
    });
  });
});
