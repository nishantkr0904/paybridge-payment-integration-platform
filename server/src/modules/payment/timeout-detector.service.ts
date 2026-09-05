import { env } from '../../config/env.js';
import { HttpError } from '../../utils/http-error.js';
import { logger } from '../../utils/logger.js';
import { generateUlid } from '../../utils/ulid.js';
import { findOrderByRef } from './payment.repository.js';
import { findPendingOrdersForTimeoutDetection } from './abandonment.repository.js';
import { ingestCheckoutAbandonment } from './abandonment.service.js';
import {
  CHECKOUT_ABANDONMENT_STAGES,
  PAYMENT_METHODS,
  type AbandonmentPaymentMethod,
  type CheckoutAbandonmentStage
} from './abandonment.types.js';
import type { Order, OrderStatus } from './payment.types.js';

/* ------------------------------------------------------------------ */
/*  Types & Interfaces (SIG-002 / BT-D2)                              */
/* ------------------------------------------------------------------ */

export interface TimeoutDetectionOptions {
  merchantId?: number;
  timeoutThresholdSeconds?: number;
  limit?: number;
  now?: Date;
  correlationId?: string;
  traceId?: string;
}

export interface TimeoutDetectionResultItem {
  orderRef: string;
  merchantId: number;
  abandoned: boolean;
  isDuplicate: boolean;
  dwellTimeSeconds: number;
  stage: CheckoutAbandonmentStage;
  eventId?: string;
  reason?: string;
}

export interface TimeoutDetectionReport {
  scannedCount: number;
  detectedCount: number;
  skippedCount: number;
  duplicateCount: number;
  abandonedOrderRefs: string[];
  results: TimeoutDetectionResultItem[];
  scannedAt: string;
  thresholdSeconds: number;
}

export interface SingleTimeoutCheckResult {
  orderRef: string;
  merchantId: number;
  status: OrderStatus;
  isAbandoned: boolean;
  isDuplicate: boolean;
  dwellTimeSeconds: number;
  thresholdSeconds: number;
  stage?: CheckoutAbandonmentStage;
  eventId?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/*  Helper: Extract Inactivity Info from Order Metadata               */
/* ------------------------------------------------------------------ */

interface InactivityInfo {
  lastActiveDate: Date;
  stage: CheckoutAbandonmentStage;
  sessionId?: string;
  selectedPaymentMethod?: AbandonmentPaymentMethod;
  validationFailureCount: number;
  customerEmail?: string;
  customerPhone?: string;
  hasConsentedChannel: boolean;
  isPriorTimeoutDuplicate: boolean;
}

function extractInactivityInfo(order: Order, _now: Date): InactivityInfo {
  let metadata: Record<string, unknown> = {};
  if (order.metadata) {
    if (typeof order.metadata === 'string') {
      try {
        metadata = JSON.parse(order.metadata);
      } catch {
        metadata = {};
      }
    } else if (typeof order.metadata === 'object') {
      metadata = { ...order.metadata };
    }
  }

  const checkoutSession =
    typeof metadata.checkoutSession === 'object' && metadata.checkoutSession !== null
      ? (metadata.checkoutSession as Record<string, unknown>)
      : null;

  // 1. Determine lastActiveDate (order.metadata.lastActiveAt -> checkoutSession.lastActiveAt -> order.createdAt)
  let lastActiveDate = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt);

  const rawLastActiveAt =
    (typeof metadata.lastActiveAt === 'string' && metadata.lastActiveAt) ||
    (checkoutSession && typeof checkoutSession.lastActiveAt === 'string' && checkoutSession.lastActiveAt);

  if (rawLastActiveAt && !isNaN(Date.parse(rawLastActiveAt))) {
    lastActiveDate = new Date(rawLastActiveAt);
  }

  // 2. Determine checkout stage
  let stage: CheckoutAbandonmentStage = 'arrived_only';
  const rawStage =
    (typeof metadata.stage === 'string' && metadata.stage) ||
    (checkoutSession && typeof checkoutSession.stage === 'string' && checkoutSession.stage);

  if (rawStage && CHECKOUT_ABANDONMENT_STAGES.includes(rawStage as CheckoutAbandonmentStage)) {
    stage = rawStage as CheckoutAbandonmentStage;
  } else if (
    (typeof metadata.selectedPaymentMethod === 'string' && metadata.selectedPaymentMethod) ||
    (checkoutSession && typeof checkoutSession.selectedPaymentMethod === 'string')
  ) {
    stage = 'method_selected';
  }

  // 3. Extract payment method
  let selectedPaymentMethod: AbandonmentPaymentMethod | undefined = undefined;
  const rawMethod =
    (typeof metadata.selectedPaymentMethod === 'string' && metadata.selectedPaymentMethod) ||
    (checkoutSession && typeof checkoutSession.selectedPaymentMethod === 'string' && checkoutSession.selectedPaymentMethod);

  if (rawMethod && PAYMENT_METHODS.includes(rawMethod.toLowerCase() as AbandonmentPaymentMethod)) {
    selectedPaymentMethod = rawMethod.toLowerCase() as AbandonmentPaymentMethod;
  }

  // 4. Session ID
  const sessionId =
    (typeof metadata.sessionId === 'string' && metadata.sessionId) ||
    (checkoutSession && typeof checkoutSession.sessionId === 'string' && checkoutSession.sessionId) ||
    undefined;

  // 5. Validation failure count
  const rawFailures =
    metadata.validationFailureCount ?? checkoutSession?.validationFailureCount ?? 0;
  const validationFailureCount =
    typeof rawFailures === 'number' && rawFailures >= 0 ? Math.floor(rawFailures) : 0;

  // 6. Contact info
  const customerEmail =
    (typeof metadata.customerEmail === 'string' && metadata.customerEmail) ||
    (checkoutSession && typeof checkoutSession.customerEmail === 'string' && checkoutSession.customerEmail) ||
    order.customerEmail ||
    undefined;

  const customerPhone =
    (typeof metadata.customerPhone === 'string' && metadata.customerPhone) ||
    (checkoutSession && typeof checkoutSession.customerPhone === 'string' && checkoutSession.customerPhone) ||
    undefined;

  // 7. Consented channel
  const hasConsentedChannel = Boolean(
    metadata.hasConsentedChannel || checkoutSession?.hasConsentedChannel
  );

  // 8. Deduplication against prior timeout_detector runs
  let isPriorTimeoutDuplicate = false;
  const latestAbandonment =
    typeof metadata.latestAbandonment === 'object' && metadata.latestAbandonment !== null
      ? (metadata.latestAbandonment as Record<string, unknown>)
      : undefined;

  if (latestAbandonment && latestAbandonment.source === 'timeout_detector') {
    const prevTimeStr =
      (typeof latestAbandonment.lastActiveAt === 'string' && latestAbandonment.lastActiveAt) ||
      (typeof latestAbandonment.abandonedAt === 'string' && latestAbandonment.abandonedAt);

    if (prevTimeStr && !isNaN(Date.parse(prevTimeStr))) {
      const prevTime = new Date(prevTimeStr);
      // If no new checkout activity occurred since the previous timeout abandonment event
      if (lastActiveDate.getTime() <= prevTime.getTime()) {
        isPriorTimeoutDuplicate = true;
      }
    }
  }

  return {
    lastActiveDate,
    stage,
    sessionId,
    selectedPaymentMethod,
    validationFailureCount,
    customerEmail,
    customerPhone,
    hasConsentedChannel,
    isPriorTimeoutDuplicate
  };
}

/* ------------------------------------------------------------------ */
/*  Batch Timeout Detection Service (SIG-002 / BT-D2)                 */
/* ------------------------------------------------------------------ */

export async function detectCheckoutAbandonmentTimeouts(
  options: TimeoutDetectionOptions = {}
): Promise<TimeoutDetectionReport> {
  const correlationId = options.correlationId || generateUlid();
  const traceId = options.traceId || correlationId;
  const now = options.now || new Date();
  const thresholdSeconds =
    options.timeoutThresholdSeconds && options.timeoutThresholdSeconds > 0
      ? options.timeoutThresholdSeconds
      : env.CHECKOUT_ABANDONMENT_TIMEOUT_SECONDS;

  const serviceLogger = logger.child({
    correlationId,
    traceId,
    merchantId: options.merchantId,
    thresholdSeconds
  });

  serviceLogger.info('Starting checkout abandonment timeout detection run');

  // Fetch pending orders eligible for timeout detection (SEC-002, Invariant I9)
  const pendingOrders = await findPendingOrdersForTimeoutDetection({
    merchantId: options.merchantId,
    limit: options.limit
  });

  let detectedCount = 0;
  let skippedCount = 0;
  let duplicateCount = 0;
  const abandonedOrderRefs: string[] = [];
  const results: TimeoutDetectionResultItem[] = [];

  for (const order of pendingOrders) {
    // 1. Strictly non-terminal validation (Invariant: only pending orders can be timed out)
    if (order.status !== 'pending') {
      skippedCount++;
      results.push({
        orderRef: order.orderRef,
        merchantId: order.merchantId,
        abandoned: false,
        isDuplicate: false,
        dwellTimeSeconds: 0,
        stage: 'arrived_only',
        reason: 'order_not_pending'
      });
      continue;
    }

    // 2. Extract inactivity metrics
    const info = extractInactivityInfo(order, now);
    const dwellTimeSeconds = Math.max(
      0,
      Math.floor((now.getTime() - info.lastActiveDate.getTime()) / 1000)
    );

    // 3. Exact threshold boundary check
    if (dwellTimeSeconds < thresholdSeconds) {
      skippedCount++;
      results.push({
        orderRef: order.orderRef,
        merchantId: order.merchantId,
        abandoned: false,
        isDuplicate: false,
        dwellTimeSeconds,
        stage: info.stage,
        reason: 'within_timeout_threshold'
      });
      continue;
    }

    // 4. Check if already marked abandoned by timeout detector with no new activity
    if (info.isPriorTimeoutDuplicate) {
      duplicateCount++;
      results.push({
        orderRef: order.orderRef,
        merchantId: order.merchantId,
        abandoned: false,
        isDuplicate: true,
        dwellTimeSeconds,
        stage: info.stage,
        reason: 'already_timed_out_no_new_activity'
      });
      continue;
    }

    // 5. Ingest canonical abandonment event with source = 'timeout_detector'
    try {
      const ingestionResult = await ingestCheckoutAbandonment({
        merchantId: order.merchantId,
        orderRef: order.orderRef,
        input: {
          sessionId: info.sessionId,
          stage: info.stage,
          selectedPaymentMethod: info.selectedPaymentMethod,
          dwellTimeSeconds,
          validationFailureCount: info.validationFailureCount,
          customerEmail: info.customerEmail,
          customerPhone: info.customerPhone,
          hasConsentedChannel: info.hasConsentedChannel,
          lastActiveAt: info.lastActiveDate.toISOString(),
          abandonedAt: now.toISOString(),
          source: 'timeout_detector',
          metadata: {
            detectedBy: 'timeout_detector',
            timeoutThresholdSeconds: thresholdSeconds,
            dwellTimeSeconds
          }
        },
        correlationId,
        traceId
      });

      if (ingestionResult.isDuplicate) {
        duplicateCount++;
        results.push({
          orderRef: order.orderRef,
          merchantId: order.merchantId,
          abandoned: false,
          isDuplicate: true,
          dwellTimeSeconds,
          stage: info.stage,
          eventId: ingestionResult.eventId,
          reason: 'duplicate_event_detected'
        });
      } else {
        detectedCount++;
        abandonedOrderRefs.push(order.orderRef);
        results.push({
          orderRef: order.orderRef,
          merchantId: order.merchantId,
          abandoned: true,
          isDuplicate: false,
          dwellTimeSeconds,
          stage: info.stage,
          eventId: ingestionResult.eventId
        });
      }
    } catch (ingestErr) {
      serviceLogger.error(
        { orderRef: order.orderRef, err: ingestErr },
        'Error ingesting timeout abandonment event for order'
      );
      skippedCount++;
      results.push({
        orderRef: order.orderRef,
        merchantId: order.merchantId,
        abandoned: false,
        isDuplicate: false,
        dwellTimeSeconds,
        stage: info.stage,
        reason: ingestErr instanceof Error ? ingestErr.message : 'ingestion_failed'
      });
    }
  }

  const report: TimeoutDetectionReport = {
    scannedCount: pendingOrders.length,
    detectedCount,
    skippedCount,
    duplicateCount,
    abandonedOrderRefs,
    results,
    scannedAt: now.toISOString(),
    thresholdSeconds
  };

  serviceLogger.info(
    {
      scannedCount: report.scannedCount,
      detectedCount: report.detectedCount,
      skippedCount: report.skippedCount,
      duplicateCount: report.duplicateCount
    },
    'Completed checkout abandonment timeout detection run'
  );

  return report;
}

/* ------------------------------------------------------------------ */
/*  Single Order Timeout Evaluation Service (Tenant-Scoped)           */
/* ------------------------------------------------------------------ */

export async function checkOrderTimeout(
  orderRef: string,
  merchantId: number,
  options: Omit<TimeoutDetectionOptions, 'merchantId'> = {}
): Promise<SingleTimeoutCheckResult> {
  const correlationId = options.correlationId || generateUlid();
  const traceId = options.traceId || correlationId;
  const now = options.now || new Date();
  const thresholdSeconds =
    options.timeoutThresholdSeconds && options.timeoutThresholdSeconds > 0
      ? options.timeoutThresholdSeconds
      : env.CHECKOUT_ABANDONMENT_TIMEOUT_SECONDS;

  // 1. Tenant-scoped lookup (SEC-002, Invariant I9)
  const order = await findOrderByRef(orderRef, merchantId);
  if (!order) {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order does not exist or does not belong to merchant.');
  }

  // 2. Terminal state checks
  if (order.status === 'success') {
    throw new HttpError(409, 'ORDER_ALREADY_PAID', 'This order has already been successfully paid and cannot be abandoned.');
  }
  if (order.status === 'failed') {
    throw new HttpError(409, 'ORDER_ALREADY_FAILED', 'This order is already in failed status.');
  }

  // 3. Extract inactivity info
  const info = extractInactivityInfo(order, now);
  const dwellTimeSeconds = Math.max(
    0,
    Math.floor((now.getTime() - info.lastActiveDate.getTime()) / 1000)
  );

  // 4. Boundary check
  if (dwellTimeSeconds < thresholdSeconds) {
    return {
      orderRef: order.orderRef,
      merchantId: order.merchantId,
      status: order.status,
      isAbandoned: false,
      isDuplicate: false,
      dwellTimeSeconds,
      thresholdSeconds,
      stage: info.stage,
      reason: 'within_timeout_threshold'
    };
  }

  // 5. Prior duplicate check
  if (info.isPriorTimeoutDuplicate) {
    return {
      orderRef: order.orderRef,
      merchantId: order.merchantId,
      status: order.status,
      isAbandoned: false,
      isDuplicate: true,
      dwellTimeSeconds,
      thresholdSeconds,
      stage: info.stage,
      reason: 'already_timed_out_no_new_activity'
    };
  }

  // 6. Ingest canonical abandonment event
  const ingestionResult = await ingestCheckoutAbandonment({
    merchantId: order.merchantId,
    orderRef: order.orderRef,
    input: {
      sessionId: info.sessionId,
      stage: info.stage,
      selectedPaymentMethod: info.selectedPaymentMethod,
      dwellTimeSeconds,
      validationFailureCount: info.validationFailureCount,
      customerEmail: info.customerEmail,
      customerPhone: info.customerPhone,
      hasConsentedChannel: info.hasConsentedChannel,
      lastActiveAt: info.lastActiveDate.toISOString(),
      abandonedAt: now.toISOString(),
      source: 'timeout_detector',
      metadata: {
        detectedBy: 'timeout_detector',
        timeoutThresholdSeconds: thresholdSeconds,
        dwellTimeSeconds
      }
    },
    correlationId,
    traceId
  });

  return {
    orderRef: order.orderRef,
    merchantId: order.merchantId,
    status: order.status,
    isAbandoned: !ingestionResult.isDuplicate,
    isDuplicate: ingestionResult.isDuplicate,
    dwellTimeSeconds,
    thresholdSeconds,
    stage: info.stage,
    eventId: ingestionResult.eventId,
    reason: ingestionResult.isDuplicate ? 'duplicate_event_detected' : undefined
  };
}
