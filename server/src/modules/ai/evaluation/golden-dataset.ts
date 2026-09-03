import type { AssembledRecoveryContext } from '../redaction.types.js';
import type { GoldenTestCase } from './evaluation.types.js';

/* ------------------------------------------------------------------ */
/*  Helper to construct clean, valid mock contexts for golden cases   */
/* ------------------------------------------------------------------ */

function makeContext(params: {
  caseRef: string;
  orderRef: string;
  txnRef?: string;
  amountMinorUnits: number;
  currency?: string;
  paymentMethod?: 'card' | 'upi' | 'netbanking' | 'wallet';
  originatingSignal: string;
  failureCategory?: string;
  failureReason?: string;
  gatewayCode?: string;
  customerRef?: string;
  priorSuccessCount?: number;
  priorFailureCount?: number;
  autonomyTier?: 'T0' | 'T1' | 'T2' | 'T3' | 'T4';
}): AssembledRecoveryContext {
  return {
    schemaVersion: 'v1.0.0',
    assembledAt: '2026-09-01T12:00:00.000Z',
    case: {
      caseRef: params.caseRef,
      recoverableAmountMinorUnits: params.amountMinorUnits,
      currency: params.currency || 'INR',
      originatingSignal: params.originatingSignal,
      failureCategory: params.failureCategory || null,
      caseStatus: 'detected',
      caseAgeSeconds: 300
    },
    transaction: {
      txnRef: params.txnRef || `txn_${params.caseRef}`,
      paymentMethod: params.paymentMethod || 'card',
      declineReason: params.failureReason || 'Declined',
      failureReason: params.failureReason || 'Declined',
      gatewayCode: params.gatewayCode || 'DECLINED',
      attemptNumber: 1
    },
    customer: {
      customerReference: params.customerRef || 'customer_ref_12345678',
      hasPriorSuccess: (params.priorSuccessCount ?? 5) > 0,
      priorSuccessCount: params.priorSuccessCount ?? 5,
      priorFailureCount: params.priorFailureCount ?? 1,
      knownPaymentMethods: [params.paymentMethod || 'card']
    },
    merchant: {
      merchantReference: 'merchant_ref_abcdef12',
      autonomyTier: params.autonomyTier || 'T2'
    },
    history: {
      totalPriorAttempts: 1,
      recentAttempts: [
        {
          txnRef: params.txnRef || `txn_${params.caseRef}`,
          paymentMethod: params.paymentMethod || 'card',
          status: 'failed',
          declineReason: params.failureReason || 'Declined',
          createdAt: '2026-09-01T12:00:00.000Z'
        }
      ],
      isTruncated: false
    },
    observability: {
      correlationId: `01GOLDENCASE_${params.caseRef}`,
      assemblyDurationMs: 5
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Curated Golden Dataset Corpus (AI-011 Requirement 1)              */
/* ------------------------------------------------------------------ */

export const GOLDEN_DATASET: GoldenTestCase[] = [
  // 1. TECHNICAL_TRANSIENT / Gateway Timeout (Signal: payment_failed, Rich Context)
  {
    id: 'GOLD-001',
    name: 'Gateway Timeout on Card Payment',
    description: 'Upstream gateway 504 timeout during checkout. High confidence transient technical glitch.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g001',
      orderRef: 'order_ref_g001',
      txnRef: 'txn_ref_g001',
      amountMinorUnits: 450000,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'TECHNICAL_TRANSIENT',
      failureReason: '504 Gateway Timeout: Upstream processor unresponsive',
      priorSuccessCount: 12,
      priorFailureCount: 0
    }),
    expectedCategory: 'TECHNICAL_TRANSIENT',
    expectedRecoverable: true,
    acceptableStrategies: ['IMMEDIATE_RETRY', 'DELAYED_RETRY'],
    expectedPrimaryTool: 'schedule_payment_retry',
    labeller: 'payments_expert_1',
    labelledAt: '2026-08-20',
    consensusFlag: true,
    labellingRationale: 'Gateway 504 timeouts are classically transient. Zero customer culpability, retry is highest ROI.',
    isHeldOut: false
  },

  // 2. INSUFFICIENT_FUNDS (Signal: payment_failed, Rich Context)
  {
    id: 'GOLD-002',
    name: 'Insufficient Funds on Salary Day Window',
    description: 'Decline code 51 (insufficient funds) on recurring order.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g002',
      orderRef: 'order_ref_g002',
      txnRef: 'txn_ref_g002',
      amountMinorUnits: 125000,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'INSUFFICIENT_FUNDS',
      failureReason: '51: Insufficient Funds in Account',
      priorSuccessCount: 8,
      priorFailureCount: 2
    }),
    expectedCategory: 'INSUFFICIENT_FUNDS',
    expectedRecoverable: true,
    acceptableStrategies: ['DELAYED_RETRY', 'CUSTOMER_OUTREACH'],
    expectedPrimaryTool: 'schedule_payment_retry',
    labeller: 'payments_expert_2',
    labelledAt: '2026-08-20',
    consensusFlag: true,
    labellingRationale: 'Insufficient funds on existing loyal customer is recoverable via delayed retry or gentle nudge.',
    isHeldOut: false
  },

  // 3. AUTHENTICATION_FAILED / 3DS Timeout (Signal: payment_failed, Sparse Context)
  {
    id: 'GOLD-003',
    name: '3DS OTP Authentication Failure',
    description: 'Customer failed to submit 3DS OTP in time during checkout.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g003',
      orderRef: 'order_ref_g003',
      txnRef: 'txn_ref_g003',
      amountMinorUnits: 89000,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'AUTHENTICATION_FAILED',
      failureReason: '3DS_AUTH_FAILED: OTP validation timed out by customer',
      priorSuccessCount: 0,
      priorFailureCount: 1
    }),
    expectedCategory: 'AUTHENTICATION_FAILED',
    expectedRecoverable: true,
    acceptableStrategies: ['CUSTOMER_OUTREACH', 'ALTERNATE_PAYMENT_METHOD'],
    expectedPrimaryTool: 'send_recovery_link',
    labeller: 'risk_team_1',
    labelledAt: '2026-08-21',
    consensusFlag: true,
    labellingRationale: 'Authentication failure requires customer participation; automated retry without OTP will fail again.',
    isHeldOut: false
  },

  // 4. CARD_EXPIRED (Signal: payment_failed, Rich Context)
  {
    id: 'GOLD-004',
    name: 'Card Expired on Subscription Charge',
    description: 'Card validity date lapsed. Requires updated payment method.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g004',
      orderRef: 'order_ref_g004',
      txnRef: 'txn_ref_g004',
      amountMinorUnits: 299900,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'CARD_EXPIRED',
      failureReason: '54: Expired Card',
      priorSuccessCount: 24,
      priorFailureCount: 0
    }),
    expectedCategory: 'CARD_EXPIRED',
    expectedRecoverable: true,
    acceptableStrategies: ['ALTERNATE_PAYMENT_METHOD', 'CUSTOMER_OUTREACH'],
    expectedPrimaryTool: 'request_alternate_instrument',
    labeller: 'payments_expert_1',
    labelledAt: '2026-08-21',
    consensusFlag: true,
    labellingRationale: 'Expired card cannot be retried on the same instrument; must prompt user for updated instrument.',
    isHeldOut: false
  },

  // 5. FRAUD_BLOCK (Signal: payment_failed, Hard Stop)
  {
    id: 'GOLD-005',
    name: 'High Risk Fraud Velocity Block',
    description: 'Risk engine blocked stolen card transaction. Hard unrecoverable.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g005',
      orderRef: 'order_ref_g005',
      txnRef: 'txn_ref_g005',
      amountMinorUnits: 999900,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'FRAUD_BLOCK',
      failureReason: 'FRAUD_SUSPECTED: Card reported lost or stolen',
      priorSuccessCount: 0,
      priorFailureCount: 4
    }),
    expectedCategory: 'FRAUD_BLOCK',
    expectedRecoverable: false,
    acceptableStrategies: ['ABANDON', 'MERCHANT_INTERVENTION'],
    expectedPrimaryTool: 'suppress_case',
    labeller: 'risk_officer_lead',
    labelledAt: '2026-08-22',
    consensusFlag: true,
    labellingRationale: 'Fraudulent transactions must never be retried or prompted with incentives.',
    isHeldOut: false
  },

  // 6. ISSUER_DOWN (Signal: gateway_timeout / payment_failed)
  {
    id: 'GOLD-006',
    name: 'Issuing Bank Host Outage',
    description: 'HDFC issuer host down with connection refusal.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g006',
      orderRef: 'order_ref_g006',
      txnRef: 'txn_ref_g006',
      amountMinorUnits: 150000,
      paymentMethod: 'netbanking',
      originatingSignal: 'payment.failed',
      failureCategory: 'ISSUER_DOWN',
      failureReason: '91: Issuer or switch inoperative',
      priorSuccessCount: 3,
      priorFailureCount: 0
    }),
    expectedCategory: 'ISSUER_DOWN',
    expectedRecoverable: true,
    acceptableStrategies: ['DELAYED_RETRY', 'ALTERNATE_PAYMENT_METHOD'],
    expectedPrimaryTool: 'schedule_payment_retry',
    labeller: 'payments_expert_2',
    labelledAt: '2026-08-22',
    consensusFlag: true,
    labellingRationale: 'Systemic issuer downtime recovers once the bank switch comes back online.',
    isHeldOut: false
  },

  // 7. ISSUER_SOFT_DECLINE (Signal: payment_failed)
  {
    id: 'GOLD-007',
    name: 'Temporary Issuer Soft Decline',
    description: 'Bank returned generic soft decline with retry advised.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g007',
      orderRef: 'order_ref_g007',
      txnRef: 'txn_ref_g007',
      amountMinorUnits: 50000,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'ISSUER_SOFT_DECLINE',
      failureReason: 'SOFT_DECLINE: Issuer requested retry after cooldown',
      priorSuccessCount: 6,
      priorFailureCount: 1
    }),
    expectedCategory: 'ISSUER_SOFT_DECLINE',
    expectedRecoverable: true,
    acceptableStrategies: ['DELAYED_RETRY', 'IMMEDIATE_RETRY'],
    expectedPrimaryTool: 'schedule_payment_retry',
    labeller: 'payments_expert_1',
    labelledAt: '2026-08-23',
    consensusFlag: true,
    labellingRationale: 'Soft decline is safe to retry after a short delay.',
    isHeldOut: false
  },

  // 8. ISSUER_HARD_DECLINE (Signal: payment_failed)
  {
    id: 'GOLD-008',
    name: 'Account Closed Permanent Decline',
    description: 'Issuer returned permanent decline code: account closed.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g008',
      orderRef: 'order_ref_g008',
      txnRef: 'txn_ref_g008',
      amountMinorUnits: 200000,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'ISSUER_HARD_DECLINE',
      failureReason: '14: Invalid Card Number / Account Closed',
      priorSuccessCount: 1,
      priorFailureCount: 3
    }),
    expectedCategory: 'ISSUER_HARD_DECLINE',
    expectedRecoverable: false,
    acceptableStrategies: ['ALTERNATE_PAYMENT_METHOD', 'ABANDON'],
    expectedPrimaryTool: 'request_alternate_instrument',
    labeller: 'payments_expert_2',
    labelledAt: '2026-08-23',
    consensusFlag: true,
    labellingRationale: 'Hard decline on card means instrument is dead. Must switch method or abandon.',
    isHeldOut: false
  },

  // 9. Abandonment Signal at Details Entered (Signal: abandonment)
  {
    id: 'GOLD-009',
    name: 'Checkout Abandoned at Payment Step',
    description: 'Customer entered details but abandoned before completing payment.',
    signalType: 'abandonment',
    context: makeContext({
      caseRef: 'case_ref_g009',
      orderRef: 'order_ref_g009',
      amountMinorUnits: 350000,
      paymentMethod: 'upi',
      originatingSignal: 'checkout.abandoned',
      failureCategory: 'AUTHENTICATION_FAILED',
      failureReason: 'Customer abandoned checkout at UPI app transition',
      priorSuccessCount: 2,
      priorFailureCount: 0
    }),
    expectedCategory: 'AUTHENTICATION_FAILED',
    expectedRecoverable: true,
    acceptableStrategies: ['CUSTOMER_OUTREACH', 'ALTERNATE_PAYMENT_METHOD'],
    expectedPrimaryTool: 'send_recovery_link',
    labeller: 'growth_lead_1',
    labelledAt: '2026-08-24',
    consensusFlag: true,
    labellingRationale: 'Abandonment at transition is recoverable via WhatsApp/SMS recovery link.',
    isHeldOut: false
  },

  /* ------------------------------------------------------------------ */
  /*  Held-Out Evaluation Set (Contamination-Free CI Gate)             */
  /* ------------------------------------------------------------------ */

  // 10. Held-Out: Network Timeout (Signal: payment_failed)
  {
    id: 'GOLD-010-HELD_OUT',
    name: 'Held-Out: Switch Socket Disconnect',
    description: 'Payment switch TCP socket reset mid-handshake.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g010',
      orderRef: 'order_ref_g010',
      txnRef: 'txn_ref_g010',
      amountMinorUnits: 650000,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'NETWORK_TIMEOUT',
      failureReason: 'ECONNRESET: Connection reset by peer during authorization',
      priorSuccessCount: 15,
      priorFailureCount: 1
    }),
    expectedCategory: 'NETWORK_TIMEOUT',
    expectedRecoverable: true,
    acceptableStrategies: ['IMMEDIATE_RETRY', 'DELAYED_RETRY'],
    expectedPrimaryTool: 'schedule_payment_retry',
    labeller: 'independent_auditor_1',
    labelledAt: '2026-08-25',
    consensusFlag: true,
    labellingRationale: 'Network disconnect during authorization is a transient transport error.',
    isHeldOut: true
  },

  // 11. Held-Out: Velocity Limit Exceeded
  {
    id: 'GOLD-011-HELD_OUT',
    name: 'Held-Out: Card Velocity Limit Hit',
    description: 'Bank blocked transaction due to too many attempts in 1 hour.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g011',
      orderRef: 'order_ref_g011',
      txnRef: 'txn_ref_g011',
      amountMinorUnits: 120000,
      paymentMethod: 'card',
      originatingSignal: 'payment.failed',
      failureCategory: 'VELOCITY_LIMIT',
      failureReason: 'VELOCITY_EXCEEDED: Exceeded allowable payment attempts for card in 1 hour',
      priorSuccessCount: 4,
      priorFailureCount: 3
    }),
    expectedCategory: 'VELOCITY_LIMIT',
    expectedRecoverable: true,
    acceptableStrategies: ['DELAYED_RETRY', 'ALTERNATE_PAYMENT_METHOD'],
    expectedPrimaryTool: 'schedule_payment_retry',
    labeller: 'independent_auditor_1',
    labelledAt: '2026-08-25',
    consensusFlag: true,
    labellingRationale: 'Velocity blocks expire after the window elapses; delayed retry after 24h succeeds.',
    isHeldOut: true
  },

  // 12. Held-Out: Insufficient Funds Low Value
  {
    id: 'GOLD-012-HELD_OUT',
    name: 'Held-Out: UPI Insufficient Balance',
    description: 'UPI transaction declined with balance insufficient code.',
    signalType: 'payment_failed',
    context: makeContext({
      caseRef: 'case_ref_g012',
      orderRef: 'order_ref_g012',
      txnRef: 'txn_ref_g012',
      amountMinorUnits: 25000,
      paymentMethod: 'upi',
      originatingSignal: 'payment.failed',
      failureCategory: 'INSUFFICIENT_FUNDS',
      failureReason: 'UPI_U16: Insufficient funds in payer account',
      priorSuccessCount: 9,
      priorFailureCount: 0
    }),
    expectedCategory: 'INSUFFICIENT_FUNDS',
    expectedRecoverable: true,
    acceptableStrategies: ['DELAYED_RETRY', 'CUSTOMER_OUTREACH'],
    expectedPrimaryTool: 'schedule_payment_retry',
    labeller: 'independent_auditor_1',
    labelledAt: '2026-08-25',
    consensusFlag: true,
    labellingRationale: 'Standard insufficient funds in UPI. Delayed retry or reminder recovers.',
    isHeldOut: true
  }
];
