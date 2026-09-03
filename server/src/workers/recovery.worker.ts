import 'dotenv/config';
import type amqp from 'amqplib';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';
import { ingestPaymentFailure } from '../modules/recovery/case.service.js';
import type { PaymentFailedEvent } from '../modules/recovery/case.types.js';
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

let recoveryConsumerTag: string | null = null;
let recoveryChannel: amqp.Channel | null = null;
const activeRecoveryJobs = new Set<Promise<void>>();

export async function stopRecoveryWorker(): Promise<void> {
  if (recoveryChannel && recoveryConsumerTag) {
    logger.info({ consumerTag: recoveryConsumerTag }, '[Recovery Worker] Cancelling consumer subscription');
    try {
      await recoveryChannel.cancel(recoveryConsumerTag);
    } catch (err) {
      logger.warn({ err }, '[Recovery Worker] Notice: error while cancelling consumer tag');
    }
    recoveryConsumerTag = null;
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

export async function startRecoveryWorker() {
  const channel = await getRabbitMQChannel();
  recoveryChannel = channel;
  logger.info(`Recovery worker listening on ${QUEUES.RECOVERY_INGESTION}`);

  // Prefetch to process one message at a time
  await channel.prefetch(1);

  const { consumerTag } = await channel.consume(QUEUES.RECOVERY_INGESTION, (msg) => {
    if (!msg) return;
    const jobPromise = handleRecoveryMessage(channel, msg).finally(() => {
      activeRecoveryJobs.delete(jobPromise);
    });
    activeRecoveryJobs.add(jobPromise);
  });

  recoveryConsumerTag = consumerTag;
  return { consumerTag, channel };
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
