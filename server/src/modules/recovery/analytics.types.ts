import type { CategoryBreakdown } from './case.types.js';

/* ------------------------------------------------------------------ */
/*  Filters for Recovery Analytics (Consistent with LedgerFilters)    */
/* ------------------------------------------------------------------ */

export interface RecoveryAnalyticsFilters {
  startDate?: Date;
  endDate?: Date;
  currency?: string;
}

/* ------------------------------------------------------------------ */
/*  Latency / Time-to-Recovery (TTR) Metrics (§ADB-001 Req 4)         */
/* ------------------------------------------------------------------ */

export interface RecoveryLatencyMetrics {
  /** Number of successfully recovered cases with recorded lifecycle timestamps */
  sampleSize: number;
  /** Mean duration from failure detection to recovery, in seconds */
  avgDurationSeconds: number;
  /** Minimum duration in seconds */
  minDurationSeconds: number;
  /** Maximum duration in seconds */
  maxDurationSeconds: number;
  /** 50th percentile (median) duration in seconds */
  p50DurationSeconds: number;
  /** 90th percentile duration in seconds */
  p90DurationSeconds: number;
  /** 99th percentile duration in seconds */
  p99DurationSeconds: number;
}

/* ------------------------------------------------------------------ */
/*  Strategy / Action Performance Metrics (§ADB-002 Req 2)            */
/* ------------------------------------------------------------------ */

export interface StrategyPerformance {
  /** Canonical action/strategy identifier (e.g. RETRY_PAYMENT, DELAYED_RETRY, CUSTOMER_OUTREACH, etc.) */
  strategy: string;
  /** Total execution attempts using this strategy */
  attempts: number;
  /** Number of cases successfully recovered using this strategy */
  successfulRecoveries: number;
  /** Recovery success rate for this strategy (successfulRecoveries / attempts) */
  recoveryRate: number;
  /** Total revenue recovered via this strategy in integer minor units */
  recoveredRevenueMinorUnits: number;
}

/* ------------------------------------------------------------------ */
/*  Recovery Rates (§ADB-001 / RCV-002)                               */
/* ------------------------------------------------------------------ */

export interface RecoveryRates {
  /**
   * Primary canonical recovery rate: successful recoveries / eligible (addressable) cases.
   * Excludes non-addressable categories (hard declines, fraud, etc.) per Invariant I10.
   */
  recoveryRate: number;
  /**
   * Net revenue recovery rate: recovered revenue / addressable value at risk (TVR / TVaR_eligible).
   * Strict integer minor units ratio.
   */
  revenueRecoveryRate: number;
  /**
   * Execution attempt efficiency: successful recoveries / total recovery attempts.
   */
  attemptRecoveryRate: number;
  /**
   * Overall case recovery rate: successful recoveries / all detected cases.
   */
  overallCaseRecoveryRate: number;
}

/* ------------------------------------------------------------------ */
/*  Comprehensive Recovery Analytics Aggregate (§ADB-001–004)         */
/* ------------------------------------------------------------------ */

export interface RecoveryAnalytics {
  /** Scoped merchant ID, or null for platform-wide aggregation */
  merchantId: number | null;
  /** Settlement currency */
  currency: string;
  /** Reporting period boundaries (inclusive) */
  period: {
    startDate?: Date;
    endDate?: Date;
  };

  /** Case counts across the recovery lifecycle */
  counts: {
    totalCases: number;
    eligibleCases: number;
    ineligibleCases: number;
    totalAttempts: number;
    successfulRecoveries: number;
    unrecoveredCases: number;
    suppressedCases: number;
    inFlightCases: number;
  };

  /**
   * Financial ledger metrics reconciled with 0-variance against the authoritative RevenueLedger.
   * All amounts are strictly integer minor units (Invariant I5).
   */
  revenue: {
    totalDetectedMinorUnits: number;
    addressableMinorUnits: number;
    nonAddressableMinorUnits: number;
    recoveredRevenueMinorUnits: number;
    unrecoveredRevenueMinorUnits: number;
    suppressedRevenueMinorUnits: number;
    inFlightRevenueMinorUnits: number;
  };

  /** Computed recovery rates */
  rates: RecoveryRates;

  /** Time-to-recovery (TTR) distribution */
  latency: RecoveryLatencyMetrics;

  /** Action / strategy breakdown */
  strategyPerformance: StrategyPerformance[];

  /** Failure category breakdown (from RevenueLedger) */
  categoryPerformance: CategoryBreakdown[];

  /** Ledger reconciliation proof */
  reconciliation: {
    isReconciled: boolean;
    varianceMinorUnits: number;
  };
}
