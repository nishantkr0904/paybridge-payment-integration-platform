import { NON_ADDRESSABLE_CATEGORIES } from './case.prioritizer.js';
import { computeRevenueLedger } from './ledger.service.js';
import {
  fetchCaseLatencies,
  fetchCasesForAnalytics,
  fetchExecutionAttempts,
  fetchRecoveredCaseStrategies
} from './analytics.repository.js';
import type {
  RecoveryAnalytics,
  RecoveryAnalyticsFilters,
  RecoveryLatencyMetrics,
  RecoveryRates,
  StrategyPerformance
} from './analytics.types.js';
import type { CategoryBreakdown } from './case.types.js';

/* ------------------------------------------------------------------ */
/*  Latency Metric Calculations (TTR Percentiles)                     */
/* ------------------------------------------------------------------ */

/**
 * Calculates deterministic duration percentiles (p50, p90, p99), average,
 * min, and max for time-to-recovery (TTR) durations in seconds.
 * (§ADB-001 Requirement 4)
 */
export function calculateLatencyMetrics(durationsSeconds: number[]): RecoveryLatencyMetrics {
  if (durationsSeconds.length === 0) {
    return {
      sampleSize: 0,
      avgDurationSeconds: 0,
      minDurationSeconds: 0,
      maxDurationSeconds: 0,
      p50DurationSeconds: 0,
      p90DurationSeconds: 0,
      p99DurationSeconds: 0
    };
  }

  const sorted = [...durationsSeconds].sort((a, b) => a - b);
  const sampleSize = sorted.length;
  const minDurationSeconds = sorted[0]!;
  const maxDurationSeconds = sorted[sampleSize - 1]!;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avgDurationSeconds = Number((sum / sampleSize).toFixed(2));

  // Nearest-rank percentile helper
  const getPercentile = (p: number): number => {
    const rank = Math.ceil((p / 100) * sampleSize);
    const index = Math.min(sampleSize - 1, Math.max(0, rank - 1));
    return sorted[index]!;
  };

  return {
    sampleSize,
    avgDurationSeconds,
    minDurationSeconds,
    maxDurationSeconds,
    p50DurationSeconds: getPercentile(50),
    p90DurationSeconds: getPercentile(90),
    p99DurationSeconds: getPercentile(99)
  };
}

/* ------------------------------------------------------------------ */
/*  Recovery Rates Calculation (§ADB-001 / RCV-002)                   */
/* ------------------------------------------------------------------ */

/**
 * Calculates recovery rates handling zero-denominator edge cases deterministically.
 *
 * Denominator Rationale:
 * - Canonical `recoveryRate` uses `eligibleCases` (addressable cases) as the denominator.
 *   Non-addressable cases (hard declines, fraud, etc.) cannot be legally or technically
 *   attempted under Invariant I10 and are excluded to avoid artificial rate dilution.
 * - `revenueRecoveryRate` compares recovered revenue against addressable value at risk (TVR / TVaR_eligible).
 * - `attemptRecoveryRate` evaluates execution efficiency across all attempts.
 * - `overallCaseRecoveryRate` provides the raw unadjusted ratio against all detected cases.
 */
export function calculateRecoveryRates(params: {
  totalCases: number;
  eligibleCases: number;
  totalAttempts: number;
  successfulRecoveries: number;
  addressableMinorUnits: number;
  recoveredRevenueMinorUnits: number;
}): RecoveryRates {
  const {
    totalCases,
    eligibleCases,
    totalAttempts,
    successfulRecoveries,
    addressableMinorUnits,
    recoveredRevenueMinorUnits
  } = params;

  return {
    recoveryRate:
      eligibleCases > 0 ? Number((successfulRecoveries / eligibleCases).toFixed(4)) : 0.0,
    revenueRecoveryRate:
      addressableMinorUnits > 0
        ? Number((recoveredRevenueMinorUnits / addressableMinorUnits).toFixed(4))
        : 0.0,
    attemptRecoveryRate:
      totalAttempts > 0 ? Number((successfulRecoveries / totalAttempts).toFixed(4)) : 0.0,
    overallCaseRecoveryRate:
      totalCases > 0 ? Number((successfulRecoveries / totalCases).toFixed(4)) : 0.0
  };
}

/* ------------------------------------------------------------------ */
/*  Strategy / Action Performance Aggregator (§ADB-002 Req 2)         */
/* ------------------------------------------------------------------ */

/**
 * Aggregates execution attempts and recovery outcomes grouped by action/strategy type.
 */
export function aggregateStrategyPerformance(
  attempts: { actionType: string }[],
  recoveredOutcomes: { strategy: string; recoverableAmount: number }[]
): StrategyPerformance[] {
  const map = new Map<
    string,
    { attempts: number; successfulRecoveries: number; recoveredRevenueMinorUnits: number }
  >();

  // Tally attempts
  for (const att of attempts) {
    const strat = (att.actionType || 'RETRY_PAYMENT').toUpperCase();
    const existing = map.get(strat) || {
      attempts: 0,
      successfulRecoveries: 0,
      recoveredRevenueMinorUnits: 0
    };
    existing.attempts += 1;
    map.set(strat, existing);
  }

  // Tally successful recoveries and recovered revenue
  for (const outcome of recoveredOutcomes) {
    const strat = (outcome.strategy || 'RETRY_PAYMENT').toUpperCase();
    const existing = map.get(strat) || {
      attempts: 0,
      successfulRecoveries: 0,
      recoveredRevenueMinorUnits: 0
    };
    existing.successfulRecoveries += 1;
    existing.recoveredRevenueMinorUnits += outcome.recoverableAmount;
    map.set(strat, existing);
  }

  return Array.from(map.entries())
    .map(([strategy, data]) => ({
      strategy,
      attempts: data.attempts,
      successfulRecoveries: data.successfulRecoveries,
      recoveryRate:
        data.attempts > 0
          ? Number((data.successfulRecoveries / data.attempts).toFixed(4))
          : data.successfulRecoveries > 0
            ? 1.0
            : 0.0,
      recoveredRevenueMinorUnits: data.recoveredRevenueMinorUnits
    }))
    .sort((a, b) => b.recoveredRevenueMinorUnits - a.recoveredRevenueMinorUnits);
}

/* ------------------------------------------------------------------ */
/*  Core Recovery Analytics Service (Tenant-Scoped)                   */
/* ------------------------------------------------------------------ */

/**
 * Computes production-quality recovery analytics for a specific merchant.
 * Strictly adheres to tenant boundaries and reconciles with 0-variance against the authoritative RevenueLedger.
 *
 * @param merchantId Authenticated merchant identifier (strictly required)
 * @param filters Optional time range and currency filters
 */
export async function getRecoveryAnalytics(
  merchantId: number,
  filters?: RecoveryAnalyticsFilters
): Promise<RecoveryAnalytics> {
  if (typeof merchantId !== 'number' || merchantId <= 0 || !Number.isInteger(merchantId)) {
    throw new Error('Valid positive integer merchantId is required for tenant-scoped analytics');
  }

  // 1. Fetch raw cases and compute authoritative revenue ledger (guarantees 0-variance reconciliation)
  const cases = await fetchCasesForAnalytics(merchantId, filters);
  const ledger = computeRevenueLedger(merchantId, cases, filters);

  // 2. Fetch latency durations, execution attempts, and attributed recovery outcomes
  const latencies = await fetchCaseLatencies(merchantId, filters);
  const attempts = await fetchExecutionAttempts(merchantId, filters);
  const recoveredOutcomes = await fetchRecoveredCaseStrategies(merchantId, filters);

  // 3. Compute volume counts
  const totalCases = cases.length;
  let eligibleCases = 0;
  let successfulRecoveries = 0;
  let unrecoveredCases = 0;
  let suppressedCases = 0;
  let inFlightCases = 0;

  for (const c of cases) {
    const cat = (c.failureCategory || 'UNKNOWN').toUpperCase();
    const isAddressable = !NON_ADDRESSABLE_CATEGORIES.has(cat);
    if (isAddressable) {
      eligibleCases += 1;
    }

    if (c.status === 'recovered') {
      successfulRecoveries += 1;
    } else if (c.status === 'unrecovered' || c.status === 'expired' || c.status === 'failed') {
      unrecoveredCases += 1;
    } else if (c.status === 'suppressed') {
      suppressedCases += 1;
    } else {
      inFlightCases += 1;
    }
  }

  const ineligibleCases = totalCases - eligibleCases;
  const totalAttempts = attempts.length;

  // 4. Extract authoritative monetary figures (strictly integer minor units)
  const revenue = {
    totalDetectedMinorUnits: ledger.totals.totalDetectedMinorUnits,
    addressableMinorUnits: ledger.totals.addressableMinorUnits,
    nonAddressableMinorUnits: ledger.totals.nonAddressableMinorUnits,
    recoveredRevenueMinorUnits: ledger.totals.recoveredMinorUnits,
    unrecoveredRevenueMinorUnits: ledger.totals.unrecoveredMinorUnits,
    suppressedRevenueMinorUnits: ledger.totals.suppressedMinorUnits,
    inFlightRevenueMinorUnits: ledger.totals.inFlightMinorUnits
  };

  // 5. Compute recovery rates
  const rates = calculateRecoveryRates({
    totalCases,
    eligibleCases,
    totalAttempts,
    successfulRecoveries,
    addressableMinorUnits: revenue.addressableMinorUnits,
    recoveredRevenueMinorUnits: revenue.recoveredRevenueMinorUnits
  });

  // 6. Compute latency distribution
  const latency = calculateLatencyMetrics(latencies.map((l) => l.durationSeconds));

  // 7. Aggregate strategy performance
  const strategyPerformance = aggregateStrategyPerformance(attempts, recoveredOutcomes);

  // 8. Reconcile against authoritative ledger
  const sumStatusRevenue =
    revenue.recoveredRevenueMinorUnits +
    revenue.unrecoveredRevenueMinorUnits +
    revenue.suppressedRevenueMinorUnits +
    revenue.inFlightRevenueMinorUnits;
  const varianceMinorUnits = Math.abs(revenue.totalDetectedMinorUnits - sumStatusRevenue);

  return {
    merchantId,
    currency: ledger.currency,
    period: {
      startDate: filters?.startDate,
      endDate: filters?.endDate
    },
    counts: {
      totalCases,
      eligibleCases,
      ineligibleCases,
      totalAttempts,
      successfulRecoveries,
      unrecoveredCases,
      suppressedCases,
      inFlightCases
    },
    revenue,
    rates,
    latency,
    strategyPerformance,
    categoryPerformance: ledger.byCategory,
    reconciliation: {
      isReconciled: varianceMinorUnits === 0,
      varianceMinorUnits
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Platform-Wide Recovery Analytics Service (Operator / Admin)       */
/* ------------------------------------------------------------------ */

/**
 * Computes platform-wide aggregated recovery analytics across all merchants.
 * Explicitly separated from tenant-scoped queries to prevent accidental tenant leakage.
 *
 * @param filters Optional time range and currency filters
 */
export async function getPlatformRecoveryAnalytics(
  filters?: RecoveryAnalyticsFilters
): Promise<RecoveryAnalytics> {
  const cases = await fetchCasesForAnalytics(null, filters);

  const currency = filters?.currency || (cases[0]?.currency ?? 'INR');

  // Compute platform ledger totals manually to prevent single-merchant filtering in computeRevenueLedger
  let totalDetectedMinorUnits = 0;
  let addressableMinorUnits = 0;
  let nonAddressableMinorUnits = 0;
  let recoveredMinorUnits = 0;
  let unrecoveredMinorUnits = 0;
  let suppressedMinorUnits = 0;
  let inFlightMinorUnits = 0;

  const categoryMap = new Map<
    string,
    {
      isAddressable: boolean;
      caseCount: number;
      detectedMinorUnits: number;
      recoveredMinorUnits: number;
      suppressedMinorUnits: number;
      unrecoveredMinorUnits: number;
      inFlightMinorUnits: number;
    }
  >();

  let eligibleCases = 0;
  let successfulRecoveries = 0;
  let unrecoveredCases = 0;
  let suppressedCases = 0;
  let inFlightCases = 0;

  for (const c of cases) {
    const amount = c.recoverableAmount;
    const cat = (c.failureCategory || 'UNKNOWN').toUpperCase();
    const isAddressable = !NON_ADDRESSABLE_CATEGORIES.has(cat);

    totalDetectedMinorUnits += amount;
    if (isAddressable) {
      addressableMinorUnits += amount;
      eligibleCases += 1;
    } else {
      nonAddressableMinorUnits += amount;
    }

    if (c.status === 'recovered') {
      recoveredMinorUnits += amount;
      successfulRecoveries += 1;
    } else if (c.status === 'unrecovered' || c.status === 'expired' || c.status === 'failed') {
      unrecoveredMinorUnits += amount;
      unrecoveredCases += 1;
    } else if (c.status === 'suppressed') {
      suppressedMinorUnits += amount;
      suppressedCases += 1;
    } else {
      inFlightMinorUnits += amount;
      inFlightCases += 1;
    }

    const existing = categoryMap.get(cat) || {
      isAddressable,
      caseCount: 0,
      detectedMinorUnits: 0,
      recoveredMinorUnits: 0,
      suppressedMinorUnits: 0,
      unrecoveredMinorUnits: 0,
      inFlightMinorUnits: 0
    };

    existing.caseCount += 1;
    existing.detectedMinorUnits += amount;

    if (c.status === 'recovered') {
      existing.recoveredMinorUnits += amount;
    } else if (c.status === 'suppressed') {
      existing.suppressedMinorUnits += amount;
    } else if (c.status === 'unrecovered' || c.status === 'expired' || c.status === 'failed') {
      existing.unrecoveredMinorUnits += amount;
    } else {
      existing.inFlightMinorUnits += amount;
    }

    categoryMap.set(cat, existing);
  }

  const categoryPerformance: CategoryBreakdown[] = Array.from(categoryMap.entries()).map(
    ([cat, stats]) => ({
      failureCategory: cat,
      isAddressable: stats.isAddressable,
      caseCount: stats.caseCount,
      detectedMinorUnits: stats.detectedMinorUnits,
      recoveredMinorUnits: stats.recoveredMinorUnits,
      suppressedMinorUnits: stats.suppressedMinorUnits,
      unrecoveredMinorUnits: stats.unrecoveredMinorUnits,
      inFlightMinorUnits: stats.inFlightMinorUnits
    })
  );

  const latencies = await fetchCaseLatencies(null, filters);
  const attempts = await fetchExecutionAttempts(null, filters);
  const recoveredOutcomes = await fetchRecoveredCaseStrategies(null, filters);

  const totalCases = cases.length;
  const ineligibleCases = totalCases - eligibleCases;
  const totalAttempts = attempts.length;

  const revenue = {
    totalDetectedMinorUnits,
    addressableMinorUnits,
    nonAddressableMinorUnits,
    recoveredRevenueMinorUnits: recoveredMinorUnits,
    unrecoveredRevenueMinorUnits: unrecoveredMinorUnits,
    suppressedRevenueMinorUnits: suppressedMinorUnits,
    inFlightRevenueMinorUnits: inFlightMinorUnits
  };

  const rates = calculateRecoveryRates({
    totalCases,
    eligibleCases,
    totalAttempts,
    successfulRecoveries,
    addressableMinorUnits: revenue.addressableMinorUnits,
    recoveredRevenueMinorUnits: revenue.recoveredRevenueMinorUnits
  });

  const latency = calculateLatencyMetrics(latencies.map((l) => l.durationSeconds));
  const strategyPerformance = aggregateStrategyPerformance(attempts, recoveredOutcomes);

  const sumStatusRevenue =
    recoveredMinorUnits + unrecoveredMinorUnits + suppressedMinorUnits + inFlightMinorUnits;
  const varianceMinorUnits = Math.abs(totalDetectedMinorUnits - sumStatusRevenue);

  return {
    merchantId: null,
    currency,
    period: {
      startDate: filters?.startDate,
      endDate: filters?.endDate
    },
    counts: {
      totalCases,
      eligibleCases,
      ineligibleCases,
      totalAttempts,
      successfulRecoveries,
      unrecoveredCases,
      suppressedCases,
      inFlightCases
    },
    revenue,
    rates,
    latency,
    strategyPerformance,
    categoryPerformance,
    reconciliation: {
      isReconciled: varianceMinorUnits === 0,
      varianceMinorUnits
    }
  };
}
