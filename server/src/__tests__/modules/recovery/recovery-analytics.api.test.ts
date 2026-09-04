import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import YAML from 'yamljs';
import path from 'node:path';
import { createApp } from '../../../app.js';
import { pool } from '../../../config/database.js';
import { connectRedis, disconnectRedis } from '../../../infrastructure/redis.js';
import { signAccessToken } from '../../../utils/token.js';
import { generateUlid } from '../../../utils/ulid.js';
import {
  createCaseWithEvent,
  transitionCaseStatus
} from '../../../modules/recovery/case.repository.js';
import type { RecoveryAnalytics } from '../../../modules/recovery/analytics.types.js';

describe('BT-C2: Recovery Analytics HTTP API (GET /api/recovery/analytics)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;

  let m1Order1Id: number;
  let m1Order2Id: number;
  let m1Order3Id: number;
  let m1Order4Id: number;

  beforeAll(async () => {
    await connectRedis();

    const app = createApp();
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;

    const conn = await pool.getConnection();
    try {
      const email1 = `analytics_api_m1_${Date.now()}@example.com`;
      const email2 = `analytics_api_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Analytics Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Analytics Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (res2 as unknown as { insertId: number }).insertId;

      token1 = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Analytics Merchant 1',
        roles: ['merchant']
      });

      token2 = signAccessToken({
        id: merchant2Id,
        email: email2,
        merchantName: 'Analytics Merchant 2',
        roles: ['merchant']
      });

      // Seed orders for Merchant 1
      const [ord1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ORD_ANLTC_API_0001', 50000, 'INR', 'failed')`,
        [merchant1Id]
      );
      m1Order1Id = (ord1 as unknown as { insertId: number }).insertId;

      const [ord2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ORD_ANLTC_API_0002', 150000, 'INR', 'failed')`,
        [merchant1Id]
      );
      m1Order2Id = (ord2 as unknown as { insertId: number }).insertId;

      const [ord3] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ORD_ANLTC_API_0003', 250000, 'INR', 'failed')`,
        [merchant1Id]
      );
      m1Order3Id = (ord3 as unknown as { insertId: number }).insertId;

      const [ord4] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ORD_ANLTC_API_0004', 75000, 'INR', 'failed')`,
        [merchant1Id]
      );
      m1Order4Id = (ord4 as unknown as { insertId: number }).insertId;

      // Seed order for Merchant 2
      await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ORD_ANLTC_API_M2_01', 80000, 'INR', 'failed')`,
        [merchant2Id]
      );

      // Case 1: Merchant 1, Addressable (INSUFFICIENT_FUNDS), 50000 INR -> executing (RETRY_PAYMENT) -> recovered
      const c1 = await createCaseWithEvent(
        merchant1Id,
        {
          orderId: m1Order1Id,
          recoverableAmount: 50000,
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'INSUFFICIENT_FUNDS',
          correlationId: generateUlid(),
          initialStatus: 'deciding'
        },
        {
          fromStatus: null,
          toStatus: 'deciding',
          actorType: 'system',
          correlationId: generateUlid()
        }
      );
      await transitionCaseStatus(c1.id, merchant1Id, {
        toStatus: 'executing',
        actorType: 'system',
        actorId: 'action_worker',
        payload: { actionType: 'RETRY_PAYMENT', retryAttempt: 1 },
        correlationId: generateUlid()
      });
      await transitionCaseStatus(c1.id, merchant1Id, {
        toStatus: 'recovered',
        actorType: 'system',
        actorId: 'action_worker',
        reason: 'Captured by action worker',
        payload: { amountRecovered: 50000, retryAttempt: 1, actionType: 'RETRY_PAYMENT' },
        correlationId: generateUlid()
      });

      // Case 2: Merchant 1, Addressable (GATEWAY_TIMEOUT), 150000 INR -> Multi-attempt -> recovered
      const c2 = await createCaseWithEvent(
        merchant1Id,
        {
          orderId: m1Order2Id,
          recoverableAmount: 150000,
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'GATEWAY_TIMEOUT',
          correlationId: generateUlid(),
          initialStatus: 'deciding'
        },
        {
          fromStatus: null,
          toStatus: 'deciding',
          actorType: 'system',
          correlationId: generateUlid()
        }
      );
      await transitionCaseStatus(c2.id, merchant1Id, {
        toStatus: 'executing',
        actorType: 'system',
        actorId: 'action_worker',
        payload: { actionType: 'RETRY_PAYMENT', retryAttempt: 1 },
        correlationId: generateUlid()
      });
      await transitionCaseStatus(c2.id, merchant1Id, {
        toStatus: 'awaiting_outcome',
        actorType: 'system',
        reason: 'Scheduled delayed retry',
        correlationId: generateUlid()
      });
      await transitionCaseStatus(c2.id, merchant1Id, {
        toStatus: 'executing',
        actorType: 'system',
        actorId: 'action_worker',
        payload: { actionType: 'DELAYED_RETRY', retryAttempt: 2 },
        correlationId: generateUlid()
      });
      await transitionCaseStatus(c2.id, merchant1Id, {
        toStatus: 'recovered',
        actorType: 'system',
        actorId: 'action_worker',
        reason: 'Captured on retry',
        payload: { amountRecovered: 150000, retryAttempt: 2, actionType: 'DELAYED_RETRY' },
        correlationId: generateUlid()
      });

      // Case 3: Merchant 1, Addressable (AUTHENTICATION_FAILURE), 250000 INR -> CUSTOMER_OUTREACH -> unrecovered
      const c3 = await createCaseWithEvent(
        merchant1Id,
        {
          orderId: m1Order3Id,
          recoverableAmount: 250000,
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'AUTHENTICATION_FAILURE',
          correlationId: generateUlid(),
          initialStatus: 'deciding'
        },
        {
          fromStatus: null,
          toStatus: 'deciding',
          actorType: 'system',
          correlationId: generateUlid()
        }
      );
      await transitionCaseStatus(c3.id, merchant1Id, {
        toStatus: 'executing',
        actorType: 'system',
        actorId: 'action_worker',
        payload: { actionType: 'CUSTOMER_OUTREACH', retryAttempt: 1 },
        correlationId: generateUlid()
      });
      await transitionCaseStatus(c3.id, merchant1Id, {
        toStatus: 'unrecovered',
        actorType: 'system',
        reason: 'Outreach expired',
        correlationId: generateUlid()
      });

      // Case 4: Merchant 1, Ineligible (ISSUER_HARD_DECLINE), 75000 INR -> suppressed
      await createCaseWithEvent(
        merchant1Id,
        {
          orderId: m1Order4Id,
          recoverableAmount: 75000,
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'ISSUER_HARD_DECLINE',
          correlationId: generateUlid(),
          initialStatus: 'suppressed'
        },
        {
          fromStatus: null,
          toStatus: 'suppressed',
          actorType: 'system',
          reason: 'Hard decline',
          correlationId: generateUlid()
        }
      );

      // Adjust timestamps on Case 1 and Case 2 to simulate measurable latency
      await conn.query(
        `UPDATE cases SET created_at = NOW() - INTERVAL 45 SECOND WHERE id = ?`,
        [c1.id]
      );
      await conn.query(
        `UPDATE cases SET created_at = NOW() - INTERVAL 120 SECOND WHERE id = ?`,
        [c2.id]
      );
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

  /* ---------------------------------------------------------------- */
  /*  Core Analytics Endpoint Tests                                   */
  /* ---------------------------------------------------------------- */

  describe('1. Successful Analytics Retrieval & KPI Integrity', () => {
    it('returns HTTP 200 with complete recovery analytics for authenticated merchant', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;

      expect(data.merchantId).toBe(merchant1Id);
      expect(data.currency).toBe('INR');

      // Volume counts
      expect(data.counts.totalCases).toBe(4);
      expect(data.counts.eligibleCases).toBe(3);
      expect(data.counts.ineligibleCases).toBe(1);
      expect(data.counts.successfulRecoveries).toBe(2);
      expect(data.counts.unrecoveredCases).toBe(1);
      expect(data.counts.suppressedCases).toBe(1);
      expect(data.counts.inFlightCases).toBe(0);
      expect(data.counts.totalAttempts).toBe(4);

      // Recovery rates
      // Canonical recoveryRate = 2 recovered / 3 eligible = 0.6667
      expect(data.rates.recoveryRate).toBe(0.6667);
      // Attempt recoveryRate = 2 recovered / 4 attempts = 0.5000
      expect(data.rates.attemptRecoveryRate).toBe(0.5);
      // Overall recoveryRate = 2 recovered / 4 total = 0.5000
      expect(data.rates.overallCaseRecoveryRate).toBe(0.5);
      // Revenue recoveryRate = 200,000 / 450,000 = 0.4444
      expect(data.rates.revenueRecoveryRate).toBe(0.4444);
    });

    it('preserves strict integer minor units and guarantees 0-variance ledger reconciliation (Invariant I5)', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;

      expect(data.revenue.totalDetectedMinorUnits).toBe(525000);
      expect(data.revenue.addressableMinorUnits).toBe(450000);
      expect(data.revenue.nonAddressableMinorUnits).toBe(75000);
      expect(data.revenue.recoveredRevenueMinorUnits).toBe(200000);
      expect(data.revenue.unrecoveredRevenueMinorUnits).toBe(250000);
      expect(data.revenue.suppressedRevenueMinorUnits).toBe(75000);
      expect(data.revenue.inFlightRevenueMinorUnits).toBe(0);

      // Verify integer minor units
      expect(Number.isInteger(data.revenue.totalDetectedMinorUnits)).toBe(true);
      expect(Number.isInteger(data.revenue.recoveredRevenueMinorUnits)).toBe(true);
      expect(Number.isInteger(data.revenue.unrecoveredRevenueMinorUnits)).toBe(true);

      // Verify exact 0-variance reconciliation
      expect(data.reconciliation.isReconciled).toBe(true);
      expect(data.reconciliation.varianceMinorUnits).toBe(0);
    });

    it('returns accurate strategy and action performance breakdown', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;

      expect(data.strategyPerformance.length).toBeGreaterThanOrEqual(3);

      const delayed = data.strategyPerformance.find((s) => s.strategy === 'DELAYED_RETRY');
      expect(delayed).toBeDefined();
      expect(delayed?.attempts).toBe(1);
      expect(delayed?.successfulRecoveries).toBe(1);
      expect(delayed?.recoveryRate).toBe(1.0);
      expect(delayed?.recoveredRevenueMinorUnits).toBe(150000);

      const retry = data.strategyPerformance.find((s) => s.strategy === 'RETRY_PAYMENT');
      expect(retry).toBeDefined();
      expect(retry?.attempts).toBe(2);
      expect(retry?.successfulRecoveries).toBe(1);
      expect(retry?.recoveryRate).toBe(0.5);
      expect(retry?.recoveredRevenueMinorUnits).toBe(50000);

      const outreach = data.strategyPerformance.find((s) => s.strategy === 'CUSTOMER_OUTREACH');
      expect(outreach).toBeDefined();
      expect(outreach?.attempts).toBe(1);
      expect(outreach?.successfulRecoveries).toBe(0);
      expect(outreach?.recoveryRate).toBe(0.0);
      expect(outreach?.recoveredRevenueMinorUnits).toBe(0);
    });

    it('returns accurate time-to-recovery latency percentiles', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;

      expect(data.latency.sampleSize).toBe(2);
      expect(data.latency.minDurationSeconds).toBeGreaterThanOrEqual(40);
      expect(data.latency.maxDurationSeconds).toBeGreaterThanOrEqual(115);
      expect(data.latency.p50DurationSeconds).toBeGreaterThanOrEqual(40);
      expect(data.latency.p90DurationSeconds).toBeGreaterThanOrEqual(115);
      expect(data.latency.p99DurationSeconds).toBeGreaterThanOrEqual(115);
      expect(data.latency.avgDurationSeconds).toBeGreaterThanOrEqual(75);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Empty Dataset & Zero-Denominator Safety                         */
  /* ---------------------------------------------------------------- */

  describe('2. Empty Dataset & Zero-Denominator Handling', () => {
    it('returns zeroed analytics without errors when merchant has no recovery cases', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: `Bearer ${token2}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;

      expect(data.merchantId).toBe(merchant2Id);
      expect(data.counts.totalCases).toBe(0);
      expect(data.counts.eligibleCases).toBe(0);
      expect(data.counts.ineligibleCases).toBe(0);
      expect(data.counts.successfulRecoveries).toBe(0);
      expect(data.counts.totalAttempts).toBe(0);

      // Rates must be safe 0.0 floats (no NaN or divide-by-zero)
      expect(data.rates.recoveryRate).toBe(0.0);
      expect(data.rates.revenueRecoveryRate).toBe(0.0);
      expect(data.rates.attemptRecoveryRate).toBe(0.0);
      expect(data.rates.overallCaseRecoveryRate).toBe(0.0);

      expect(data.revenue.totalDetectedMinorUnits).toBe(0);
      expect(data.revenue.recoveredRevenueMinorUnits).toBe(0);
      expect(data.latency.sampleSize).toBe(0);
      expect(data.strategyPerformance).toEqual([]);
      expect(data.reconciliation.isReconciled).toBe(true);
      expect(data.reconciliation.varianceMinorUnits).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Filtering: Date Ranges & Currency                               */
  /* ---------------------------------------------------------------- */

  describe('3. Query Filtering (Date Range & Currency)', () => {
    it('filters cases within valid date range', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 86400000).toISOString();
      const future = new Date(now.getTime() + 86400000).toISOString();

      const res = await fetch(
        `${baseUrl}/api/recovery/analytics?startDate=${encodeURIComponent(past)}&endDate=${encodeURIComponent(future)}`,
        { headers: { Authorization: `Bearer ${token1}` } }
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;
      expect(data.counts.totalCases).toBe(4);
    });

    it('returns 0 cases when date range is strictly in the future', async () => {
      const futureStart = new Date(Date.now() + 86400000 * 5).toISOString();
      const futureEnd = new Date(Date.now() + 86400000 * 10).toISOString();

      const res = await fetch(
        `${baseUrl}/api/recovery/analytics?startDate=${encodeURIComponent(futureStart)}&endDate=${encodeURIComponent(futureEnd)}`,
        { headers: { Authorization: `Bearer ${token1}` } }
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;
      expect(data.counts.totalCases).toBe(0);
      expect(data.revenue.totalDetectedMinorUnits).toBe(0);
    });

    it('filters by matching currency (INR) and non-matching currency (USD)', async () => {
      // Matching currency
      const resInr = await fetch(`${baseUrl}/api/recovery/analytics?currency=INR`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(resInr.status).toBe(200);
      const inrData = (await resInr.json()) as RecoveryAnalytics;
      expect(inrData.counts.totalCases).toBe(4);

      // Non-matching currency
      const resUsd = await fetch(`${baseUrl}/api/recovery/analytics?currency=USD`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(resUsd.status).toBe(200);
      const usdData = (await resUsd.json()) as RecoveryAnalytics;
      expect(usdData.counts.totalCases).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Tenant Isolation (Invariant I9)                                 */
  /* ---------------------------------------------------------------- */

  describe('4. Tenant Isolation (Invariant I9)', () => {
    it('enforces strict merchant scoping based on JWT and ignores client-provided merchantId', async () => {
      // Merchant 2 attempts to query Merchant 1 data by supplying ?merchantId in query
      const res = await fetch(
        `${baseUrl}/api/recovery/analytics?merchantId=${merchant1Id}`,
        { headers: { Authorization: `Bearer ${token2}` } }
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;

      // Identity MUST be Merchant 2 (from JWT), NOT Merchant 1
      expect(data.merchantId).toBe(merchant2Id);
      expect(data.counts.totalCases).toBe(0);
      expect(data.revenue.recoveredRevenueMinorUnits).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Authentication & Authorization                                  */
  /* ---------------------------------------------------------------- */

  describe('5. Authentication & Authorization Enforcement', () => {
    it('rejects unauthenticated request with 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`);

      expect(res.status).toBe(401);
      const err = await res.json();
      expect(err.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('rejects malformed bearer token with 401 AUTH_TOKEN_INVALID', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: 'Bearer totally-invalid-jwt-token' }
      });

      expect(res.status).toBe(401);
      const err = await res.json();
      expect(err.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rejects non-bearer auth scheme with 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' }
      });

      expect(res.status).toBe(401);
      const err = await res.json();
      expect(err.error.code).toBe('AUTH_TOKEN_MISSING');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Request Validation & Error Mapping                              */
  /* ---------------------------------------------------------------- */

  describe('6. Validation & Error Handling', () => {
    it('rejects malformed startDate with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics?startDate=invalid-date`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.error.code).toBe('VALIDATION_ERROR');
      expect(err.error.details.fieldErrors.startDate).toBeDefined();
    });

    it('rejects malformed endDate with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics?endDate=invalid-date`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.error.code).toBe('VALIDATION_ERROR');
      expect(err.error.details.fieldErrors.endDate).toBeDefined();
    });

    it('rejects invalid currency code length with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/analytics?currency=US`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.error.code).toBe('VALIDATION_ERROR');
      expect(err.error.details.fieldErrors.currency).toBeDefined();
    });

    it('rejects inverted date range (startDate > endDate) with 400 VALIDATION_ERROR', async () => {
      const future = '2026-09-10T00:00:00Z';
      const past = '2026-09-01T00:00:00Z';

      const res = await fetch(
        `${baseUrl}/api/recovery/analytics?startDate=${encodeURIComponent(future)}&endDate=${encodeURIComponent(past)}`,
        { headers: { Authorization: `Bearer ${token1}` } }
      );

      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.error.code).toBe('VALIDATION_ERROR');
      expect(err.error.details.fieldErrors.startDate[0]).toContain(
        'startDate must be less than or equal to endDate'
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Correlation Context & Traceability                              */
  /* ---------------------------------------------------------------- */

  describe('7. Correlation Context & Traceability', () => {
    it('echoes client x-correlation-id in response headers', async () => {
      const customCorrId = 'custom-anltc-trace-corr-001';
      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: {
          Authorization: `Bearer ${token1}`,
          'x-correlation-id': customCorrId
        }
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-correlation-id')).toBe(customCorrId);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Alias Route: /api/merchants/recovery/analytics                  */
  /* ---------------------------------------------------------------- */

  describe('8. Merchant Route Alias (/api/merchants/recovery/analytics)', () => {
    it('returns identical analytics via /api/merchants/recovery/analytics alias', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/recovery/analytics`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as RecoveryAnalytics;

      expect(data.merchantId).toBe(merchant1Id);
      expect(data.counts.totalCases).toBe(4);
      expect(data.revenue.recoveredRevenueMinorUnits).toBe(200000);
      expect(data.reconciliation.isReconciled).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  OpenAPI Contract Conformance                                    */
  /* ---------------------------------------------------------------- */

  describe('9. OpenAPI Specification Conformance', () => {
    it('verifies response structure matches the documented OpenAPI schema', async () => {
      const openApiPath = path.join(process.cwd(), '../docs/openapi.yaml');
      const openApiDoc = YAML.load(openApiPath);

      expect(openApiDoc.paths['/recovery/analytics']).toBeDefined();
      expect(openApiDoc.paths['/recovery/analytics'].get).toBeDefined();
      expect(openApiDoc.components.schemas.RecoveryAnalytics).toBeDefined();

      const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();

      // Top-level schema verification
      const requiredFields = [
        'merchantId',
        'currency',
        'period',
        'counts',
        'revenue',
        'rates',
        'latency',
        'strategyPerformance',
        'categoryPerformance',
        'reconciliation'
      ];
      for (const field of requiredFields) {
        expect(data).toHaveProperty(field);
      }

      // Rates verification
      expect(data.rates).toHaveProperty('recoveryRate');
      expect(data.rates).toHaveProperty('revenueRecoveryRate');
      expect(data.rates).toHaveProperty('attemptRecoveryRate');
      expect(data.rates).toHaveProperty('overallCaseRecoveryRate');

      // Latency verification
      expect(data.latency).toHaveProperty('p50DurationSeconds');
      expect(data.latency).toHaveProperty('p90DurationSeconds');
      expect(data.latency).toHaveProperty('p99DurationSeconds');
      expect(data.latency).toHaveProperty('avgDurationSeconds');
      expect(data.latency).toHaveProperty('minDurationSeconds');
      expect(data.latency).toHaveProperty('maxDurationSeconds');
      expect(data.latency).toHaveProperty('sampleSize');
    });
  });
});
