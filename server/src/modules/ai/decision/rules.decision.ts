import type { AssembledRecoveryContext } from '../redaction.types.js';
import type { DiagnosisResult } from '../diagnosis/diagnosis.types.js';
import type {
  DecisionPlan,
  ProposedActionPlanItem
} from './decision.types.js';

/* ------------------------------------------------------------------ */
/*  Deterministic Rules-Based Decision Planner (AI-004 / AI-006)      */
/* ------------------------------------------------------------------ */

const RULES_DECISION_VERSION = 'v1.0.0';

/**
 * Pure, synchronous rules fallback planner.
 * Produces a conservative, cost-ordered recovery action plan without model calls.
 */
export function deriveRulesDecisionPlan(
  context: AssembledRecoveryContext,
  diagnosis: DiagnosisResult,
  correlationId: string,
  fallbackReason = 'RULES_DECISION_FALLBACK'
): DecisionPlan {
  const category = (diagnosis.category || '').toUpperCase();
  const strategy = (diagnosis.recommendedStrategy || '').toUpperCase();

  const actions: ProposedActionPlanItem[] = [];
  let planRationale: string;

  if (
    category === 'TECHNICAL_TRANSIENT' ||
    category === 'NETWORK_TIMEOUT' ||
    strategy === 'IMMEDIATE_RETRY'
  ) {
    planRationale = 'Transient technical failure. Execute immediate retry followed by short-window backup retry.';
    actions.push({
      actionType: 'RETRY_PAYMENT',
      toolName: 'schedule_payment_retry',
      scheduledDelaySeconds: 0,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Immediate retry recommended for transient gateway or network connectivity failure.',
      parameters: { retryAttempt: 1 }
    });
    actions.push({
      actionType: 'RETRY_PAYMENT',
      toolName: 'schedule_payment_retry',
      scheduledDelaySeconds: 120,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Secondary retry scheduled after short backoff window.',
      parameters: { retryAttempt: 2 }
    });
  } else if (
    category === 'INSUFFICIENT_FUNDS' ||
    category === 'ISSUER_SOFT_DECLINE' ||
    strategy === 'DELAYED_RETRY'
  ) {
    planRationale = 'Soft decline / temporary funds deficit. Schedule delayed retry before requesting alternate payment method.';
    actions.push({
      actionType: 'RETRY_PAYMENT',
      toolName: 'schedule_payment_retry',
      scheduledDelaySeconds: 86400,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Scheduled delayed retry 24 hours later during expected customer funds replenishment.',
      parameters: { retryAttempt: 1 }
    });
    actions.push({
      actionType: 'REQUEST_PAYMENT_METHOD',
      toolName: 'request_alternate_instrument',
      scheduledDelaySeconds: 172800,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Request alternate payment instrument if delayed retry is unfulfilled.',
      parameters: {}
    });
  } else if (
    category === 'AUTHENTICATION_FAILED' ||
    strategy === 'CUSTOMER_OUTREACH'
  ) {
    planRationale = 'Authentication challenge incomplete. Send direct customer recovery link with 3DS retry.';
    actions.push({
      actionType: 'CUSTOMER_OUTREACH',
      toolName: 'send_recovery_link',
      scheduledDelaySeconds: 1800,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Send customer recovery link with direct payment authorization prompt.',
      parameters: { channel: 'email' }
    });
  } else if (
    category === 'CARD_EXPIRED' ||
    category === 'INVALID_ACCOUNT' ||
    strategy === 'ALTERNATE_PAYMENT_METHOD'
  ) {
    planRationale = 'Payment instrument invalid or expired. Prompt customer to provide updated payment method.';
    actions.push({
      actionType: 'REQUEST_PAYMENT_METHOD',
      toolName: 'request_alternate_instrument',
      scheduledDelaySeconds: 0,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Request updated payment instrument due to expired card details.',
      parameters: {}
    });
  } else if (
    category === 'FRAUD_BLOCK' ||
    category === 'ISSUER_HARD_DECLINE' ||
    diagnosis.recoverable === false
  ) {
    planRationale = 'Permanent authorization rejection or fraud block. Suppress automatic retries.';
    actions.push({
      actionType: 'CLOSE_CASE',
      toolName: 'suppress_case',
      scheduledDelaySeconds: 0,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Permanent hard decline or security block. Automated retries suppressed.',
      parameters: { reason: 'HARD_DECLINE_SUPPRESSION' }
    });
  } else {
    planRationale = 'Unclassified payment failure. Escalate to support for human operator review.';
    actions.push({
      actionType: 'ESCALATE_TO_SUPPORT',
      toolName: 'escalate_to_human_operator',
      scheduledDelaySeconds: 0,
      costMinorUnits: 0,
      incentivePercent: 0,
      rationale: 'Unclassified payment failure routed to human operator review.',
      parameters: { queue: 'general_review' }
    });
  }

  const primaryAction = actions.length > 0 ? actions[0] : null;

  return {
    planRationale,
    actions,
    primaryAction,
    costOrderingRespect: true,
    provenance: {
      source: 'rules',
      promptId: 'rules_decision_fallback',
      promptVersion: RULES_DECISION_VERSION,
      modelId: 'rules-engine-v1',
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      latencyMs: 0,
      contextVersion: context.schemaVersion,
      diagnosisCategory: diagnosis.category,
      rulesVersion: RULES_DECISION_VERSION,
      repairAttempted: false,
      fallbackReason
    }
  };
}
