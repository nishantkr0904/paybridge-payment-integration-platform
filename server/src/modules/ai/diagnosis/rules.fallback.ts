import type { AssembledRecoveryContext } from '../redaction.types.js';
import type {
  DiagnosisResult,
  FailureCategory,
  RecommendedStrategy
} from './diagnosis.types.js';

/* ------------------------------------------------------------------ */
/*  Deterministic Rules-Based Diagnosis Engine (AI-004 / TASK-303)    */
/* ------------------------------------------------------------------ */

const RULES_VERSION = 'v1.0.0';

interface RuleDefinition {
  category: FailureCategory;
  reasonCode: string;
  rootCause: string;
  contributingFactors: string[];
  recoverable: boolean;
  recommendedStrategy: RecommendedStrategy;
  confidence: number;
  explanation: string;
  evidence: string[];
}

/**
 * Pure, synchronous, zero-dependency rules fallback engine.
 * Guarantees a schema-valid conservative diagnosis whenever the model path
 * is unavailable, times out, circuit-trips, or returns malformed output.
 */
export function deriveRulesDiagnosis(
  context: AssembledRecoveryContext,
  correlationId: string,
  fallbackReason = 'RULES_FALLBACK'
): DiagnosisResult {
  const signalCategory = (context.case.failureCategory || '').toUpperCase();
  const failureReason = (context.transaction.failureReason || '').toLowerCase();

  let rule: RuleDefinition;

  if (
    signalCategory === 'TECHNICAL_TRANSIENT' ||
    signalCategory === 'NETWORK_TIMEOUT' ||
    failureReason.includes('timeout') ||
    failureReason.includes('connection')
  ) {
    rule = {
      category: 'TECHNICAL_TRANSIENT',
      reasonCode: 'GATEWAY_TIMEOUT',
      rootCause: 'Temporary gateway connectivity or network transport failure',
      contributingFactors: ['Network latency spike', 'Upstream payment gateway timeout'],
      recoverable: true,
      recommendedStrategy: 'IMMEDIATE_RETRY',
      confidence: 0.60,
      explanation: 'Transient network or gateway timeout encountered. Immediate retry recommended as underlying infrastructure stabilizes.',
      evidence: ['transaction.failureReason', 'case.failureCategory']
    };
  } else if (
    signalCategory === 'INSUFFICIENT_FUNDS' ||
    signalCategory === 'ISSUER_SOFT_DECLINE' ||
    failureReason.includes('insufficient') ||
    failureReason.includes('balance')
  ) {
    rule = {
      category: 'ISSUER_SOFT_DECLINE',
      reasonCode: 'SOFT_DECLINE_INSUFFICIENT_FUNDS',
      rootCause: 'Temporary cardholder balance deficit or operational limit',
      contributingFactors: ['Issuer soft decline', 'Customer historic payment attempt recorded'],
      recoverable: true,
      recommendedStrategy: 'DELAYED_RETRY',
      confidence: 0.65,
      explanation: 'Issuer indicated soft decline due to balance or temporary limit. Scheduled delayed retry recommended.',
      evidence: ['case.failureCategory', 'customer.hasPriorSuccess']
    };
  } else if (
    signalCategory === 'AUTHENTICATION_FAILED' ||
    failureReason.includes('auth') ||
    failureReason.includes('otp') ||
    failureReason.includes('3ds')
  ) {
    rule = {
      category: 'AUTHENTICATION_FAILED',
      reasonCode: '3DS_AUTH_FAILED',
      rootCause: 'Customer failed two-factor authentication challenge or verification session expired',
      contributingFactors: ['3DS verification challenge incomplete or expired'],
      recoverable: true,
      recommendedStrategy: 'CUSTOMER_OUTREACH',
      confidence: 0.60,
      explanation: 'Customer failed two-factor authentication challenge. Direct customer outreach with payment link recommended.',
      evidence: ['case.failureCategory', 'transaction.paymentMethod']
    };
  } else if (
    signalCategory === 'CARD_EXPIRED' ||
    failureReason.includes('expired')
  ) {
    rule = {
      category: 'CARD_EXPIRED',
      reasonCode: 'EXPIRED_CARD',
      rootCause: 'Card expiration date has elapsed',
      contributingFactors: ['Payment instrument validity expired'],
      recoverable: true,
      recommendedStrategy: 'ALTERNATE_PAYMENT_METHOD',
      confidence: 0.65,
      explanation: 'Card instrument expired. Switch to alternate payment method or updated card required.',
      evidence: ['case.failureCategory']
    };
  } else if (
    signalCategory === 'FRAUD_BLOCK' ||
    signalCategory === 'ISSUER_HARD_DECLINE' ||
    failureReason.includes('fraud') ||
    failureReason.includes('stolen') ||
    failureReason.includes('lost')
  ) {
    rule = {
      category: 'ISSUER_HARD_DECLINE',
      reasonCode: 'HARD_DECLINE_FRAUD_SECURITY',
      rootCause: 'Permanent block by issuer risk controls',
      contributingFactors: ['Issuer security filter trigger', 'Permanent authorization rejection'],
      recoverable: false,
      recommendedStrategy: 'ALTERNATE_PAYMENT_METHOD',
      confidence: 0.55,
      explanation: 'Permanent hard decline issued by cardholder institution. Retries will not succeed; alternate instrument required.',
      evidence: ['case.failureCategory']
    };
  } else if (
    signalCategory === 'ISSUER_DOWN' ||
    failureReason.includes('issuer down') ||
    failureReason.includes('unavailable')
  ) {
    rule = {
      category: 'ISSUER_DOWN',
      reasonCode: 'ISSUER_UNAVAILABLE',
      rootCause: 'Card issuer core banking system temporarily unavailable',
      contributingFactors: ['Issuer banking system outage'],
      recoverable: true,
      recommendedStrategy: 'DELAYED_RETRY',
      confidence: 0.60,
      explanation: 'Cardholder institution is undergoing system maintenance or outage. Delayed retry recommended once issuer recovers.',
      evidence: ['case.failureCategory']
    };
  } else {
    rule = {
      category: 'UNKNOWN',
      reasonCode: 'UNCLASSIFIED_DECLINE',
      rootCause: 'Unspecified decline from payment processor',
      contributingFactors: ['Unmapped gateway response code'],
      recoverable: false,
      recommendedStrategy: 'CUSTOMER_OUTREACH',
      confidence: 0.40,
      explanation: 'Unclassified payment failure. Routed to conservative outreach workflow for review.',
      evidence: ['case.originatingSignal']
    };
  }

  // Enforce conservative confidence cap (AI-004 Requirement 3)
  const boundedConfidence = Math.min(0.65, rule.confidence);

  return {
    category: rule.category,
    reasonCode: rule.reasonCode,
    rootCause: rule.rootCause,
    contributingFactors: rule.contributingFactors,
    recoverable: rule.recoverable,
    recommendedStrategy: rule.recommendedStrategy,
    confidence: boundedConfidence,
    explanation: rule.explanation,
    evidence: rule.evidence,
    provenance: {
      source: 'rules',
      promptId: 'rules_fallback',
      promptVersion: RULES_VERSION,
      modelId: 'rules-engine-v1',
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      latencyMs: 0,
      contextVersion: context.schemaVersion,
      rulesVersion: RULES_VERSION,
      repairAttempted: false,
      fallbackReason
    }
  };
}
