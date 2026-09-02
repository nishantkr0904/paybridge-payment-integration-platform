import type {
  AutonomyTier,
  EvaluationContext,
  Policy,
  PolicyEvaluationResult,
  ProposedAction
} from './policy.types.js';

/* ------------------------------------------------------------------ */
/*  Constants & Rules Lookup                                          */
/* ------------------------------------------------------------------ */

const TIER_ORDER: Record<AutonomyTier, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
  T4: 4
};

const TERMINAL_FAILURE_CATEGORIES = new Set([
  'ISSUER_HARD_DECLINE',
  'STOLEN_CARD',
  'LOST_CARD',
  'FRAUD_BLOCKED',
  'CLOSED_ACCOUNT',
  'INVALID_ACCOUNT',
  'UNRECOVERABLE_ERROR',
  'TERMINAL_DECLINE'
]);

/* ------------------------------------------------------------------ */
/*  Helper: Time & Quiet Hours Calculation                            */
/* ------------------------------------------------------------------ */

function parseTimeToMinutes(timeStr: string): number | null {
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

export function isWithinQuietHours(
  evalDate: Date,
  startStr: string,
  endStr: string,
  timezone: string
): boolean {
  const startMin = parseTimeToMinutes(startStr);
  const endMin = parseTimeToMinutes(endStr);
  if (startMin === null || endMin === null) return false;

  // Format date in policy timezone to extract local hours and minutes
  let localHour = evalDate.getUTCHours();
  let localMinute = evalDate.getUTCMinutes();

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const formattedParts = formatter.formatToParts(evalDate);
    for (const part of formattedParts) {
      if (part.type === 'hour') {
        const val = parseInt(part.value, 10);
        localHour = val === 24 ? 0 : val;
      }
      if (part.type === 'minute') {
        localMinute = parseInt(part.value, 10);
      }
    }
  } catch {
    // Fallback to UTC if timezone string is invalid
    localHour = evalDate.getUTCHours();
    localMinute = evalDate.getUTCMinutes();
  }

  const currentMin = localHour * 60 + localMinute;

  if (startMin <= endMin) {
    // Window within same calendar day (e.g. 01:00 to 05:00)
    return currentMin >= startMin && currentMin < endMin;
  } else {
    // Window crosses midnight (e.g. 22:00 to 08:00)
    return currentMin >= startMin || currentMin < endMin;
  }
}

function resolveEffectiveTier(merchantTier: AutonomyTier, globalTier?: AutonomyTier): AutonomyTier {
  if (!globalTier) return merchantTier;
  return TIER_ORDER[merchantTier] <= TIER_ORDER[globalTier] ? merchantTier : globalTier;
}

/* ------------------------------------------------------------------ */
/*  Pure Deterministic Policy Engine (POL-002 / AT-POL-001)           */
/* ------------------------------------------------------------------ */

/**
 * Evaluates a proposed recovery action against the merchant's active policy and evaluation context.
 * Pure function: No I/O, no network, no side effects, fully deterministic.
 */
export function evaluatePolicy(
  policy: Policy | null | undefined,
  action: ProposedAction,
  context?: EvaluationContext
): PolicyEvaluationResult {
  const evaluatedAt = context?.evaluationTime ?? new Date();
  const correlationId = context?.correlationId;

  // 1. Fail-Closed Boundary: Missing or Inactive Policy
  if (!policy || !policy.isActive) {
    return {
      decision: 'REJECTED',
      reasonCode: 'POLICY_INACTIVE_OR_MISSING',
      ruleId: 'RULE_FAIL_CLOSED',
      message: 'No active policy found for merchant or policy is disabled. Action rejected by default.',
      evaluatedTier: 'T0',
      evaluatedAt,
      proposedAction: action,
      correlationId
    };
  }

  // 2. Action Validation
  if (!action || !action.actionType) {
    return {
      decision: 'REJECTED',
      reasonCode: 'INVALID_PROPOSED_ACTION',
      ruleId: 'RULE_FAIL_CLOSED',
      message: 'Proposed recovery action is invalid or missing required actionType.',
      policyId: policy.id,
      policyVersion: policy.version,
      evaluatedTier: policy.autonomyTier,
      evaluatedAt,
      proposedAction: action,
      correlationId
    };
  }

  const effectiveTier = resolveEffectiveTier(policy.autonomyTier, context?.globalAutonomyTier);

  // 3. Invariant I10: Terminal Failure Protection
  const isTerminal =
    context?.isTerminalFailure === true ||
    (context?.failureCategory &&
      TERMINAL_FAILURE_CATEGORIES.has(context.failureCategory.toUpperCase()));

  if (isTerminal && (action.actionType === 'RETRY_PAYMENT')) {
    return {
      decision: 'REJECTED',
      reasonCode: 'TERMINAL_FAILURE_RETRY_BLOCKED',
      ruleId: 'RULE_TERMINAL_FAILURE_PROTECTION',
      message: 'Retries are strictly disallowed on terminal failure categories under all autonomy tiers (Invariant I10).',
      policyId: policy.id,
      policyVersion: policy.version,
      evaluatedTier: effectiveTier,
      evaluatedAt,
      proposedAction: action,
      correlationId
    };
  }

  // 4. Autonomy Tier T0 (Observation Only)
  if (effectiveTier === 'T0') {
    if (context?.requiresHumanReview) {
      return {
        decision: 'REQUIRES_HUMAN',
        reasonCode: 'TIER_OBSERVE_REQUIRES_HUMAN',
        ruleId: 'RULE_AUTONOMY_TIER_T0',
        message: 'Action submitted for manual human review under observation tier T0.',
        policyId: policy.id,
        policyVersion: policy.version,
        evaluatedTier: effectiveTier,
        evaluatedAt,
        proposedAction: action,
        correlationId
      };
    }
    return {
      decision: 'REJECTED',
      reasonCode: 'TIER_OBSERVE_ONLY',
      ruleId: 'RULE_AUTONOMY_TIER_T0',
      message: 'Autonomy tier T0 allows observation only; automated side effects are disallowed.',
      policyId: policy.id,
      policyVersion: policy.version,
      evaluatedTier: effectiveTier,
      evaluatedAt,
      proposedAction: action,
      correlationId
    };
  }

  // 5. Max Retries Limit
  if (action.actionType === 'RETRY_PAYMENT') {
    const currentRetries = context?.currentRetryCount ?? 0;
    if (currentRetries >= policy.maxRetries) {
      return {
        decision: 'REJECTED',
        reasonCode: 'MAX_RETRIES_EXCEEDED',
        ruleId: 'RULE_MAX_RETRIES',
        message: `Proposed retry attempt (${currentRetries + 1}) exceeds merchant maximum retry limit (${policy.maxRetries}).`,
        policyId: policy.id,
        policyVersion: policy.version,
        evaluatedTier: effectiveTier,
        evaluatedAt,
        proposedAction: action,
        correlationId
      };
    }
  }

  // 6. Contact Frequency Limits (Customer Outreach & Payment Link Requests)
  if (action.actionType === 'CUSTOMER_OUTREACH' || action.actionType === 'REQUEST_PAYMENT_METHOD') {
    const contactsThisWeek = context?.contactsThisWeek ?? 0;
    if (contactsThisWeek >= policy.maxContactsPerCustomerPerWeek) {
      return {
        decision: 'REJECTED',
        reasonCode: 'CONTACT_FATIGUE_EXCEEDED',
        ruleId: 'RULE_CONTACT_FREQUENCY',
        message: `Customer contact cap reached (${contactsThisWeek}/${policy.maxContactsPerCustomerPerWeek} contacts this week).`,
        policyId: policy.id,
        policyVersion: policy.version,
        evaluatedTier: effectiveTier,
        evaluatedAt,
        proposedAction: action,
        correlationId
      };
    }
  }

  // 7. Max Incentive Percentage Limit
  if (action.incentivePercent !== undefined && action.incentivePercent > 0) {
    if (action.incentivePercent > policy.maxIncentivePercent) {
      return {
        decision: 'REJECTED',
        reasonCode: 'MAX_INCENTIVE_EXCEEDED',
        ruleId: 'RULE_MAX_INCENTIVE',
        message: `Proposed incentive (${action.incentivePercent}%) exceeds merchant maximum allowed incentive cap (${policy.maxIncentivePercent}%).`,
        policyId: policy.id,
        policyVersion: policy.version,
        evaluatedTier: effectiveTier,
        evaluatedAt,
        proposedAction: action,
        correlationId
      };
    }
  }

  // 8. Daily Budget Consumption Limits (Monetary minor units)
  if (policy.dailyBudgetMinorUnits > 0) {
    const cost = action.costMinorUnits ?? 0;
    const spentToday = context?.dailySpentMinorUnits ?? 0;
    if (spentToday + cost > policy.dailyBudgetMinorUnits) {
      return {
        decision: 'REJECTED',
        reasonCode: 'DAILY_BUDGET_EXHAUSTED',
        ruleId: 'RULE_DAILY_BUDGET',
        message: `Action cost (${cost} minor units) exceeds remaining daily budget (${Math.max(0, policy.dailyBudgetMinorUnits - spentToday)} minor units).`,
        policyId: policy.id,
        policyVersion: policy.version,
        evaluatedTier: effectiveTier,
        evaluatedAt,
        proposedAction: action,
        correlationId
      };
    }
  }

  // 9. Quiet Hours Restrictions (Timezone-Aware)
  if (
    (action.actionType === 'CUSTOMER_OUTREACH' || action.actionType === 'REQUEST_PAYMENT_METHOD') &&
    policy.quietHoursStart &&
    policy.quietHoursEnd
  ) {
    const inQuietHours = isWithinQuietHours(
      evaluatedAt,
      policy.quietHoursStart,
      policy.quietHoursEnd,
      policy.timezone
    );
    if (inQuietHours) {
      return {
        decision: 'REJECTED',
        reasonCode: 'QUIET_HOURS_RESTRICTION',
        ruleId: 'RULE_QUIET_HOURS',
        message: `Customer outreach is disallowed during configured quiet hours (${policy.quietHoursStart} to ${policy.quietHoursEnd} ${policy.timezone}).`,
        policyId: policy.id,
        policyVersion: policy.version,
        evaluatedTier: effectiveTier,
        evaluatedAt,
        proposedAction: action,
        correlationId
      };
    }
  }

  // 10. Autonomy Tier Escalation: T1 (Suggest) & T2 (Approve) Require Operator Sign-off
  if (effectiveTier === 'T1' || effectiveTier === 'T2' || context?.requiresHumanReview === true) {
    return {
      decision: 'REQUIRES_HUMAN',
      reasonCode: 'REQUIRES_HUMAN_APPROVAL',
      ruleId: 'RULE_HUMAN_APPROVAL_REQUIRED',
      message: `Action is compliant with policy bounds but requires human operator approval under tier ${effectiveTier}.`,
      policyId: policy.id,
      policyVersion: policy.version,
      evaluatedTier: effectiveTier,
      evaluatedAt,
      proposedAction: action,
      correlationId
    };
  }

  // 11. Autonomous Execution Approved (T3 / T4)
  return {
    decision: 'APPROVED',
    reasonCode: 'ACTION_APPROVED',
    ruleId: 'RULE_ALL_CHECKS_PASSED',
    message: 'Proposed action satisfies all policy constraints and is approved for autonomous execution.',
    policyId: policy.id,
    policyVersion: policy.version,
    evaluatedTier: effectiveTier,
    evaluatedAt,
    proposedAction: action,
    correlationId
  };
}
