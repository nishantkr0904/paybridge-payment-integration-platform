import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { signAccessToken } from '../../utils/token.js';
import { evaluatePolicy, isWithinQuietHours } from '../../modules/policy/policy.engine.js';
import { createPolicy } from '../../modules/policy/policy.repository.js';
import { evaluateProposedAction } from '../../modules/policy/policy.service.js';
import type { Policy, ProposedAction } from '../../modules/policy/policy.types.js';

describe('TASK-202: Deterministic Policy Engine Evaluation (POL-002 / AT-POL-001)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchantId: number;
  let foreignMerchantId: number;
  let token: string;
  let foreignToken: string;

  const samplePolicy: Policy = {
    id: 101,
    merchantId: 1,
    autonomyTier: 'T3',
    maxRetries: 3,
    maxContactsPerCustomerPerWeek: 3,
    dailyBudgetMinorUnits: 100000, // ₹1,000.00
    maxIncentivePercent: 10.0,
    quietHoursStart: '22:00:00',
    quietHoursEnd: '08:00:00',
    timezone: 'UTC',
    isActive: true,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      const email1 = `pol_engine_m1_${Date.now()}@example.com`;
      const email2 = `pol_engine_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Policy Engine M1', 'active')`,
        [email1]
      );
      merchantId = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Policy Engine M2', 'active')`,
        [email2]
      );
      foreignMerchantId = (res2 as unknown as { insertId: number }).insertId;
    } finally {
      conn.release();
    }

    token = signAccessToken({
      id: merchantId,
      email: 'm1@example.com',
      merchantName: 'Policy Engine M1',
      roles: ['merchant']
    });

    foreignToken = signAccessToken({
      id: foreignMerchantId,
      email: 'm2@example.com',
      merchantName: 'Policy Engine M2',
      roles: ['merchant']
    });

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    const conn = await pool.getConnection();
    try {
      if (merchantId) await conn.query('DELETE FROM users WHERE id = ?', [merchantId]);
      if (foreignMerchantId) await conn.query('DELETE FROM users WHERE id = ?', [foreignMerchantId]);
    } finally {
      conn.release();
    }

    await disconnectRedis();
  });

  describe('1. Pure Deterministic Core & Rule Evaluations', () => {
    it('approves a valid retry action within policy caps at tier T3', () => {
      const action: ProposedAction = {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01TESTORDER0000000000000001'
      };

      const result = evaluatePolicy(samplePolicy, action, {
        currentRetryCount: 1,
        evaluationTime: new Date('2026-09-03T12:00:00Z')
      });

      expect(result.decision).toBe('APPROVED');
      expect(result.reasonCode).toBe('ACTION_APPROVED');
      expect(result.ruleId).toBe('RULE_ALL_CHECKS_PASSED');
      expect(result.policyVersion).toBe(1);
      expect(result.policyId).toBe(101);
      expect(result.evaluatedTier).toBe('T3');
    });

    it('rejects proposed retry when max_retries limit is reached', () => {
      const action: ProposedAction = {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01TESTORDER0000000000000001'
      };

      const result = evaluatePolicy(samplePolicy, action, {
        currentRetryCount: 3 // maxRetries is 3
      });

      expect(result.decision).toBe('REJECTED');
      expect(result.reasonCode).toBe('MAX_RETRIES_EXCEEDED');
      expect(result.ruleId).toBe('RULE_MAX_RETRIES');
    });

    it('rejects customer outreach when contact frequency cap is reached', () => {
      const action: ProposedAction = {
        actionType: 'CUSTOMER_OUTREACH',
        caseRef: '01TESTCASE0000000000000001'
      };

      const result = evaluatePolicy(samplePolicy, action, {
        contactsThisWeek: 3, // maxContacts is 3
        evaluationTime: new Date('2026-09-03T14:00:00Z')
      });

      expect(result.decision).toBe('REJECTED');
      expect(result.reasonCode).toBe('CONTACT_FATIGUE_EXCEEDED');
      expect(result.ruleId).toBe('RULE_CONTACT_FREQUENCY');
    });

    it('rejects incentive when proposed incentive percentage exceeds policy cap', () => {
      const action: ProposedAction = {
        actionType: 'OFFER_INCENTIVE',
        incentivePercent: 15.0 // max is 10.0%
      };

      const result = evaluatePolicy(samplePolicy, action);

      expect(result.decision).toBe('REJECTED');
      expect(result.reasonCode).toBe('MAX_INCENTIVE_EXCEEDED');
      expect(result.ruleId).toBe('RULE_MAX_INCENTIVE');
    });

    it('rejects action when proposed cost exceeds daily budget in minor units', () => {
      const action: ProposedAction = {
        actionType: 'OFFER_INCENTIVE',
        costMinorUnits: 60000,
        incentivePercent: 5.0
      };

      const result = evaluatePolicy(samplePolicy, action, {
        dailySpentMinorUnits: 50000 // total 110,000 > daily budget 100,000
      });

      expect(result.decision).toBe('REJECTED');
      expect(result.reasonCode).toBe('DAILY_BUDGET_EXHAUSTED');
      expect(result.ruleId).toBe('RULE_DAILY_BUDGET');
    });

    it('rejects outreach during quiet hours with midnight crossover', () => {
      const action: ProposedAction = {
        actionType: 'CUSTOMER_OUTREACH',
        caseRef: '01TESTCASE0000000000000001'
      };

      // 23:30 UTC falls within quiet hours (22:00 - 08:00 UTC)
      const resultInQuiet = evaluatePolicy(samplePolicy, action, {
        evaluationTime: new Date('2026-09-03T23:30:00Z'),
        contactsThisWeek: 1
      });

      expect(resultInQuiet.decision).toBe('REJECTED');
      expect(resultInQuiet.reasonCode).toBe('QUIET_HOURS_RESTRICTION');
      expect(resultInQuiet.ruleId).toBe('RULE_QUIET_HOURS');

      // 14:00 UTC is outside quiet hours
      const resultOutsideQuiet = evaluatePolicy(samplePolicy, action, {
        evaluationTime: new Date('2026-09-03T14:00:00Z'),
        contactsThisWeek: 1
      });

      expect(resultOutsideQuiet.decision).toBe('APPROVED');
    });

    it('calculates quiet hours correctly for non-UTC timezone', () => {
      const istPolicy: Policy = {
        ...samplePolicy,
        timezone: 'Asia/Kolkata',
        quietHoursStart: '22:00:00',
        quietHoursEnd: '08:00:00'
      };

      // 17:00 UTC is 22:30 IST -> inside quiet hours
      const inQuiet = isWithinQuietHours(
        new Date('2026-09-03T17:00:00Z'),
        istPolicy.quietHoursStart!,
        istPolicy.quietHoursEnd!,
        istPolicy.timezone
      );
      expect(inQuiet).toBe(true);

      // 06:00 UTC is 11:30 IST -> outside quiet hours
      const outQuiet = isWithinQuietHours(
        new Date('2026-09-03T06:00:00Z'),
        istPolicy.quietHoursStart!,
        istPolicy.quietHoursEnd!,
        istPolicy.timezone
      );
      expect(outQuiet).toBe(false);
    });

    it('enforces Invariant I10: strictly blocks retry on terminal failure under T4', () => {
      const t4Policy: Policy = {
        ...samplePolicy,
        autonomyTier: 'T4'
      };

      const retryAction: ProposedAction = {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01TESTORDER0000000000000001'
      };

      const result = evaluatePolicy(t4Policy, retryAction, {
        isTerminalFailure: true,
        failureCategory: 'ISSUER_HARD_DECLINE'
      });

      expect(result.decision).toBe('REJECTED');
      expect(result.reasonCode).toBe('TERMINAL_FAILURE_RETRY_BLOCKED');
      expect(result.ruleId).toBe('RULE_TERMINAL_FAILURE_PROTECTION');
    });

    it('escalates to REQUIRES_HUMAN for tiers T1 (Suggest) and T2 (Approve)', () => {
      const t1Policy: Policy = { ...samplePolicy, autonomyTier: 'T1' };
      const t2Policy: Policy = { ...samplePolicy, autonomyTier: 'T2' };

      const action: ProposedAction = {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01TESTORDER0000000000000001'
      };

      const resT1 = evaluatePolicy(t1Policy, action);
      expect(resT1.decision).toBe('REQUIRES_HUMAN');
      expect(resT1.reasonCode).toBe('REQUIRES_HUMAN_APPROVAL');
      expect(resT1.ruleId).toBe('RULE_HUMAN_APPROVAL_REQUIRED');

      const resT2 = evaluatePolicy(t2Policy, action);
      expect(resT2.decision).toBe('REQUIRES_HUMAN');
      expect(resT2.reasonCode).toBe('REQUIRES_HUMAN_APPROVAL');
    });

    it('rejects automated action under tier T0 (Observe)', () => {
      const t0Policy: Policy = { ...samplePolicy, autonomyTier: 'T0' };

      const action: ProposedAction = {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01TESTORDER0000000000000001'
      };

      const res = evaluatePolicy(t0Policy, action);
      expect(res.decision).toBe('REJECTED');
      expect(res.reasonCode).toBe('TIER_OBSERVE_ONLY');
      expect(res.ruleId).toBe('RULE_AUTONOMY_TIER_T0');
    });

    it('supports global kill switch tier override min(merchantTier, globalTier)', () => {
      const t4Policy: Policy = { ...samplePolicy, autonomyTier: 'T4' };

      const action: ProposedAction = {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01TESTORDER0000000000000001'
      };

      // Global kill switch engaged to T0
      const res = evaluatePolicy(t4Policy, action, {
        globalAutonomyTier: 'T0'
      });

      expect(res.decision).toBe('REJECTED');
      expect(res.reasonCode).toBe('TIER_OBSERVE_ONLY');
      expect(res.evaluatedTier).toBe('T0');
    });

    it('fails closed when policy is null, undefined, or inactive', () => {
      const action: ProposedAction = { actionType: 'RETRY_PAYMENT' };

      const resNull = evaluatePolicy(null, action);
      expect(resNull.decision).toBe('REJECTED');
      expect(resNull.reasonCode).toBe('POLICY_INACTIVE_OR_MISSING');
      expect(resNull.ruleId).toBe('RULE_FAIL_CLOSED');

      const resInactive = evaluatePolicy({ ...samplePolicy, isActive: false }, action);
      expect(resInactive.decision).toBe('REJECTED');
      expect(resInactive.reasonCode).toBe('POLICY_INACTIVE_OR_MISSING');
    });

    it('is 100% deterministic and repeatable over identical inputs', () => {
      const action: ProposedAction = {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01REPLAYTEST000000000000001'
      };
      const context = {
        currentRetryCount: 1,
        evaluationTime: new Date('2026-09-03T15:30:00.000Z'),
        correlationId: '01REPLAYCORR000000000000001'
      };

      const run1 = evaluatePolicy(samplePolicy, action, context);
      const run2 = evaluatePolicy(samplePolicy, action, context);
      const run3 = evaluatePolicy(samplePolicy, action, context);

      expect(run1).toEqual(run2);
      expect(run2).toEqual(run3);
    });
  });

  describe('2. Service-Level & API Evaluation Integration', () => {
    beforeAll(async () => {
      // Create a real active T3 policy in the database for merchantId
      await createPolicy(merchantId, {
        autonomyTier: 'T3',
        maxRetries: 4,
        maxContactsPerCustomerPerWeek: 5,
        dailyBudgetMinorUnits: 200000,
        maxIncentivePercent: 15.0,
        timezone: 'UTC',
        isActive: true
      });
    });

    it('evaluates proposed action through service layer using active merchant policy', async () => {
      const result = await evaluateProposedAction(merchantId, {
        actionType: 'RETRY_PAYMENT',
        orderRef: '01SRVTEST0000000000000001'
      }, {
        currentRetryCount: 2
      });

      expect(result.decision).toBe('APPROVED');
      expect(result.policyVersion).toBeDefined();
      expect(result.evaluatedTier).toBe('T3');
    });

    it('POST /api/merchants/policies/evaluate returns typed decision with correlation ID', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-correlation-id': '01HCORRTEST000000000000001'
        },
        body: JSON.stringify({
          action: {
            actionType: 'RETRY_PAYMENT',
            orderRef: '01APIORDERTEST00000000001'
          },
          context: {
            currentRetryCount: 1
          }
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.decision).toBe('APPROVED');
      expect(data.reasonCode).toBe('ACTION_APPROVED');
      expect(data.correlationId).toBe('01HCORRTEST000000000000001');
      expect(data.evaluatedTier).toBe('T3');
    });

    it('POST /api/merchants/policies/evaluate rejects invalid action type with HTTP 400', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: {
            actionType: 'UNSUPPORTED_ACTION_TYPE'
          }
        })
      });

      expect(res.status).toBe(400);
    });

    it('fails closed with REJECTED when evaluating for a merchant without an active policy', async () => {
      // foreignMerchant has no policy created yet -> evaluates to REJECTED (fail-closed)
      const res = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${foreignToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: {
            actionType: 'RETRY_PAYMENT'
          },
          context: {
            currentRetryCount: 0
          }
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.decision).toBe('REJECTED');
      expect(data.reasonCode).toBe('POLICY_INACTIVE_OR_MISSING');
    });

    it('preserves tenant isolation: foreign merchant evaluates against its own policy rather than merchant 1', async () => {
      // Create T1 policy for foreign merchant
      await createPolicy(foreignMerchantId, {
        autonomyTier: 'T1',
        isActive: true
      });

      const res = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${foreignToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: {
            actionType: 'RETRY_PAYMENT'
          },
          context: {
            currentRetryCount: 0
          }
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      // Foreign merchant evaluates against their own T1 policy -> REQUIRES_HUMAN (not Merchant 1's T3 APPROVED)
      expect(data.decision).toBe('REQUIRES_HUMAN');
      expect(data.evaluatedTier).toBe('T1');
      expect(data.reasonCode).toBe('REQUIRES_HUMAN_APPROVAL');
    });
  });
});
