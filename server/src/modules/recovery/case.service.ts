import { HttpError } from '../../utils/http-error.js';
import { logger } from '../../utils/logger.js';
import { generateUlid } from '../../utils/ulid.js';
import { findActivePolicyByMerchantId } from '../policy/policy.repository.js';
import {
  findOrderById,
  findTransactionById
} from '../payment/payment.repository.js';
import {
  identifyCasesToShed,
  prioritizeCases,
  rankCasesFairly
} from './case.prioritizer.js';
import {
  bulkShedCases,
  createCaseWithEvent,
  findActiveCases,
  findCaseById,
  findCaseByRef,
  findCaseByTransactionId,
  findCaseEventsByCaseId,
  findCasesByMerchantId,
  findCasesWithFilters,
  getShedEventCount,
  transitionCaseStatus
} from './case.repository.js';
import type {
  ActorType,
  CaseEvent,
  CaseStatus,
  LedgerFilters,
  PaymentFailedEvent,
  PrioritizedCase,
  QueueMetrics,
  RecoveryCase,
  RevenueLedger
} from './case.types.js';
import { computeRevenueLedger } from './ledger.service.js';

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
  // 1. Verify tenant-owned transaction/order relationship (SEC-002 / I9)
  if (event.transactionId) {
    const txn = await findTransactionById(event.transactionId, event.merchantId);
    if (!txn) {
      throw new Error(
        `Transaction ${event.transactionId} does not exist or does not belong to merchant ${event.merchantId}`
      );
    }
  } else if (event.orderId) {
    const order = await findOrderById(event.orderId, event.merchantId);
    if (!order) {
      throw new Error(
        `Order ${event.orderId} does not exist or does not belong to merchant ${event.merchantId}`
      );
    }
  }

  // 2. Idempotency check: natural key on (merchantId, transactionId)
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

/* ------------------------------------------------------------------ */
/*  Prioritisation Queue & Fairness Operations (RCV-002)             */
/* ------------------------------------------------------------------ */

/**
 * Retrieves the prioritized recovery queue with per-merchant fairness scheduling.
 * (RCV-002 Requirements 4, 6)
 */
export async function getPrioritizedQueue(
  merchantId?: number,
  options?: { limit?: number; maxPerMerchant?: number; evaluationTime?: Date }
): Promise<PrioritizedCase[]> {
  const activeCases = await findActiveCases(merchantId);
  if (activeCases.length === 0) {
    return [];
  }

  // Pre-fetch merchant policy tiers to inform priority scoring
  const tierCache = new Map<number, import('../policy/policy.types.js').AutonomyTier>();
  const merchantIds = Array.from(new Set(activeCases.map((c) => c.merchantId)));

  for (const mId of merchantIds) {
    const policy = await findActivePolicyByMerchantId(mId);
    if (policy) {
      tierCache.set(mId, policy.autonomyTier);
    }
  }

  const prioritizedList: PrioritizedCase[] = [];
  for (const c of activeCases) {
    const tier = tierCache.get(c.merchantId) || 'T1';
    const prioritized = prioritizeCases([c], {
      evaluationTime: options?.evaluationTime,
      merchantTier: tier
    });
    prioritizedList.push(prioritized[0]!);
  }

  // Apply per-merchant fair scheduling
  return rankCasesFairly(prioritizedList, {
    limit: options?.limit,
    maxPerMerchant: options?.maxPerMerchant
  });
}

/**
 * Sheds lowest-priority cases when active queue depth exceeds capacity.
 * Explicitly transitions shed cases to 'suppressed' with audit records.
 * (RCV-002 Requirement 7)
 */
export async function shedExcessBacklog(
  capacityLimit: number,
  correlationId?: string
): Promise<{ shedCases: RecoveryCase[]; shedCount: number }> {
  const effectiveCorrelationId = correlationId || generateUlid();
  const allActive = await findActiveCases();

  if (allActive.length <= capacityLimit) {
    return { shedCases: [], shedCount: 0 };
  }

  const prioritized = prioritizeCases(allActive);
  const toShed = identifyCasesToShed(prioritized, capacityLimit);

  if (toShed.length === 0) {
    return { shedCases: [], shedCount: 0 };
  }

  // Group by merchantId for atomic scoped transitions
  const byMerchant = new Map<number, number[]>();
  for (const item of toShed) {
    const list = byMerchant.get(item.case.merchantId) || [];
    list.push(item.case.id);
    byMerchant.set(item.case.merchantId, list);
  }

  const shedCases: RecoveryCase[] = [];

  for (const [mId, caseIds] of byMerchant.entries()) {
    const updated = await bulkShedCases(
      caseIds,
      mId,
      'CAPACITY_LOAD_SHED',
      effectiveCorrelationId
    );
    shedCases.push(...updated);
  }

  logger.warn(
    {
      shedCount: shedCases.length,
      capacityLimit,
      initialActiveCount: allActive.length,
      correlationId: effectiveCorrelationId
    },
    `[Recovery Prioritizer] Load shedding executed: explicitly suppressed ${shedCases.length} low-priority cases under capacity pressure`
  );

  return { shedCases, shedCount: shedCases.length };
}

/**
 * Computes the complete Recoverable Revenue Ledger for a merchant.
 * (RCV-002 Requirements 2, 8, 10, 11)
 */
export async function getRevenueLedger(
  merchantId: number,
  filters?: LedgerFilters
): Promise<RevenueLedger> {
  const cases = await findCasesWithFilters(merchantId, filters);
  return computeRevenueLedger(merchantId, cases, filters);
}

/**
 * Retrieves queue operational metrics (depth, oldest age, shed volume).
 * (RCV-002 Requirement 9 / OBS-002)
 */
export async function getQueueMetrics(merchantId?: number): Promise<QueueMetrics> {
  const activeCases = await findActiveCases(merchantId);
  const now = Date.now();

  let oldestAgeSeconds = 0;
  const statusCounts: Record<string, number> = {};

  for (const c of activeCases) {
    const age = Math.max(0, Math.floor((now - new Date(c.createdAt).getTime()) / 1000));
    if (age > oldestAgeSeconds) {
      oldestAgeSeconds = age;
    }
    statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
  }

  const shedVolume = await getShedEventCount(merchantId);

  return {
    queueDepth: activeCases.length,
    oldestCaseAgeSeconds: oldestAgeSeconds,
    activeCasesByStatus: statusCounts,
    shedVolumeTotal: shedVolume
  };
}

export { getCaseExplainability } from './explainability.service.js';
