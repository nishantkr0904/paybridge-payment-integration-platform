import { HttpError } from '../../utils/http-error.js';
import { generateUlid } from '../../utils/ulid.js';
import {
  createCaseWithEvent,
  findCaseById,
  findCaseByRef,
  findCaseByTransactionId,
  findCaseEventsByCaseId,
  findCasesByMerchantId,
  transitionCaseStatus
} from './case.repository.js';
import type {
  ActorType,
  CaseEvent,
  CaseStatus,
  PaymentFailedEvent,
  RecoveryCase
} from './case.types.js';

/* ------------------------------------------------------------------ */
/*  Case Service Operations                                           */
/* ------------------------------------------------------------------ */

/**
 * Ingests a PaymentFailed event into the recovery domain.
 * Idempotently creates or returns existing case, logging CaseCreated event.
 */
export async function ingestPaymentFailure(
  event: PaymentFailedEvent
): Promise<{ case: RecoveryCase; isNew: boolean }> {
  // Idempotency check: natural key on (merchantId, transactionId)
  const existingCase = await findCaseByTransactionId(event.transactionId, event.merchantId);
  if (existingCase) {
    return { case: existingCase, isNew: false };
  }

  const createdCase = await createCaseWithEvent(
    event.merchantId,
    {
      orderId: event.orderId,
      transactionId: event.transactionId,
      recoverableAmount: event.amount,
      currency: event.currency || 'INR',
      originatingSignal: event.eventType || 'PAYMENT_FAILED',
      failureCategory: event.failureCategory ?? null,
      correlationId: event.correlationId,
      initialStatus: 'detected'
    },
    {
      fromStatus: null,
      toStatus: 'detected',
      actorType: 'system',
      actorId: 'payment_worker',
      reason: event.failureReason || 'Payment failure ingested from gateway',
      payload: {
        orderRef: event.orderRef,
        txnRef: event.txnRef,
        gatewayResponse: event.gatewayResponse
      },
      correlationId: event.correlationId
    }
  );

  return { case: createdCase, isNew: true };
}

/**
 * Retrieves a recovery case by its external ULID reference, scoped strictly to the merchant.
 */
export async function getCaseByRef(caseRef: string, merchantId: number): Promise<RecoveryCase> {
  const recoveryCase = await findCaseByRef(caseRef, merchantId);
  if (!recoveryCase) {
    throw new HttpError(404, 'CASE_NOT_FOUND', 'Recovery case does not exist.');
  }
  return recoveryCase;
}

/**
 * Retrieves a recovery case by internal ID, scoped strictly to the merchant.
 */
export async function getCaseById(caseId: number, merchantId: number): Promise<RecoveryCase> {
  const recoveryCase = await findCaseById(caseId, merchantId);
  if (!recoveryCase) {
    throw new HttpError(404, 'CASE_NOT_FOUND', 'Recovery case does not exist.');
  }
  return recoveryCase;
}

/**
 * Lists all recovery cases for the authenticated merchant.
 */
export async function listCases(merchantId: number): Promise<RecoveryCase[]> {
  return findCasesByMerchantId(merchantId);
}

/**
 * Transitions a case to a new lifecycle state, appending to the immutable event log.
 */
export async function transitionCase(
  caseId: number,
  merchantId: number,
  toStatus: CaseStatus,
  actor: { type: ActorType; id?: string },
  reason?: string,
  payload?: Record<string, unknown>,
  correlationId?: string
): Promise<RecoveryCase> {
  const effectiveCorrelationId = correlationId || generateUlid();

  return transitionCaseStatus(caseId, merchantId, {
    toStatus,
    actorType: actor.type,
    actorId: actor.id,
    reason,
    payload,
    correlationId: effectiveCorrelationId
  });
}

/**
 * Retrieves the complete event history / audit trail for a case.
 */
export async function getCaseTimeline(
  caseId: number,
  merchantId: number
): Promise<CaseEvent[]> {
  const existing = await findCaseById(caseId, merchantId);
  if (!existing) {
    throw new HttpError(404, 'CASE_NOT_FOUND', 'Recovery case does not exist.');
  }
  return findCaseEventsByCaseId(caseId, merchantId);
}
