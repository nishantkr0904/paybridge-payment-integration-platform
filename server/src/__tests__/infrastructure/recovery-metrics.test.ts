import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import {
  metricsRegistry,
  getMetrics,
  getMetricsContentType,
  resetMetricsRegistry,
  recoveryDurationSeconds,
  updateRecoveryRate,
  calculateAndUpdateRecoveryRate,
  recordCaseTransition,
  recordRecoveryAttempt,
  recordRecoverySuccess
} from '../../infrastructure/metrics.js';

describe('Prometheus Recovery Analytics Metrics (BT-C3 / OBS-001)', () => {
  let server: Server | null = null;
  let baseUrl: string = '';

  beforeEach(() => {
    resetMetricsRegistry();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function startServer(app = createApp()): Promise<string> {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve(baseUrl);
      });
    });
  }

  describe('1. Metric Registration & Registry Integration', () => {
    it('registers all required recovery metrics in metricsRegistry', () => {
      const metricNames = metricsRegistry.getMetricsAsArray().map((m) => m.name);

      expect(metricNames).toContain('recovery_rate');
      expect(metricNames).toContain('recovery_duration_seconds');
      expect(metricNames).toContain('recovery_cases_total');
      expect(metricNames).toContain('recovery_attempts_total');
      expect(metricNames).toContain('recovery_revenue_recovered_minor_units_total');
      expect(metricNames).toContain('recovery_action_executions_total');
      expect(metricNames).toContain('recovery_action_duplicates_suppressed_total');
    });

    it('initializes recovery_rate gauge to 0.0 on registration and reset', async () => {
      const metrics = await getMetrics();
      expect(metrics).toContain('# HELP recovery_rate Platform recovery success rate');
      expect(metrics).toContain('# TYPE recovery_rate gauge');
      expect(metrics).toContain('recovery_rate 0');
    });
  });

  describe('2. Recovery Rate Metric (recovery_rate)', () => {
    it('updates recovery rate with formatted positive float', async () => {
      updateRecoveryRate(0.7425);
      const metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0.7425');
    });

    it('handles zero-denominator deterministically without producing NaN or Infinity', async () => {
      const rate1 = calculateAndUpdateRecoveryRate(0, 0);
      expect(rate1).toBe(0.0);

      let metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0');
      expect(metrics).not.toContain('NaN');
      expect(metrics).not.toContain('Infinity');

      // Zero eligible cases with non-zero successes also falls back to 0.0
      const rate2 = calculateAndUpdateRecoveryRate(5, 0);
      expect(rate2).toBe(0.0);

      metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0');
      expect(metrics).not.toContain('NaN');
    });

    it('safely normalizes NaN, non-finite, and negative inputs to 0.0', async () => {
      updateRecoveryRate(NaN);
      let metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0');

      updateRecoveryRate(Infinity);
      metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0');

      updateRecoveryRate(-0.5);
      metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0');
    });

    it('calculates rate accurately from successes and eligible counts', async () => {
      const calculated = calculateAndUpdateRecoveryRate(15, 20);
      expect(calculated).toBe(0.75);

      const metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0.75');
    });
  });

  describe('3. Recovery Latency Metric (recovery_duration_seconds)', () => {
    it('configures histogram buckets matching specification from seconds to hours', () => {
      const metric = metricsRegistry.getMetricsAsArray().find((m) => m.name === 'recovery_duration_seconds');
      expect(metric).toBeDefined();

      // Expected 13 buckets: 1s, 5s, 15s, 30s, 60s, 120s, 300s, 600s, 1800s, 3600s, 7200s, 14400s, 86400s
      const expectedBuckets = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 86400];
      const buckets = (recoveryDurationSeconds as unknown as { upperBounds: number[] }).upperBounds;
      expect(buckets).toEqual(expectedBuckets);
    });

    it('records observations into appropriate duration buckets and updates sum and count', async () => {
      recordRecoverySuccess({
        durationSeconds: 0.5,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 5000,
        currency: 'INR'
      });

      recordRecoverySuccess({
        durationSeconds: 45,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 10000,
        currency: 'INR'
      });

      recordRecoverySuccess({
        durationSeconds: 1200, // 20 minutes
        actionType: 'DELAYED_RETRY',
        amountMinorUnits: 25000,
        currency: 'INR'
      });

      const metrics = await getMetrics();

      // Sub-second observation falls in le="1"
      expect(metrics).toContain('recovery_duration_seconds_bucket{le="1",action_type="RETRY_PAYMENT"} 1');
      // 45s falls in le="60"
      expect(metrics).toContain('recovery_duration_seconds_bucket{le="60",action_type="RETRY_PAYMENT"} 2');
      // 1200s falls in le="1800" for DELAYED_RETRY
      expect(metrics).toContain('recovery_duration_seconds_bucket{le="1800",action_type="DELAYED_RETRY"} 1');

      expect(metrics).toContain('recovery_duration_seconds_count{action_type="RETRY_PAYMENT"} 2');
      expect(metrics).toContain('recovery_duration_seconds_count{action_type="DELAYED_RETRY"} 1');
    });

    it('clamps negative durations to 0 without throwing', async () => {
      recordRecoverySuccess({
        durationSeconds: -10,
        actionType: 'RETRY_PAYMENT'
      });

      const metrics = await getMetrics();
      expect(metrics).toContain('recovery_duration_seconds_count{action_type="RETRY_PAYMENT"} 1');
      expect(metrics).toContain('recovery_duration_seconds_bucket{le="1",action_type="RETRY_PAYMENT"} 1');
    });
  });

  describe('4. Recovery Cases Counter (recovery_cases_total)', () => {
    it('records case lifecycle transitions under bounded status labels', async () => {
      recordCaseTransition(null, 'detected');
      recordCaseTransition('detected', 'evaluating');
      recordCaseTransition('evaluating', 'executing');
      recordCaseTransition('executing', 'recovered');
      recordCaseTransition('executing', 'unrecovered');
      recordCaseTransition('executing', 'suppressed');

      const metrics = await getMetrics();
      expect(metrics).toContain('recovery_cases_total{status="detected"} 1');
      expect(metrics).toContain('recovery_cases_total{status="evaluating"} 1');
      expect(metrics).toContain('recovery_cases_total{status="executing"} 1');
      expect(metrics).toContain('recovery_cases_total{status="recovered"} 1');
      expect(metrics).toContain('recovery_cases_total{status="unrecovered"} 1');
      expect(metrics).toContain('recovery_cases_total{status="suppressed"} 1');
    });
  });

  describe('5. Recovery Attempts Counter (recovery_attempts_total)', () => {
    it('records attempts under bounded action_type labels', async () => {
      recordRecoveryAttempt('RETRY_PAYMENT');
      recordRecoveryAttempt('RETRY_PAYMENT');
      recordRecoveryAttempt('DELAYED_RETRY');
      recordRecoveryAttempt('CUSTOMER_OUTREACH');

      const metrics = await getMetrics();
      expect(metrics).toContain('recovery_attempts_total{action_type="RETRY_PAYMENT"} 2');
      expect(metrics).toContain('recovery_attempts_total{action_type="DELAYED_RETRY"} 1');
      expect(metrics).toContain('recovery_attempts_total{action_type="CUSTOMER_OUTREACH"} 1');
    });
  });

  describe('6. Recovered Revenue Counter (recovery_revenue_recovered_minor_units_total)', () => {
    it('aggregates recovered revenue in integer minor units by currency', async () => {
      recordRecoverySuccess({
        durationSeconds: 2,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 15000,
        currency: 'INR'
      });

      recordRecoverySuccess({
        durationSeconds: 5,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 35000,
        currency: 'INR'
      });

      recordRecoverySuccess({
        durationSeconds: 10,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 5000,
        currency: 'USD'
      });

      const metrics = await getMetrics();
      expect(metrics).toContain('recovery_revenue_recovered_minor_units_total{currency="INR"} 50000');
      expect(metrics).toContain('recovery_revenue_recovered_minor_units_total{currency="USD"} 5000');
    });

    it('defaults currency to INR if not specified', async () => {
      recordRecoverySuccess({
        durationSeconds: 1,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 7500
      });

      const metrics = await getMetrics();
      expect(metrics).toContain('recovery_revenue_recovered_minor_units_total{currency="INR"} 7500');
    });
  });

  describe('7. HTTP Scrape Endpoints (/metrics and /api/metrics)', () => {
    it('exposes all recovery metrics on GET /metrics with text/plain Prometheus format', async () => {
      await startServer();

      // Record sample events
      recordRecoveryAttempt('RETRY_PAYMENT');
      recordRecoverySuccess({
        durationSeconds: 12,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 12000,
        currency: 'INR',
        incrementCaseCount: true
      });
      calculateAndUpdateRecoveryRate(1, 1);

      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(getMetricsContentType());

      const body = await res.text();
      expect(body).toContain('# HELP recovery_rate Platform recovery success rate');
      expect(body).toContain('# TYPE recovery_rate gauge');
      expect(body).toContain('recovery_rate 1');

      expect(body).toContain('# HELP recovery_duration_seconds Time to recovery in seconds');
      expect(body).toContain('# TYPE recovery_duration_seconds histogram');
      expect(body).toContain('recovery_duration_seconds_count{action_type="RETRY_PAYMENT"} 1');

      expect(body).toContain('# HELP recovery_cases_total Total number of recovery cases by status');
      expect(body).toContain('# TYPE recovery_cases_total counter');
      expect(body).toContain('recovery_cases_total{status="recovered"} 1');

      expect(body).toContain('# HELP recovery_attempts_total Total number of recovery attempts executed');
      expect(body).toContain('# TYPE recovery_attempts_total counter');
      expect(body).toContain('recovery_attempts_total{action_type="RETRY_PAYMENT"} 1');

      expect(body).toContain('# HELP recovery_revenue_recovered_minor_units_total Total recovered revenue in integer minor units');
      expect(body).toContain('# TYPE recovery_revenue_recovered_minor_units_total counter');
      expect(body).toContain('recovery_revenue_recovered_minor_units_total{currency="INR"} 12000');
    });

    it('exposes all recovery metrics identically on GET /api/metrics', async () => {
      await startServer();

      updateRecoveryRate(0.8);
      const res = await fetch(`${baseUrl}/api/metrics`);
      expect(res.status).toBe(200);

      const body = await res.text();
      expect(body).toContain('recovery_rate 0.8');
    });

    it('strictly avoids high-cardinality labels (no merchantId, caseId, or transactionId in labels)', async () => {
      await startServer();

      recordCaseTransition(null, 'detected');
      recordRecoveryAttempt('RETRY_PAYMENT');
      recordRecoverySuccess({
        durationSeconds: 10,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 9999,
        currency: 'INR'
      });

      const res = await fetch(`${baseUrl}/metrics`);
      const body = await res.text();

      // Ensure no merchant/case/txn/order labels exist in the recovery metric lines
      const recoveryLines = body.split('\n').filter((l) => l.startsWith('recovery_'));
      for (const line of recoveryLines) {
        expect(line).not.toMatch(/merchant/i);
        expect(line).not.toMatch(/case_id/i);
        expect(line).not.toMatch(/transaction/i);
        expect(line).not.toMatch(/order/i);
        expect(line).not.toMatch(/email/i);
      }
    });
  });

  describe('8. Reset & Clean Isolation Between Runs', () => {
    it('resets all recovery metrics cleanly without residual state', async () => {
      recordRecoveryAttempt('RETRY_PAYMENT');
      recordRecoverySuccess({
        durationSeconds: 20,
        actionType: 'RETRY_PAYMENT',
        amountMinorUnits: 50000,
        currency: 'INR',
        incrementCaseCount: true
      });
      updateRecoveryRate(0.9);

      let metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0.9');
      expect(metrics).toContain('recovery_attempts_total{action_type="RETRY_PAYMENT"} 1');

      resetMetricsRegistry();

      metrics = await getMetrics();
      expect(metrics).toContain('recovery_rate 0');
      expect(metrics).not.toContain('recovery_attempts_total{action_type="RETRY_PAYMENT"}');
      expect(metrics).not.toContain('recovery_duration_seconds_count{action_type="RETRY_PAYMENT"}');
      expect(metrics).not.toContain('recovery_revenue_recovered_minor_units_total{currency="INR"}');
    });
  });
});
