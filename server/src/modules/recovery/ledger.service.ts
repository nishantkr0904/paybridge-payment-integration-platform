import { NON_ADDRESSABLE_CATEGORIES } from './case.prioritizer.js';
import type {
  CategoryBreakdown,
  LedgerFilters,
  RecoveryCase,
  RevenueLedger
} from './case.types.js';

/* ------------------------------------------------------------------ */
/*  Recoverable Revenue & Leakage Ledger (RCV-002)                    */
/* ------------------------------------------------------------------ */

/**
 * Computes the complete Recoverable Revenue & Leakage Ledger from raw case records.
 * Guarantees exact 0-variance reconciliation against underlying cases.
 * (RCV-002 Requirements 2, 8, 11)
 */
export function computeRevenueLedger(
  merchantId: number,
  cases: RecoveryCase[],
  filters?: LedgerFilters
): RevenueLedger {
  const currency = filters?.currency || (cases[0]?.currency ?? 'INR');

  let filteredCases = cases.filter((c) => c.merchantId === merchantId);

  if (filters?.startDate) {
    const startMs = new Date(filters.startDate).getTime();
    filteredCases = filteredCases.filter((c) => new Date(c.createdAt).getTime() >= startMs);
  }

  if (filters?.endDate) {
    const endMs = new Date(filters.endDate).getTime();
    filteredCases = filteredCases.filter((c) => new Date(c.createdAt).getTime() <= endMs);
  }

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

  for (const c of filteredCases) {
    const amount = c.recoverableAmount;
    const cat = (c.failureCategory || 'UNKNOWN').toUpperCase();
    const isAddressable = !NON_ADDRESSABLE_CATEGORIES.has(cat);

    totalDetectedMinorUnits += amount;

    if (isAddressable) {
      addressableMinorUnits += amount;
    } else {
      nonAddressableMinorUnits += amount;
    }

    if (c.status === 'recovered') {
      recoveredMinorUnits += amount;
    } else if (c.status === 'unrecovered' || c.status === 'expired' || c.status === 'failed') {
      unrecoveredMinorUnits += amount;
    } else if (c.status === 'suppressed') {
      suppressedMinorUnits += amount;
    } else {
      // In flight
      inFlightMinorUnits += amount;
    }

    // Category breakdown
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

  // Exact Reconciliation Invariant Assertion (RCV-002 Requirement 11)
  const sumAddressableSplit = addressableMinorUnits + nonAddressableMinorUnits;
  const sumStatusSplit =
    recoveredMinorUnits + unrecoveredMinorUnits + suppressedMinorUnits + inFlightMinorUnits;

  if (totalDetectedMinorUnits !== sumAddressableSplit) {
    throw new Error(
      `Ledger reconciliation variance detected: totalDetected (${totalDetectedMinorUnits}) !== addressableSplit (${sumAddressableSplit})`
    );
  }

  if (totalDetectedMinorUnits !== sumStatusSplit) {
    throw new Error(
      `Ledger reconciliation variance detected: totalDetected (${totalDetectedMinorUnits}) !== statusSplit (${sumStatusSplit})`
    );
  }

  const byCategory: CategoryBreakdown[] = Array.from(categoryMap.entries()).map(([cat, stats]) => ({
    failureCategory: cat,
    isAddressable: stats.isAddressable,
    caseCount: stats.caseCount,
    detectedMinorUnits: stats.detectedMinorUnits,
    recoveredMinorUnits: stats.recoveredMinorUnits,
    suppressedMinorUnits: stats.suppressedMinorUnits,
    unrecoveredMinorUnits: stats.unrecoveredMinorUnits,
    inFlightMinorUnits: stats.inFlightMinorUnits
  }));

  return {
    merchantId,
    currency,
    period: {
      startDate: filters?.startDate,
      endDate: filters?.endDate
    },
    totals: {
      totalDetectedMinorUnits,
      addressableMinorUnits,
      nonAddressableMinorUnits,
      recoveredMinorUnits,
      unrecoveredMinorUnits,
      suppressedMinorUnits,
      inFlightMinorUnits,
      totalCaseCount: filteredCases.length
    },
    byCategory
  };
}
