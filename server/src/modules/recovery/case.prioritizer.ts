import type { AutonomyTier } from '../policy/policy.types.js';
import type {
  PrioritizedCase,
  PriorityBreakdown,
  PriorityScore,
  RecoveryCase
} from './case.types.js';

/* ------------------------------------------------------------------ */
/*  Constants & Weighting Tables (RCV-002)                            */
/* ------------------------------------------------------------------ */

export const NON_ADDRESSABLE_CATEGORIES: ReadonlySet<string> = new Set([
  'ISSUER_HARD_DECLINE',
  'STOLEN_CARD',
  'FRAUD_BLOCKED',
  'RISK_BLOCKED',
  'MERCHANT_CONFIG_ERROR'
]);

export const CATEGORY_WEIGHTS: Record<string, number> = {
  INSUFFICIENT_FUNDS: 150,
  GATEWAY_TIMEOUT: 120,
  AUTHENTICATION_FAILURE: 100,
  CUSTOMER_ABANDONED: 80,
  GATEWAY_DECLINED: 50,
  UNKNOWN: 30,
  ISSUER_HARD_DECLINE: -500,
  FRAUD_BLOCKED: -1000,
  RISK_BLOCKED: -1000,
  STOLEN_CARD: -1000,
  MERCHANT_CONFIG_ERROR: -500
};

export const TIER_WEIGHTS: Record<AutonomyTier, number> = {
  T4: 400,
  T3: 300,
  T2: 200,
  T1: 100,
  T0: 0
};

export interface PrioritizationOptions {
  evaluationTime?: Date;
  merchantTier?: AutonomyTier;
  propensityScore?: number;
}

/**
 * Deterministically calculates the priority score for a recovery case based on
 * recoverable value, signal age, merchant autonomy tier, category recoverability,
 * and propensity score. (RCV-002 Requirement 4)
 */
export function calculatePriorityScore(
  recoveryCase: RecoveryCase,
  options?: PrioritizationOptions
): PriorityScore {
  const evalTime = options?.evaluationTime ? new Date(options.evaluationTime) : new Date();
  const createdAt = new Date(recoveryCase.createdAt);
  const ageInSeconds = Math.max(0, Math.floor((evalTime.getTime() - createdAt.getTime()) / 1000));

  // 1. Recoverable Value Weight (scaled from integer minor units)
  const valueScore = Math.floor(recoveryCase.recoverableAmount / 100);

  // 2. Signal Age Weight (bounded to prevent starvation without overpowering value)
  const ageScore = Math.min(Math.floor(ageInSeconds * 0.5), 1000);

  // 3. Merchant Autonomy Tier Weight
  const tier = options?.merchantTier || 'T1';
  const tierScore = TIER_WEIGHTS[tier] ?? 100;

  // 4. Failure Category Recoverability Weight
  const category = (recoveryCase.failureCategory || 'UNKNOWN').toUpperCase();
  const isAddressable = !NON_ADDRESSABLE_CATEGORIES.has(category);
  const categoryScore = CATEGORY_WEIGHTS[category] ?? (isAddressable ? 50 : -500);

  // 5. Propensity Score Weight
  const propensity = options?.propensityScore ?? (isAddressable ? 0.6 : 0.0);
  const propensityScore = Math.floor(propensity * 200);

  const totalScore = valueScore + ageScore + tierScore + categoryScore + propensityScore;

  const breakdown: PriorityBreakdown = {
    valueScore,
    ageScore,
    tierScore,
    categoryScore,
    propensityScore
  };

  const formula = `P = value(${valueScore}) + age(${ageScore}) + tier(${tierScore}) + category(${categoryScore}) + propensity(${propensityScore}) = ${totalScore}`;
  const derivationBasis = `Derivation: Amount ${recoveryCase.recoverableAmount} ${recoveryCase.currency} (${valueScore}pts) + Age ${ageInSeconds}s (${ageScore}pts) + Tier ${tier} (${tierScore}pts) + Category ${category} (${categoryScore}pts) + Propensity ${propensity.toFixed(2)} (${propensityScore}pts)`;

  return {
    score: totalScore,
    formula,
    derivationBasis,
    breakdown,
    isAddressable
  };
}

/**
 * Prioritizes a list of recovery cases with deterministic scores.
 */
export function prioritizeCases(
  cases: RecoveryCase[],
  options?: PrioritizationOptions
): PrioritizedCase[] {
  return cases.map((c) => ({
    case: c,
    priority: calculatePriorityScore(c, options)
  }));
}

/**
 * Enforces per-merchant fairness across a multi-merchant backlog using fair
 * round-robin interleaving so that high-volume merchants do not starve smaller merchants.
 * (RCV-002 Requirement 6)
 */
export function rankCasesFairly(
  prioritizedCases: PrioritizedCase[],
  options?: { limit?: number; maxPerMerchant?: number }
): PrioritizedCase[] {
  const limit = options?.limit ?? prioritizedCases.length;
  const maxPerMerchant = options?.maxPerMerchant ?? Infinity;

  // Group by merchantId
  const byMerchant = new Map<number, PrioritizedCase[]>();
  for (const item of prioritizedCases) {
    const list = byMerchant.get(item.case.merchantId) || [];
    list.push(item);
    byMerchant.set(item.case.merchantId, list);
  }

  // Sort each merchant's queue internally by priority score DESC, then case ID ASC
  for (const list of byMerchant.values()) {
    list.sort((a, b) => {
      if (b.priority.score !== a.priority.score) {
        return b.priority.score - a.priority.score;
      }
      return a.case.id - b.case.id;
    });
  }

  const result: PrioritizedCase[] = [];
  const merchantCountMap = new Map<number, number>();
  const activeQueues = Array.from(byMerchant.entries());

  let hasMore = true;
  while (hasMore && result.length < limit) {
    hasMore = false;
    for (const [merchantId, queue] of activeQueues) {
      if (result.length >= limit) break;
      const count = merchantCountMap.get(merchantId) || 0;
      if (count < maxPerMerchant && queue.length > 0) {
        const nextCase = queue.shift()!;
        result.push(nextCase);
        merchantCountMap.set(merchantId, count + 1);
        if (queue.length > 0) {
          hasMore = true;
        }
      }
    }
  }

  return result;
}

/**
 * Identifies the lowest-priority cases to explicitly shed when queue capacity is exceeded.
 * (RCV-002 Requirement 7)
 */
export function identifyCasesToShed(
  prioritizedCases: PrioritizedCase[],
  capacityLimit: number
): PrioritizedCase[] {
  if (prioritizedCases.length <= capacityLimit) {
    return [];
  }

  const shedCount = prioritizedCases.length - capacityLimit;

  // Sort ascending by priority score to shed lowest priority first (tie-break by newest ID)
  const sortedAsc = [...prioritizedCases].sort((a, b) => {
    if (a.priority.score !== b.priority.score) {
      return a.priority.score - b.priority.score;
    }
    return b.case.id - a.case.id;
  });

  return sortedAsc.slice(0, shedCount);
}
