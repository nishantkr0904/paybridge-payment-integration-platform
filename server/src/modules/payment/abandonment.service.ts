import type amqp from 'amqplib';
import { recordCheckoutAbandonmentMetric } from '../../infrastructure/metrics.js';
import { publishCheckoutAbandoned, ROUTING_KEYS } from '../../infrastructure/rabbitmq.js';
import { HttpError } from '../../utils/http-error.js';
import { logger } from '../../utils/logger.js';
import { generateUlid } from '../../utils/ulid.js';
import { findOrderByRef } from './payment.repository.js';
import { recordOrderAbandonment } from './abandonment.repository.js';
import {
  CheckoutAbandonedEventSchema,
  type AbandonmentIngestionResult,
  type CheckoutAbandonedEvent,
  type CheckoutAbandonmentInput
} from './abandonment.types.js';

/* ------------------------------------------------------------------ */
/*  Ingestion Options                                                 */
/* ------------------------------------------------------------------ */

export interface IngestAbandonmentOptions {
  merchantId: number;
  orderRef: string;
  input: CheckoutAbandonmentInput;
  correlationId: string;
  traceId?: string;
  idempotencyKey?: string;
  customChannel?: amqp.Channel;
}

/* ------------------------------------------------------------------ */
/*  Ingest Checkout Abandonment Service (SIG-002 / BT-D1)             */
/* ------------------------------------------------------------------ */

export async function ingestCheckoutAbandonment(
  options: IngestAbandonmentOptions
): Promise<AbandonmentIngestionResult> {
  const { merchantId, orderRef, input, correlationId, traceId, idempotencyKey, customChannel } = options;
  const activeTraceId = traceId || correlationId;

  const serviceLogger = logger.child({
    merchantId,
    orderRef,
    correlationId,
    traceId: activeTraceId,
    stage: input.stage
  });

  // 1. Tenant-scoped order lookup (SEC-002, Invariant I9)
  const order = await findOrderByRef(orderRef, merchantId);
  if (!order) {
    serviceLogger.warn('Order not found or cross-tenant access attempted');
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order does not exist or does not belong to merchant.');
  }

  // 2. Terminal state checks: cannot abandon an already completed or failed order
  if (order.status === 'success') {
    serviceLogger.warn({ orderStatus: order.status }, 'Attempted to record abandonment on an already completed order');
    throw new HttpError(409, 'ORDER_ALREADY_PAID', 'This order has already been successfully paid and cannot be abandoned.');
  }

  if (order.status === 'failed') {
    serviceLogger.warn({ orderStatus: order.status }, 'Attempted to record abandonment on an already failed order');
    throw new HttpError(409, 'ORDER_ALREADY_FAILED', 'This order is already in failed status.');
  }

  // 3. Exact integer minor-unit money calculation (Invariants I5, ADB-001)
  const amountMinorUnits = Math.round(Number(order.amount) * 100);
  if (isNaN(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new HttpError(400, 'INVALID_AMOUNT', 'Order amount must resolve to a positive minor-unit value.');
  }

  const nowIso = new Date().toISOString();
  const eventId = generateUlid();

  // 4. Construct canonical event object
  const rawEvent: CheckoutAbandonedEvent = {
    eventId,
    eventType: 'checkout.abandoned',
    merchantId,
    orderId: order.id,
    orderRef: order.orderRef,
    sessionId: input.sessionId || null,
    stage: input.stage,
    selectedPaymentMethod: input.selectedPaymentMethod || null,
    dwellTimeSeconds: input.dwellTimeSeconds ?? 0,
    validationFailureCount: input.validationFailureCount ?? 0,
    amountMinorUnits,
    currency: (order.currency || 'INR').toUpperCase(),
    customerEmail: input.customerEmail || order.customerEmail || null,
    customerPhone: input.customerPhone || null,
    hasConsentedChannel: input.hasConsentedChannel ?? false,
    lastActiveAt: input.lastActiveAt || nowIso,
    abandonedAt: input.abandonedAt || nowIso,
    source: input.source || 'merchant_api',
    correlationId,
    traceId: activeTraceId,
    idempotencyKey,
    metadata: input.metadata
  };

  // Validate canonical schema strictly
  const validatedEvent = CheckoutAbandonedEventSchema.parse(rawEvent);

  // 5. Persist event onto order metadata transactionally with deduplication
  const { isDuplicate } = await recordOrderAbandonment(merchantId, order.id, validatedEvent);

  // 6. RabbitMQ dispatch: ONLY publish downstream if NOT duplicate
  if (!isDuplicate) {
    try {
      await publishCheckoutAbandoned(validatedEvent, customChannel);
      serviceLogger.info(
        { eventId, stage: validatedEvent.stage, amountMinorUnits },
        'Checkout abandonment event ingested and published to RabbitMQ'
      );
    } catch (publishErr) {
      serviceLogger.error(
        { err: publishErr },
        'Failed to publish checkout abandonment event to RabbitMQ'
      );
      // Durably persisted in order metadata even if broker publish fails
    }

    // 7. Record Prometheus metrics (SIG-002 / BT-D2)
    recordCheckoutAbandonmentMetric({
      stage: validatedEvent.stage,
      source: validatedEvent.source,
      dwellTimeSeconds: validatedEvent.dwellTimeSeconds
    });
  } else {
    serviceLogger.info(
      { eventId, stage: validatedEvent.stage },
      'Duplicate checkout abandonment event detected; skipped downstream RabbitMQ publication'
    );
  }

  return {
    success: true,
    eventId: validatedEvent.eventId,
    orderRef: validatedEvent.orderRef,
    merchantId: validatedEvent.merchantId,
    stage: validatedEvent.stage,
    amountMinorUnits: validatedEvent.amountMinorUnits,
    currency: validatedEvent.currency,
    isDuplicate,
    routingKey: ROUTING_KEYS.CHECKOUT_ABANDONED,
    correlationId: validatedEvent.correlationId,
    timestamp: validatedEvent.abandonedAt
  };
}
