import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { closePool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { seedOperatorDemo } from '../../demo/seed-operator-demo.js';

describe('Task 1 Verification: Seed Operator Demo', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await connectRedis();

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectRedis();
    await closePool();
  });

  let operatorToken = '';

  async function getOperatorToken(): Promise<string> {
    if (operatorToken) return operatorToken;
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'operator@paybridge.test',
        password: 'Operator123!'
      })
    });
    if (!loginRes.ok) {
      const errText = await loginRes.text();
      throw new Error(`Login failed with ${loginRes.status}: ${errText}`);
    }
    const body = (await loginRes.json()) as { accessToken: string };
    operatorToken = body.accessToken;
    return operatorToken;
  }

  it('1. seeds demo operator and cases idempotently on multiple runs', async () => {
    const run1 = await seedOperatorDemo();
    expect(run1.email).toBe('operator@paybridge.test');
    expect(run1.role).toBe('merchant_operator');
    expect(run1.cases.awaitingApprovalCaseRef).toBe('CASE_DEMO_OP_AWAITING_001');

    const run2 = await seedOperatorDemo();
    expect(run2.merchantId).toBe(run1.merchantId);
    expect(run2.policyId).toBe(run1.policyId);
    expect(run2.cases.awaitingApprovalCaseId).toBe(run1.cases.awaitingApprovalCaseId);
    expect(run2.cases.recoveredCaseId).toBe(run1.cases.recoveredCaseId);
    expect(run2.cases.suppressedCaseId).toBe(run1.cases.suppressedCaseId);
  });

  it('2. authenticates via POST /api/auth/login and receives merchant_operator role', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'operator@paybridge.test',
        password: 'Operator123!'
      })
    });

    expect(loginRes.status).toBe(200);
    const body = (await loginRes.json()) as {
      user: { id: number; email: string; roles: string[] };
      accessToken: string;
    };

    expect(body.user.email).toBe('operator@paybridge.test');
    expect(body.user.roles).toContain('merchant_operator');
    expect(body.accessToken).toBeTruthy();
    operatorToken = body.accessToken;
  });

  it('3. accesses GET /api/recovery/cases using the operator bearer token and finds the 3 seeded cases', async () => {
    const accessToken = await getOperatorToken();

    const casesRes = await fetch(`${baseUrl}/api/recovery/cases`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    expect(casesRes.status).toBe(200);
    const casesBody = (await casesRes.json()) as {
      cases: Array<{ caseRef: string; status: string; recoverableAmount: number; failureCategory: string }>;
      total: number;
    };

    expect(casesBody.total).toBe(3);
    const caseRefs = casesBody.cases.map((c) => c.caseRef);
    expect(caseRefs).toContain('CASE_DEMO_OP_AWAITING_001');
    expect(caseRefs).toContain('CASE_DEMO_OP_RECOVERED_002');
    expect(caseRefs).toContain('CASE_DEMO_OP_SUPPRESS_003');

    const awaitingCase = casesBody.cases.find((c) => c.caseRef === 'CASE_DEMO_OP_AWAITING_001');
    expect(awaitingCase?.status).toBe('awaiting_approval');
    expect(awaitingCase?.recoverableAmount).toBe(45000);
    expect(awaitingCase?.failureCategory).toBe('INSUFFICIENT_FUNDS');
  });

  it('4. accesses GET /api/recovery/cases/:idOrRef/explainability and receives structured diagnosis, decision, and policy', async () => {
    const accessToken = await getOperatorToken();

    const explainRes = await fetch(
      `${baseUrl}/api/recovery/cases/CASE_DEMO_OP_AWAITING_001/explainability`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    expect(explainRes.status).toBe(200);
    const explainPayload = (await explainRes.json()) as {
      case: { caseRef: string; status: string; recoverableAmountMinorUnits: number };
      diagnosis: { category: string; rootCause: string; confidence: number };
      decision: { planRationale: string; primaryAction: { actionType: string; toolName: string; incentivePercent: number } };
      policy: { evaluation: { decision: string; ruleId: string }; governingPolicy: { autonomyTier: string } };
      trace: { summary: unknown; traces: unknown[] };
    };

    // Verify Case Identity
    expect(explainPayload.case.caseRef).toBe('CASE_DEMO_OP_AWAITING_001');
    expect(explainPayload.case.status).toBe('awaiting_approval');
    expect(explainPayload.case.recoverableAmountMinorUnits).toBe(45000);

    // Verify Structured Diagnosis
    expect(explainPayload.diagnosis).toBeTruthy();
    expect(explainPayload.diagnosis.category).toBe('INSUFFICIENT_FUNDS');
    expect(explainPayload.diagnosis.rootCause).toContain('Customer account balance was insufficient');
    expect(explainPayload.diagnosis.confidence).toBe(0.92);

    // Verify Decision & Proposed Action
    expect(explainPayload.decision).toBeTruthy();
    expect(explainPayload.decision.primaryAction).toBeTruthy();
    expect(explainPayload.decision.primaryAction.actionType).toBe('OFFER_INCENTIVE');
    expect(explainPayload.decision.primaryAction.toolName).toBe('send_recovery_link');
    expect(explainPayload.decision.primaryAction.incentivePercent).toBe(5.0);

    // Verify Governing Policy & Evaluation
    expect(explainPayload.policy).toBeTruthy();
    expect(explainPayload.policy.governingPolicy.autonomyTier).toBe('T2');
    expect(explainPayload.policy.evaluation.decision).toBe('REQUIRES_HUMAN');
    expect(explainPayload.policy.evaluation.ruleId).toBe('RULE_TIER_T2_INCENTIVE_APPROVAL');

    // Verify Traces
    expect(explainPayload.trace).toBeTruthy();
    expect(explainPayload.trace.traces.length).toBeGreaterThanOrEqual(1);
  });

  it('5. accesses GET /api/recovery/analytics and receives expected recovery counts and rates', async () => {
    const accessToken = await getOperatorToken();

    const analyticsRes = await fetch(`${baseUrl}/api/recovery/analytics`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    expect(analyticsRes.status).toBe(200);
    const analytics = (await analyticsRes.json()) as {
      counts: { totalCases: number; eligibleCases: number; inFlightCases: number; successfulRecoveries: number };
      revenue: { recoveredRevenueMinorUnits: number; addressableMinorUnits: number };
      rates: { revenueRecoveryRate: number };
    };

    expect(analytics.counts.totalCases).toBe(3);
    expect(analytics.counts.eligibleCases).toBe(2);
    expect(analytics.counts.successfulRecoveries).toBe(1);
    expect(analytics.counts.inFlightCases).toBe(1);
    expect(analytics.revenue.recoveredRevenueMinorUnits).toBe(12000);
    expect(analytics.revenue.addressableMinorUnits).toBe(57000);
    expect(analytics.rates.revenueRecoveryRate).toBeCloseTo(0.2105, 2);
  });
});
