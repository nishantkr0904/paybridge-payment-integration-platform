import 'dotenv/config';
import type amqp from 'amqplib';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';
import type { LLMProvider } from '../infrastructure/llm/llm.types.js';
import {
  ingestPaymentFailure,
  ingestAbandonmentRecovery
} from '../modules/recovery/case.service.js';
import type { PaymentFailedEvent } from '../modules/recovery/case.types.js';
import {
  CheckoutAbandonedEventSchema,
  type CheckoutAbandonedEvent
} from '../modules/payment/abandonment.types.js';
import { logger } from '../utils/logger.js';
import { generateUlid } from '../utils/ulid.js';

export interface RecoveryChannel {
  ack(message: amqp.Message, allUpTo?: boolean): void;
  nack(message: amqp.Message, allUpTo?: boolean, requeue?: boolean): void;
}

export async function handleRecoveryMessage(
  channel: RecoveryChannel,
  msg: amqp.ConsumeMessage
): Promise<void> {
  const correlationId =
    (msg.properties?.headers?.['x-correlation-id'] as string | undefined) ||
    (msg.properties?.headers?.traceId as string | undefined) ||
    msg.properties?.correlationId ||
    generateUlid();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(msg.content.toString());
  } catch (err) {
    logger.error(
      { err, correlationId, traceId: correlationId },
      '[Recovery Worker] Failed to parse message JSON, sending to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  const {
    merchantId,
    orderId,
    transactionId,
    orderRef,
    txnRef,
    amount,
    currency = 'INR',
    failureCategory,
    failureReason,
    gatewayResponse
  } = payload as {
    merchantId?: number;
    orderId?: number;
    transactionId?: number;
    orderRef?: string;
    txnRef?: string;
    amount?: number;
    currency?: string;
    failureCategory?: string;
    failureReason?: string;
    gatewayResponse?: Record<string, unknown>;
  };

  const workerLogger = logger.child({
    correlationId,
    traceId: correlationId,
    transactionId,
    merchantId
  });

  // Validate required payment failure attributes
  if (
    typeof merchantId !== 'number' ||
    typeof orderId !== 'number' ||
    typeof transactionId !== 'number' ||
    typeof amount !== 'number'
  ) {
    workerLogger.error(
      { payload },
      '[Recovery Worker] Message payload is malformed or missing required fields, routing to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  try {
    const event: PaymentFailedEvent = {
      eventType: 'payment.failed',
      merchantId,
      orderId,
      transactionId,
      orderRef,
      txnRef,
      amount,
      currency,
      failureCategory,
      failureReason,
      gatewayResponse,
      correlationId
    };

    const { case: recoveryCase, isNew } = await ingestPaymentFailure(event);

    workerLogger.info(
      {
        caseId: recoveryCase.id,
        caseRef: recoveryCase.caseRef,
        isNew,
        status: recoveryCase.status
      },
      `[Recovery Worker] Successfully ${isNew ? 'created' : 'reused'} recovery case ${recoveryCase.caseRef} (Status: ${recoveryCase.status})`
    );

    // Acknowledge message only after durable commit
    channel.ack(msg);
  } catch (error) {
    workerLogger.error(
      { err: error, transactionId },
      `[Recovery Worker] Error processing payment failure ingestion for transaction ${transactionId}`
    );
    channel.nack(msg, false, false);
  }
}

/**
 * Consumes and processes a checkout abandonment event from the checkout_abandonment_queue.
 * (BT-D3 / SIG-002 / RCV-001)
 */
export async function handleCheckoutAbandonmentMessage(
  channel: RecoveryChannel,
  msg: amqp.ConsumeMessage,
  options?: { llmProvider?: LLMProvider; autoAdvance?: boolean }
): Promise<void> {
  const correlationId =
    (msg.properties?.headers?.['x-correlation-id'] as string | undefined) ||
    (msg.properties?.headers?.traceId as string | undefined) ||
    msg.properties?.correlationId ||
    generateUlid();

  const traceId =
    (msg.properties?.headers?.['x-trace-id'] as string | undefined) ||
    correlationId;

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(msg.content.toString());
  } catch (err) {
    logger.error(
      { err, correlationId, traceId },
      '[Recovery Worker] Failed to parse checkout abandonment JSON, routing to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  // Strict validation against canonical CheckoutAbandonedEvent schema
  const parseResult = CheckoutAbandonedEventSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    logger.error(
      {
        errors: parseResult.error.errors,
        correlationId,
        traceId,
        rawPayload
      },
      '[Recovery Worker] Checkout abandonment payload failed schema validation, routing to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  const event: CheckoutAbandonedEvent = parseResult.data;
  const workerLogger = logger.child({
    correlationId,
    traceId,
    merchantId: event.merchantId,
    orderId: event.orderId,
    orderRef: event.orderRef,
    stage: event.stage,
    eventId: event.eventId
  });

  try {
    const result = await ingestAbandonmentRecovery(event, {
      llmProvider: options?.llmProvider,
      autoAdvance: options?.autoAdvance
    });

    if (result.skipped) {
      workerLogger.info(
        { skippedReason: result.skippedReason },
        `[Recovery Worker] Checkout abandonment skipped for order ${event.orderRef} (${result.skippedReason})`
      );
    } else if (result.isDuplicate) {
      workerLogger.info(
        { caseId: result.case?.id, caseRef: result.case?.caseRef },
        `[Recovery Worker] Duplicate checkout abandonment event ${event.eventId} suppressed`
      );
    } else if (result.isNew) {
      workerLogger.info(
        {
          caseId: result.case?.id,
          caseRef: result.case?.caseRef,
          status: result.case?.status,
          policyDecision: result.policyDecision
        },
        `[Recovery Worker] Successfully created and advanced abandonment recovery case ${result.case?.caseRef} (status: ${result.case?.status})`
      );
    } else {
      workerLogger.info(
        { caseId: result.case?.id, caseRef: result.case?.caseRef, status: result.case?.status },
        `[Recovery Worker] Linked checkout abandonment to active case ${result.case?.caseRef}`
      );
    }

    // Acknowledge message only after durable commit
    channel.ack(msg);
  } catch (error) {
    workerLogger.error(
      { err: error, orderId: event.orderId },
      `[Recovery Worker] Error processing checkout abandonment event for order ${event.orderRef}`
    );
    channel.nack(msg, false, false);
  }
}

const recoveryConsumerTags: string[] = [];
let recoveryChannel: amqp.Channel | null = null;
const activeRecoveryJobs = new Set<Promise<void>>();

export async function stopRecoveryWorker(): Promise<void> {
  if (recoveryChannel && recoveryConsumerTags.length > 0) {
    logger.info(
      { consumerTags: recoveryConsumerTags },
      '[Recovery Worker] Cancelling consumer subscriptions'
    );
    for (const tag of recoveryConsumerTags) {
      try {
        await recoveryChannel.cancel(tag);
      } catch (err) {
        logger.warn({ err, tag }, '[Recovery Worker] Notice: error while cancelling consumer tag');
      }
    }
    recoveryConsumerTags.length = 0;
  }

  if (activeRecoveryJobs.size > 0) {
    logger.info(
      { inFlightCount: activeRecoveryJobs.size },
      '[Recovery Worker] Waiting for in-flight recovery jobs to finish'
    );
    await Promise.allSettled(Array.from(activeRecoveryJobs));
    logger.info('[Recovery Worker] All in-flight recovery jobs finished');
  }
}

export async function startRecoveryWorker(options?: { llmProvider?: LLMProvider }) {
  const channel = await getRabbitMQChannel();
  recoveryChannel = channel;
  logger.info(
    `Recovery worker listening on ${QUEUES.RECOVERY_INGESTION} and ${QUEUES.CHECKOUT_ABANDONMENT}`
  );

  // Prefetch to process one message at a time
  await channel.prefetch(1);

  // 1. Payment failure ingestion consumer
  const { consumerTag: tag1 } = await channel.consume(QUEUES.RECOVERY_INGESTION, (msg) => {
    if (!msg) return;
    const jobPromise = handleRecoveryMessage(channel, msg).finally(() => {
      activeRecoveryJobs.delete(jobPromise);
    });
    activeRecoveryJobs.add(jobPromise);
  });
  recoveryConsumerTags.push(tag1);

  // 2. Checkout abandonment ingestion consumer (BT-D3)
  const { consumerTag: tag2 } = await channel.consume(QUEUES.CHECKOUT_ABANDONMENT, (msg) => {
    if (!msg) return;
    const jobPromise = handleCheckoutAbandonmentMessage(channel, msg, options).finally(() => {
      activeRecoveryJobs.delete(jobPromise);
    });
    activeRecoveryJobs.add(jobPromise);
  });
  recoveryConsumerTags.push(tag2);

  return { consumerTags: recoveryConsumerTags, channel };
}

// If run directly via node/tsx
if (
  process.argv[1] &&
  (process.argv[1].endsWith('recovery.worker.ts') || process.argv[1].endsWith('recovery.worker.js'))
) {
  import('../utils/shutdown.js').then(({ createWorkerShutdownHandler }) => {
    startRecoveryWorker()
      .then(() => {
        createWorkerShutdownHandler({
          workerName: 'recovery-worker',
          onStop: stopRecoveryWorker
        });
      })
      .catch((err) => {
        logger.fatal({ err }, 'Failed to start recovery worker');
        process.exit(1);
      });
  });
}
