import { HttpError } from '../../utils/http-error.js';
import { generateUlid } from '../../utils/ulid.js';
import { findOrderById, findTransactionsByOrderId } from '../payment/payment.repository.js';
import { findActivePolicyByMerchantId } from '../policy/policy.repository.js';
import { findCaseById } from '../recovery/case.repository.js';
import {
  assertZeroPII,
  generateOpaqueReference,
  redactString
} from './redaction.service.js';
import {
  AssembledRecoveryContext,
  AssembledRecoveryContextSchema,
  AttemptSummary,
  BuildContextInput
} from './redaction.types.js';

/* ------------------------------------------------------------------ */
/*  Context Assembly & Data Minimisation (AI-009 / SIG-004)           */
/* ------------------------------------------------------------------ */

/**
 * Assembles a bounded, strictly PII-redacted context object for a recovery case.
 * Enforces repository-level tenant scoping, opaque references, allowlist filtering,
 * merchant metadata exclusion, and defense-in-depth zero-PII assertion.
 */
export async function buildRecoveryContext(
  input: BuildContextInput
): Promise<AssembledRecoveryContext> {
  const startTime = Date.now();
  const correlationId = input.correlationId || generateUlid();
  const maxHistory = input.maxHistoryRecords ?? 5;

  // 1. Tenant-scoped retrieval of recovery case
  const recoveryCase = await findCaseById(input.caseId, input.merchantId);
  if (!recoveryCase) {
    throw new HttpError(
      404,
      'NOT_FOUND',
      `Recovery case ${input.caseId} not found for merchant ${input.merchantId}`
    );
  }

  // 2. Tenant-scoped retrieval of order
  const order = await findOrderById(recoveryCase.orderId, input.merchantId);
  if (!order) {
    throw new HttpError(
      404,
      'NOT_FOUND',
      `Order ${recoveryCase.orderId} not found for merchant ${input.merchantId}`
    );
  }

  // 3. Tenant-scoped retrieval of transactions on this order
  const transactions = await findTransactionsByOrderId(recoveryCase.orderId, input.merchantId);

  // 4. Tenant-scoped active policy retrieval
  const activePolicy = await findActivePolicyByMerchantId(input.merchantId);
  const autonomyTier = activePolicy?.autonomyTier || 'T1';

  // 5. Current transaction selection
  const currentTxn =
    (recoveryCase.transactionId
      ? transactions.find((t) => t.id === recoveryCase.transactionId)
      : null) || transactions[0];

  // 6. Deterministic opaque references (AI-009 Requirement 3)
  const caseRef = generateOpaqueReference('case_ref', recoveryCase.caseRef || recoveryCase.id);
  const merchantReference = generateOpaqueReference('merchant_ref', input.merchantId);
  const customerReference = generateOpaqueReference(
    'customer_ref',
    order.customerEmail || `order_${order.id}`
  );
  const currentTxnRef = generateOpaqueReference(
    'txn_ref',
    currentTxn?.txnRef || recoveryCase.transactionId || 'none'
  );

  // 7. Extract gateway error code from response if present
  let gatewayCode: string | null = null;
  if (currentTxn?.gatewayResponse && typeof currentTxn.gatewayResponse === 'object') {
    const gw = currentTxn.gatewayResponse as Record<string, unknown>;
    gatewayCode = typeof gw.errorCode === 'string' ? gw.errorCode : null;
  }

  // 8. Customer behavioural statistics across retrieved transactions
  const successCount = transactions.filter((t) => t.status === 'success').length;
  const failureCount = transactions.filter((t) => t.status === 'failed').length;
  const knownMethods = Array.from(new Set(transactions.map((t) => t.paymentMethod)));

  // 9. Bounded historical attempt summaries (most recent first)
  const recentAttempts: AttemptSummary[] = transactions.slice(0, maxHistory).map((t) => ({
    txnRef: generateOpaqueReference('txn_ref', t.txnRef),
    paymentMethod: t.paymentMethod,
    status: t.status,
    declineReason: redactString(t.failureReason),
    createdAt: t.createdAt.toISOString()
  }));

  const caseAgeSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(recoveryCase.createdAt).getTime()) / 1000)
  );

  const assemblyDurationMs = Date.now() - startTime;

  // 10. Assemble allowlist payload (Merchant metadata is strictly excluded)
  const rawContext = {
    schemaVersion: 'v1.0.0' as const,
    assembledAt: new Date().toISOString(),
    case: {
      caseRef,
      recoverableAmountMinorUnits: recoveryCase.recoverableAmount,
      currency: recoveryCase.currency,
      originatingSignal: recoveryCase.originatingSignal,
      failureCategory: recoveryCase.failureCategory,
      caseStatus: recoveryCase.status,
      caseAgeSeconds
    },
    transaction: {
      txnRef: currentTxnRef,
      paymentMethod: currentTxn?.paymentMethod || 'unknown',
      declineReason: redactString(currentTxn?.failureReason),
      failureReason: redactString(currentTxn?.failureReason),
      gatewayCode,
      attemptNumber: transactions.length > 0 ? transactions.length : 1
    },
    customer: {
      customerReference,
      hasPriorSuccess: successCount > 0,
      priorSuccessCount: successCount,
      priorFailureCount: failureCount,
      knownPaymentMethods: knownMethods.length > 0 ? knownMethods : [currentTxn?.paymentMethod || 'card']
    },
    merchant: {
      merchantReference,
      autonomyTier
    },
    history: {
      totalPriorAttempts: transactions.length,
      recentAttempts,
      isTruncated: transactions.length > maxHistory
    },
    observability: {
      correlationId,
      assemblyDurationMs
    }
  };

  // 11. Strict Zod schema validation
  const validatedContext = AssembledRecoveryContextSchema.parse(rawContext);

  // 12. Defense-in-depth zero-PII assertion (AI-009 Requirement 5)
  assertZeroPII(validatedContext);

  return validatedContext;
}
