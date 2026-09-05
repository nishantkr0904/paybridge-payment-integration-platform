import client from 'prom-client';

export const metricsRegistry = new client.Registry();

// Enable default Node.js runtime metrics (memory, CPU, event loop lag, etc.)
client.collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry]
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry]
});

export const actionExecutionDuplicatesSuppressedTotal = new client.Counter({
  name: 'recovery_action_duplicates_suppressed_total',
  help: 'Total number of duplicate recovery actions suppressed by idempotency checks',
  labelNames: ['action_type'] as const,
  registers: [metricsRegistry]
});

export const actionExecutionsTotal = new client.Counter({
  name: 'recovery_action_executions_total',
  help: 'Total number of recovery action executions by status',
  labelNames: ['action_type', 'status'] as const,
  registers: [metricsRegistry]
});

/* ------------------------------------------------------------------ */
/*  Recovery Analytics Prometheus Metrics (BT-C3 / OBS-001)          */
/* ------------------------------------------------------------------ */

/**
 * Platform-wide recovery success rate (successful recoveries / eligible cases).
 * Initialized to 0.0; updated on authoritative recovery events and analytics sync.
 * Guaranteed strictly finite, non-negative, and never NaN/Infinity.
 */
export const recoveryRate = new client.Gauge({
  name: 'recovery_rate',
  help: 'Platform recovery success rate (successful recoveries / eligible cases)',
  registers: [metricsRegistry]
});
recoveryRate.set(0.0);

/**
 * Time to Recovery (TTR) duration in seconds from case detection to successful recovery.
 * Covers granular sub-second gateway retries through 24-hour delayed workflows.
 */
export const recoveryDurationSeconds = new client.Histogram({
  name: 'recovery_duration_seconds',
  help: 'Time to recovery in seconds from case detection to successful recovery',
  labelNames: ['action_type'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 86400],
  registers: [metricsRegistry]
});

/**
 * Total number of recovery cases transitioned into each lifecycle status.
 * Low-cardinality status label (e.g. detected, evaluating, executing, recovered, unrecovered, suppressed).
 */
export const recoveryCasesTotal = new client.Counter({
  name: 'recovery_cases_total',
  help: 'Total number of recovery cases by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry]
});

/**
 * Total number of recovery attempts executed across all strategies.
 * Low-cardinality action_type label (e.g. RETRY_PAYMENT, DELAYED_RETRY, CUSTOMER_OUTREACH).
 */
export const recoveryAttemptsTotal = new client.Counter({
  name: 'recovery_attempts_total',
  help: 'Total number of recovery attempts executed',
  labelNames: ['action_type'] as const,
  registers: [metricsRegistry]
});

/**
 * Total recovered revenue in integer minor units (e.g. paise, cents).
 * Low-cardinality currency label (e.g. INR, USD, EUR).
 */
export const recoveryRevenueRecoveredMinorUnitsTotal = new client.Counter({
  name: 'recovery_revenue_recovered_minor_units_total',
  help: 'Total recovered revenue in integer minor units',
  labelNames: ['currency'] as const,
  registers: [metricsRegistry]
});

/* ------------------------------------------------------------------ */
/*  Checkout Abandonment Prometheus Metrics (SIG-002 / BT-D2)         */
/* ------------------------------------------------------------------ */

export const checkoutAbandonmentsDetectedTotal = new client.Counter({
  name: 'checkout_abandonments_detected_total',
  help: 'Total number of checkout abandonment events detected by stage and source',
  labelNames: ['stage', 'source'] as const,
  registers: [metricsRegistry]
});

export const checkoutAbandonmentDwellTimeSeconds = new client.Histogram({
  name: 'checkout_abandonment_dwell_time_seconds',
  help: 'Dwell time in seconds of abandoned checkout sessions by stage',
  labelNames: ['stage'] as const,
  buckets: [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200],
  registers: [metricsRegistry]
});

export function recordCheckoutAbandonmentMetric(params: {
  stage: string;
  source?: string;
  dwellTimeSeconds?: number;
}): void {
  try {
    const stage = params.stage || 'arrived_only';
    const source = params.source || 'merchant_api';
    checkoutAbandonmentsDetectedTotal.inc({ stage, source });
    const dwell = Math.max(0, Number(params.dwellTimeSeconds) || 0);
    checkoutAbandonmentDwellTimeSeconds.observe({ stage }, dwell);
  } catch {
    // Non-blocking fail-safe
  }
}

/* ------------------------------------------------------------------ */
/*  Running Counters & Authoritative Synchronizers                    */
/* ------------------------------------------------------------------ */

let runningEligibleCases = 0;
let runningSuccessfulRecoveries = 0;

/**
 * Updates the platform recovery rate gauge safely.
 * Normalizes non-finite, negative, or NaN values strictly to 0.0.
 */
export function updateRecoveryRate(rate: number): void {
  try {
    const safeRate = isNaN(rate) || !isFinite(rate) || rate < 0 ? 0.0 : Number(rate.toFixed(4));
    recoveryRate.set(safeRate);
  } catch {
    // Non-blocking fail-safe
  }
}

/**
 * Recalculates and updates the recovery rate from explicit count inputs.
 * Returns the calculated rate formatted to 4 decimal places.
 */
export function calculateAndUpdateRecoveryRate(
  successfulRecoveries: number,
  eligibleCases: number
): number {
  runningSuccessfulRecoveries = Math.max(0, successfulRecoveries);
  runningEligibleCases = Math.max(0, eligibleCases);
  const rate =
    runningEligibleCases > 0
      ? Number((runningSuccessfulRecoveries / runningEligibleCases).toFixed(4))
      : 0.0;
  updateRecoveryRate(rate);
  return rate;
}

/**
 * Records a recovery case lifecycle state transition in Prometheus metrics.
 */
export function recordCaseTransition(
  fromStatus: string | null | undefined,
  toStatus: string,
  options?: { isEligible?: boolean }
): void {
  try {
    const safeStatus = toStatus.toLowerCase();
    recoveryCasesTotal.inc({ status: safeStatus });

    // Track running eligible cases when newly created/detected without prior status
    if (!fromStatus && (options?.isEligible ?? true)) {
      runningEligibleCases++;
      const currentRate =
        runningEligibleCases > 0
          ? Number((runningSuccessfulRecoveries / runningEligibleCases).toFixed(4))
          : 0.0;
      updateRecoveryRate(currentRate);
    }
  } catch {
    // Non-blocking fail-safe
  }
}

/**
 * Records an executed recovery attempt in Prometheus metrics.
 */
export function recordRecoveryAttempt(actionType: string): void {
  try {
    const safeActionType = (actionType || 'RETRY_PAYMENT').toUpperCase();
    recoveryAttemptsTotal.inc({ action_type: safeActionType });
  } catch {
    // Non-blocking fail-safe
  }
}

/**
 * Records a successful recovery in Prometheus metrics:
 * - Observes duration in recovery_duration_seconds histogram
 * - Records recovered revenue in integer minor units
 * - Updates running recovery success counts and recovery rate gauge
 */
export function recordRecoverySuccess(params: {
  durationSeconds: number;
  actionType?: string;
  amountMinorUnits?: number;
  currency?: string;
  incrementCaseCount?: boolean;
}): void {
  try {
    const actionType = (params.actionType || 'RETRY_PAYMENT').toUpperCase();
    const duration = Math.max(0, Number(params.durationSeconds) || 0);
    recoveryDurationSeconds.observe({ action_type: actionType }, duration);

    if (params.amountMinorUnits && params.amountMinorUnits > 0) {
      const currency = (params.currency || 'INR').toUpperCase();
      recoveryRevenueRecoveredMinorUnitsTotal.inc({ currency }, params.amountMinorUnits);
    }

    if (params.incrementCaseCount) {
      recoveryCasesTotal.inc({ status: 'recovered' });
    }

    runningSuccessfulRecoveries++;
    if (runningEligibleCases < runningSuccessfulRecoveries) {
      runningEligibleCases = runningSuccessfulRecoveries;
    }
    const currentRate =
      runningEligibleCases > 0
        ? Number((runningSuccessfulRecoveries / runningEligibleCases).toFixed(4))
        : 0.0;
    updateRecoveryRate(currentRate);
  } catch {
    // Non-blocking fail-safe
  }
}

export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export function resetMetricsRegistry(): void {
  metricsRegistry.resetMetrics();
  runningEligibleCases = 0;
  runningSuccessfulRecoveries = 0;
  recoveryRate.set(0.0);
}
