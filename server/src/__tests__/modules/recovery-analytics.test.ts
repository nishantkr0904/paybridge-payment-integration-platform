import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/database.js';
import { generateUlid } from '../../utils/ulid.js';
import {
  calculateLatencyMetrics,
  calculateRecoveryRates,
  aggregateStrategyPerformance,
  getRecoveryAnalytics,
  getPlatformRecoveryAnalytics
} from '../../modules/recovery/analytics.service.js';
import {
  createCaseWithEvent,
  transitionCaseStatus
} from '../../modules/recovery/case.repository.js';
import { computeRevenueLedger } from '../../modules/recovery/ledger.service.js';

describe('BT-C1: Recovery Analytics Service (ADB-001–004 / RCV-002)', () => {
  let merchant1Id: number;
  let merchant2Id: number;
  let order1Id: number;
  let order2Id: number;
  let order3Id: number;
  let order4Id: number;

  beforeAll(async () => {
    const conn = await pool.getConnection();
    try {
      const email1 = `analytics_m1_${Date.now()}@example.com`;
      const email2 = `analytics_m2_${Date.now()}@example.com`;

      const [m1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Analytics Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (m1 as unknown as { insertId: number }).insertId;

      const [m2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Analytics Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (m2 as unknown as { insertId: number }).insertId;

      // Seed orders for Merchant 1
      const [ord1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ANLTCORD0000000000000001', 50000, 'INR', 'failed')`,
        [merchant1Id]
      );
      order1Id = (ord1 as unknown as { insertId: number }).insertId;

      const [ord2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ANLTCORD0000000000000002', 150000, 'INR', 'failed')`,
        [merchant1Id]
      );
      order2Id = (ord2 as unknown as { insertId: number }).insertId;

      const [ord3] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ANLTCORD0000000000000003', 250000, 'INR', 'failed')`,
        [merchant1Id]
      );
      order3Id = (ord3 as unknown as { insertId: number }).insertId;

      // Seed order for Merchant 2
      const [ord4] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01ANLTCORD0000000000000004', 75000, 'INR', 'failed')`,
        [merchant2Id]
      );
      order4Id = (ord4 as unknown as { insertId: number }).insertId;
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    const conn = await pool.getConnection();
    try {
      if (merchant1Id) {
        await conn.query(`DELETE FROM users WHERE id IN (?, ?)`, [merchant1Id, merchant2Id]);
      }
    } finally {
      conn.release();
    }
  });

  /* ---------------------------------------------------------------- */
  /*  Unit Calculations & Edge Cases                                  */
  /* ---------------------------------------------------------------- */

  describe('1. Pure Metric Calculation & Zero-Denominator Handling', () => {
    it('handles empty latency dataset deterministically with all zeroes', () => {
      const metrics = calculateLatencyMetrics([]);
      expect(metrics).toEqual({
        sampleSize: 0,
        avgDurationSeconds: 0,
        minDurationSeconds: 0,
        maxDurationSeconds: 0,
        p50DurationSeconds: 0,
        p90DurationSeconds: 0,
        p99DurationSeconds: 0
      });
    });

    it('calculates exact percentiles for single duration sample', () => {
      const metrics = calculateLatencyMetrics([42]);
      expect(metrics).toEqual({
        sampleSize: 1,
        avgDurationSeconds: 42,
        minDurationSeconds: 42,
        maxDurationSeconds: 42,
        p50DurationSeconds: 42,
        p90DurationSeconds: 42,
        p99DurationSeconds: 42
      });
    });

    it('calculates deterministic p50, p90, p99, min, max, avg for multi-item distributions', () => {
      // 10 items: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
      const sample = [100, 20, 10, 50, 30, 70, 40, 90, 60, 80];
      const metrics = calculateLatencyMetrics(sample);

      expect(metrics.sampleSize).toBe(10);
      expect(metrics.minDurationSeconds).toBe(10);
      expect(metrics.maxDurationSeconds).toBe(100);
      expect(metrics.avgDurationSeconds).toBe(55);
      expect(metrics.p50DurationSeconds).toBe(50);
      expect(metrics.p90DurationSeconds).toBe(90);
      expect(metrics.p99DurationSeconds).toBe(100);
    });

    it('handles zero-denominator cases safely with zero rates', () => {
      const rates = calculateRecoveryRates({
        totalCases: 0,
        eligibleCases: 0,
        totalAttempts: 0,
        successfulRecoveries: 0,
        addressableMinorUnits: 0,
        recoveredRevenueMinorUnits: 0
      });

      expect(rates).toEqual({
        recoveryRate: 0.0,
        revenueRecoveryRate: 0.0,
        attemptRecoveryRate: 0.0,
        overallCaseRecoveryRate: 0.0
      });
    });

    it('calculates recovery rates with non-zero denominators correctly', () => {
      const rates = calculateRecoveryRates({
        totalCases: 10,
        eligibleCases: 8,
        totalAttempts: 12,
        successfulRecoveries: 6,
        addressableMinorUnits: 800000,
        recoveredRevenueMinorUnits: 600000
      });

      // Canonical recovery rate: 6 / 8 = 0.7500 (75%)
      expect(rates.recoveryRate).toBe(0.75);
      // Net revenue recovery rate: 600000 / 800000 = 0.7500
      expect(rates.revenueRecoveryRate).toBe(0.75);
      // Attempt efficiency rate: 6 / 12 = 0.5000 (50%)
      expect(rates.attemptRecoveryRate).toBe(0.5);
      // Overall case rate: 6 / 10 = 0.6000 (60%)
      expect(rates.overallCaseRecoveryRate).toBe(0.6);
    });

    it('aggregates strategy performance with integer minor units', () => {
      const attempts = [
        { actionType: 'RETRY_PAYMENT' },
        { actionType: 'RETRY_PAYMENT' },
        { actionType: 'DELAYED_RETRY' },
        { actionType: 'CUSTOMER_OUTREACH' }
      ];

      const outcomes = [
        { strategy: 'RETRY_PAYMENT', recoverableAmount: 50000 },
        { strategy: 'DELAYED_RETRY', recoverableAmount: 120000 }
      ];

      const performance = aggregateStrategyPerformance(attempts, outcomes);

      expect(performance).toHaveLength(3);

      const delayed = performance.find((s) => s.strategy === 'DELAYED_RETRY');
      expect(delayed).toBeDefined();
      expect(delayed?.attempts).toBe(1);
      expect(delayed?.successfulRecoveries).toBe(1);
      expect(delayed?.recoveryRate).toBe(1.0);
      expect(delayed?.recoveredRevenueMinorUnits).toBe(120000);

      const retry = performance.find((s) => s.strategy === 'RETRY_PAYMENT');
      expect(retry).toBeDefined();
      expect(retry?.attempts).toBe(2);
      expect(retry?.successfulRecoveries).toBe(1);
      expect(retry?.recoveryRate).toBe(0.5);
      expect(retry?.recoveredRevenueMinorUnits).toBe(50000);

      const outreach = performance.find((s) => s.strategy === 'CUSTOMER_OUTREACH');
      expect(outreach).toBeDefined();
      expect(outreach?.attempts).toBe(1);
      expect(outreach?.successfulRecoveries).toBe(0);
      expect(outreach?.recoveryRate).toBe(0.0);
      expect(outreach?.recoveredRevenueMinorUnits).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  End-to-End Scenarios against Database                           */
  /* ---------------------------------------------------------------- */

  describe('2. Empty Dataset Scenario', () => {
    it('returns clean zeroed analytics for a merchant with no recovery cases', async () => {
      // Merchant 2 has no recovery cases initially
      const analytics = await getRecoveryAnalytics(merchant2Id);

      expect(analytics.merchantId).toBe(merchant2Id);
      expect(analytics.counts.totalCases).toBe(0);
      expect(analytics.counts.eligibleCases).toBe(0);
      expect(analytics.counts.ineligibleCases).toBe(0);
      expect(analytics.counts.totalAttempts).toBe(0);
      expect(analytics.counts.successfulRecoveries).toBe(0);
      expect(analytics.counts.unrecoveredCases).toBe(0);
      expect(analytics.counts.suppressedCases).toBe(0);
      expect(analytics.counts.inFlightCases).toBe(0);

      expect(analytics.revenue.totalDetectedMinorUnits).toBe(0);
      expect(analytics.revenue.recoveredRevenueMinorUnits).toBe(0);

      expect(analytics.rates.recoveryRate).toBe(0.0);
      expect(analytics.rates.revenueRecoveryRate).toBe(0.0);

      expect(analytics.latency.sampleSize).toBe(0);
      expect(analytics.latency.p50DurationSeconds).toBe(0);

      expect(analytics.strategyPerformance).toHaveLength(0);
      expect(analytics.categoryPerformance).toHaveLength(0);
      expect(analytics.reconciliation.isReconciled).toBe(true);
      expect(analytics.reconciliation.varianceMinorUnits).toBe(0);
    });
  });

  describe('3. Ineligible Cases Scenario', () => {
    it('excludes non-addressable categories from eligibleCases denominator', async () => {
      const conn = await pool.getConnection();
      try {
        // Create an ineligible non-addressable case (ISSUER_HARD_DECLINE) for Merchant 2
        await createCaseWithEvent(
          merchant2Id,
          {
            orderId: order4Id,
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
            reason: 'Non-addressable hard decline',
            correlationId: generateUlid()
          }
        );

        const analytics = await getRecoveryAnalytics(merchant2Id);

        expect(analytics.counts.totalCases).toBe(1);
        expect(analytics.counts.eligibleCases).toBe(0);
        expect(analytics.counts.ineligibleCases).toBe(1);
        expect(analytics.counts.suppressedCases).toBe(1);
        expect(analytics.counts.successfulRecoveries).toBe(0);

        // Denominator is 0 eligible cases -> recoveryRate is 0.0 (not NaN or error)
        expect(analytics.rates.recoveryRate).toBe(0.0);
        expect(analytics.rates.revenueRecoveryRate).toBe(0.0);
        expect(analytics.revenue.nonAddressableMinorUnits).toBe(75000);
        expect(analytics.revenue.addressableMinorUnits).toBe(0);
        expect(analytics.revenue.suppressedRevenueMinorUnits).toBe(75000);
        expect(analytics.reconciliation.isReconciled).toBe(true);
      } finally {
        conn.release();
      }
    });
  });

  describe('4. Lifecycle Progression, Multi-Attempt & Recovery Latency', () => {
    let case1Id: number;
    let case2Id: number;
    let case3Id: number;

    it('seeds cases with multiple attempts, successful recoveries, and unrecovered terminal outcomes', async () => {
      const conn = await pool.getConnection();
      try {
        // Case 1: Addressable (INSUFFICIENT_FUNDS), 50000 INR -> Attempt 1 (executing) -> Recovered
        const c1 = await createCaseWithEvent(
          merchant1Id,
          {
            orderId: order1Id,
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
        case1Id = c1.id;

        // Transition Case 1: executing (Attempt 1: RETRY_PAYMENT)
        await transitionCaseStatus(case1Id, merchant1Id, {
          toStatus: 'executing',
          actorType: 'system',
          actorId: 'action_worker',
          payload: { actionType: 'RETRY_PAYMENT', retryAttempt: 1 },
          correlationId: generateUlid()
        });

        // Transition Case 1: recovered
        await transitionCaseStatus(case1Id, merchant1Id, {
          toStatus: 'recovered',
          actorType: 'system',
          actorId: 'action_worker',
          reason: 'Captured by action worker',
          payload: { amountRecovered: 50000, retryAttempt: 1, actionType: 'RETRY_PAYMENT' },
          correlationId: generateUlid()
        });

        // Case 2: Addressable (GATEWAY_TIMEOUT), 150000 INR -> Multi-attempt:
        // Attempt 1 (RETRY_PAYMENT, failed) -> Attempt 2 (DELAYED_RETRY, recovered)
        const c2 = await createCaseWithEvent(
          merchant1Id,
          {
            orderId: order2Id,
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
        case2Id = c2.id;

        // Attempt 1: RETRY_PAYMENT -> executing -> awaiting_outcome
        await transitionCaseStatus(case2Id, merchant1Id, {
          toStatus: 'executing',
          actorType: 'system',
          actorId: 'action_worker',
          payload: { actionType: 'RETRY_PAYMENT', retryAttempt: 1 },
          correlationId: generateUlid()
        });
        await transitionCaseStatus(case2Id, merchant1Id, {
          toStatus: 'awaiting_outcome',
          actorType: 'system',
          reason: 'Scheduled delayed retry',
          correlationId: generateUlid()
        });

        // Attempt 2: DELAYED_RETRY -> executing -> recovered
        await transitionCaseStatus(case2Id, merchant1Id, {
          toStatus: 'executing',
          actorType: 'system',
          actorId: 'action_worker',
          payload: { actionType: 'DELAYED_RETRY', retryAttempt: 2 },
          correlationId: generateUlid()
        });
        await transitionCaseStatus(case2Id, merchant1Id, {
          toStatus: 'recovered',
          actorType: 'system',
          actorId: 'action_worker',
          reason: 'Captured on retry',
          payload: { amountRecovered: 150000, retryAttempt: 2, actionType: 'DELAYED_RETRY' },
          correlationId: generateUlid()
        });

        // Case 3: Addressable (AUTHENTICATION_FAILURE), 250000 INR -> Attempt 1 (CUSTOMER_OUTREACH) -> unrecovered
        const c3 = await createCaseWithEvent(
          merchant1Id,
          {
            orderId: order3Id,
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
        case3Id = c3.id;

        await transitionCaseStatus(case3Id, merchant1Id, {
          toStatus: 'executing',
          actorType: 'system',
          actorId: 'action_worker',
          payload: { actionType: 'CUSTOMER_OUTREACH', retryAttempt: 1 },
          correlationId: generateUlid()
        });
        await transitionCaseStatus(case3Id, merchant1Id, {
          toStatus: 'unrecovered',
          actorType: 'system',
          reason: 'Outreach expired without response',
          correlationId: generateUlid()
        });

        // Update timestamps directly on cases to test deterministic latency calculation
        // Case 1: 30 seconds latency
        await conn.query(
          `UPDATE cases SET created_at = NOW() - INTERVAL 30 SECOND WHERE id = ?`,
          [case1Id]
        );
        // Case 2: 90 seconds latency
        await conn.query(
          `UPDATE cases SET created_at = NOW() - INTERVAL 90 SECOND WHERE id = ?`,
          [case2Id]
        );
      } finally {
        conn.release();
      }
    });

    it('computes accurate recovery rates, attempt efficiency, and volume counts', async () => {
      const analytics = await getRecoveryAnalytics(merchant1Id);

      expect(analytics.merchantId).toBe(merchant1Id);
      expect(analytics.currency).toBe('INR');

      // Volume counts
      expect(analytics.counts.totalCases).toBe(3);
      expect(analytics.counts.eligibleCases).toBe(3);
      expect(analytics.counts.ineligibleCases).toBe(0);
      expect(analytics.counts.successfulRecoveries).toBe(2);
      expect(analytics.counts.unrecoveredCases).toBe(1);
      expect(analytics.counts.inFlightCases).toBe(0);

      // Total attempts = Case 1 (1) + Case 2 (2) + Case 3 (1) = 4 attempts
      expect(analytics.counts.totalAttempts).toBe(4);

      // Recovery rate: 2 recovered / 3 eligible = 0.6667 (66.67%)
      expect(analytics.rates.recoveryRate).toBe(0.6667);

      // Attempt efficiency rate: 2 recovered / 4 attempts = 0.5000 (50.0%)
      expect(analytics.rates.attemptRecoveryRate).toBe(0.5);

      // Revenue recovery rate: 200000 recovered / 450000 addressable = 0.4444 (44.44%)
      expect(analytics.rates.revenueRecoveryRate).toBe(0.4444);
    });

    it('guarantees integer minor units money and exact 0-variance ledger reconciliation', async () => {
      const analytics = await getRecoveryAnalytics(merchant1Id);

      // Authoritative ledger amounts:
      // Total detected: 50000 + 150000 + 250000 = 450000
      // Recovered: 50000 + 150000 = 200000
      // Unrecovered: 250000
      expect(analytics.revenue.totalDetectedMinorUnits).toBe(450000);
      expect(analytics.revenue.recoveredRevenueMinorUnits).toBe(200000);
      expect(analytics.revenue.unrecoveredRevenueMinorUnits).toBe(250000);
      expect(analytics.revenue.addressableMinorUnits).toBe(450000);
      expect(analytics.revenue.nonAddressableMinorUnits).toBe(0);

      // Monetary values must be integer minor units (no float cents)
      expect(Number.isInteger(analytics.revenue.totalDetectedMinorUnits)).toBe(true);
      expect(Number.isInteger(analytics.revenue.recoveredRevenueMinorUnits)).toBe(true);
      expect(Number.isInteger(analytics.revenue.unrecoveredRevenueMinorUnits)).toBe(true);

      // 0-variance reconciliation assertion
      expect(analytics.reconciliation.isReconciled).toBe(true);
      expect(analytics.reconciliation.varianceMinorUnits).toBe(0);

      // Direct comparison with computeRevenueLedger
      const rawLedger = computeRevenueLedger(merchant1Id, [
        { status: 'recovered', recoverableAmount: 50000, failureCategory: 'INSUFFICIENT_FUNDS', merchantId: merchant1Id } as never,
        { status: 'recovered', recoverableAmount: 150000, failureCategory: 'GATEWAY_TIMEOUT', merchantId: merchant1Id } as never,
        { status: 'unrecovered', recoverableAmount: 250000, failureCategory: 'AUTHENTICATION_FAILURE', merchantId: merchant1Id } as never
      ]);

      expect(analytics.revenue.recoveredRevenueMinorUnits).toBe(rawLedger.totals.recoveredMinorUnits);
      expect(analytics.revenue.totalDetectedMinorUnits).toBe(rawLedger.totals.totalDetectedMinorUnits);
    });

    it('calculates real persisted time-to-recovery latency percentiles', async () => {
      const analytics = await getRecoveryAnalytics(merchant1Id);

      expect(analytics.latency.sampleSize).toBe(2);
      // Latencies are ~30s and ~90s
      expect(analytics.latency.minDurationSeconds).toBeGreaterThanOrEqual(28);
      expect(analytics.latency.maxDurationSeconds).toBeGreaterThanOrEqual(88);
      expect(analytics.latency.p50DurationSeconds).toBeGreaterThanOrEqual(28);
      expect(analytics.latency.p90DurationSeconds).toBeGreaterThanOrEqual(88);
      expect(analytics.latency.avgDurationSeconds).toBeGreaterThanOrEqual(58);
    });

    it('breaks down strategy performance accurately by action type', async () => {
      const analytics = await getRecoveryAnalytics(merchant1Id);

      // Strategies observed: RETRY_PAYMENT (2 attempts, 1 success), DELAYED_RETRY (1 attempt, 1 success), CUSTOMER_OUTREACH (1 attempt, 0 success)
      expect(analytics.strategyPerformance.length).toBeGreaterThanOrEqual(3);

      const delayed = analytics.strategyPerformance.find((s) => s.strategy === 'DELAYED_RETRY');
      expect(delayed).toBeDefined();
      expect(delayed?.attempts).toBe(1);
      expect(delayed?.successfulRecoveries).toBe(1);
      expect(delayed?.recoveryRate).toBe(1.0);
      expect(delayed?.recoveredRevenueMinorUnits).toBe(150000);

      const retry = analytics.strategyPerformance.find((s) => s.strategy === 'RETRY_PAYMENT');
      expect(retry).toBeDefined();
      expect(retry?.attempts).toBe(2);
      expect(retry?.successfulRecoveries).toBe(1);
      expect(retry?.recoveryRate).toBe(0.5);
      expect(retry?.recoveredRevenueMinorUnits).toBe(50000);

      const outreach = analytics.strategyPerformance.find((s) => s.strategy === 'CUSTOMER_OUTREACH');
      expect(outreach).toBeDefined();
      expect(outreach?.attempts).toBe(1);
      expect(outreach?.successfulRecoveries).toBe(0);
      expect(outreach?.recoveryRate).toBe(0.0);
      expect(outreach?.recoveredRevenueMinorUnits).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Tenant Isolation & Date Range Filtering                         */
  /* ---------------------------------------------------------------- */

  describe('5. Strict Tenant Isolation (Invariant I9)', () => {
    it('ensures Merchant 2 cannot view Merchant 1 recovery data and vice versa', async () => {
      const m1Analytics = await getRecoveryAnalytics(merchant1Id);
      const m2Analytics = await getRecoveryAnalytics(merchant2Id);

      expect(m1Analytics.merchantId).toBe(merchant1Id);
      expect(m2Analytics.merchantId).toBe(merchant2Id);

      // Merchant 1 has 3 cases and 200,000 INR recovered
      expect(m1Analytics.counts.totalCases).toBe(3);
      expect(m1Analytics.revenue.recoveredRevenueMinorUnits).toBe(200000);

      // Merchant 2 has 1 suppressed case and 0 INR recovered
      expect(m2Analytics.counts.totalCases).toBe(1);
      expect(m2Analytics.counts.eligibleCases).toBe(0);
      expect(m2Analytics.revenue.recoveredRevenueMinorUnits).toBe(0);

      // Verify no cross-tenant bleeding in strategies or categories
      expect(m2Analytics.strategyPerformance).toHaveLength(0);
      expect(m2Analytics.categoryPerformance).toHaveLength(1);
      expect(m2Analytics.categoryPerformance[0]?.failureCategory).toBe('ISSUER_HARD_DECLINE');
    });

    it('rejects invalid or non-integer merchant IDs', async () => {
      await expect(getRecoveryAnalytics(0 as never)).rejects.toThrow(
        'Valid positive integer merchantId is required'
      );
      await expect(getRecoveryAnalytics(-5 as never)).rejects.toThrow(
        'Valid positive integer merchantId is required'
      );
      await expect(getRecoveryAnalytics(1.5 as never)).rejects.toThrow(
        'Valid positive integer merchantId is required'
      );
    });
  });

  describe('6. Date-Range Filtering', () => {
    it('applies inclusive time boundaries to filter recovery cases', async () => {
      // Filter strictly in the future -> 0 cases
      const futureDate = new Date(Date.now() + 86400000 * 10);
      const futureAnalytics = await getRecoveryAnalytics(merchant1Id, {
        startDate: futureDate
      });

      expect(futureAnalytics.counts.totalCases).toBe(0);
      expect(futureAnalytics.revenue.totalDetectedMinorUnits).toBe(0);
      expect(futureAnalytics.reconciliation.isReconciled).toBe(true);

      // Filter in past range covering today -> all 3 cases
      const pastDate = new Date(Date.now() - 86400000);
      const pastAnalytics = await getRecoveryAnalytics(merchant1Id, {
        startDate: pastDate,
        endDate: new Date(Date.now() + 86400000)
      });

      expect(pastAnalytics.counts.totalCases).toBe(3);
      expect(pastAnalytics.revenue.recoveredRevenueMinorUnits).toBe(200000);
    });
  });

  describe('7. Platform-Wide Aggregation', () => {
    it('computes platform-wide aggregates across all merchants without tenant leakage', async () => {
      const platformAnalytics = await getPlatformRecoveryAnalytics();

      expect(platformAnalytics.merchantId).toBeNull();
      // Platform totals include Merchant 1 (3 cases) + Merchant 2 (1 case) + any preexisting cases
      expect(platformAnalytics.counts.totalCases).toBeGreaterThanOrEqual(4);
      expect(platformAnalytics.revenue.recoveredRevenueMinorUnits).toBeGreaterThanOrEqual(200000);
      expect(platformAnalytics.reconciliation.isReconciled).toBe(true);
      expect(platformAnalytics.reconciliation.varianceMinorUnits).toBe(0);
    });
  });
});
