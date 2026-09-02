import 'dotenv/config';
import type amqp from 'amqplib';
import { logger } from '../utils/logger.js';
import { getRabbitMQChannel, QUEUES, EXCHANGES } from '../infrastructure/rabbitmq.js';
import { acquireLock, releaseLock } from '../infrastructure/redis.js';
import {
  findTransactionById,
  updateOrderStatus,
  updateTransactionStatus
} from '../modules/payment/payment.repository.js';
import { generateUlid } from '../utils/ulid.js';

export interface GatewaySimulationResult {
  success: boolean;
  gatewayResponse: Record<string, unknown>;
  failureReason?: string;
}

export function simulateGateway(method: string): GatewaySimulationResult {
  // 10% chance of a transient infrastructure error (network timeout, 503, etc)
  if (Math.random() < 0.1) {
    throw new Error('Transient Gateway Timeout');
  }

  const isSuccess = Math.random() < 0.8;

  if (isSuccess) {
    return {
      success: true,
      gatewayResponse: {
        provider: 'paybridge-sim',
        method,
        authCode: generateUlid().slice(0, 12),
        processedAt: new Date().toISOString()
      }
    };
  }

  const reasons = [
    'Insufficient funds',
    'Card declined by issuer',
    'Risk check failed'
  ];

  return {
    success: false,
    gatewayResponse: {
      provider: 'paybridge-sim',
      method,
      errorCode: 'GATEWAY_DECLINED',
      processedAt: new Date().toISOString()
    },
    failureReason: reasons[Math.floor(Math.random() * reasons.length)]
  };
}

export interface PaymentChannel {
  ack(message: amqp.Message, allUpTo?: boolean): void;
  nack(message: amqp.Message, allUpTo?: boolean, requeue?: boolean): void;
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: amqp.Options.Publish
  ): boolean;
}

export const WORKER_PAYMENT_LOCK_TTL_SECONDS = 30;
export const MAX_PAYMENT_RETRIES = 3;

export async function handlePaymentMessage(
  channel: PaymentChannel,
  msg: amqp.ConsumeMessage,
  gatewayRunner: (method: string) => GatewaySimulationResult = simulateGateway
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
    logger.error({ err, correlationId, traceId: correlationId }, '[Worker] Failed to parse message, sending to DLQ');
    channel.nack(msg, false, false);
    return;
  }

  const {
    transactionId,
    orderId,
    merchantId,
    orderRef,
    txnRef,
    paymentMethod,
    amount,
    retryCount = 0
  } = payload as {
    transactionId?: number;
    orderId?: number;
    merchantId?: number;
    orderRef?: string;
    txnRef?: string;
    paymentMethod?: string;
    amount?: number;
    retryCount?: number;
  };

  const workerLogger = logger.child({
    correlationId,
    traceId: correlationId,
    transactionId
  });

  // Validate required fields
  if (
    typeof transactionId !== 'number' ||
    typeof orderId !== 'number' ||
    typeof merchantId !== 'number' ||
    !orderRef ||
    !paymentMethod
  ) {
    workerLogger.error(
      { payload },
      '[Worker] Message payload is malformed or missing required fields, sending to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  // 1. Durable Terminal State Check (Duplicate Delivery Safety)
  const transaction = await findTransactionById(transactionId);

  if (!transaction) {
    workerLogger.error(
      { transactionId },
      `[Worker] Transaction ${transactionId} not found in database, sending to DLQ`
    );
    channel.nack(msg, false, false);
    return;
  }

  if (transaction.status === 'success' || transaction.status === 'failed') {
    workerLogger.info(
      { transactionId, status: transaction.status },
      `[Worker] Transaction ${transactionId} is already in terminal state '${transaction.status}'. Acknowledging duplicate message without re-executing payment side effect.`
    );
    channel.ack(msg);
    return;
  }

  // 2. Concurrency Protection: Acquire Distributed Worker Lock
  const lockKey = `lock:worker:txn:${transactionId}`;
  const lockToken = await acquireLock(lockKey, WORKER_PAYMENT_LOCK_TTL_SECONDS);

  if (!lockToken) {
    workerLogger.warn(
      { transactionId },
      `[Worker] Transaction ${transactionId} is currently being processed by another worker. Skipping concurrent execution.`
    );
    // Requeue so it can be retried or acknowledged once the active worker finishes
    channel.nack(msg, false, true);
    return;
  }

  try {
    // Double-check terminal status under lock
    const freshTxn = await findTransactionById(transactionId);
    if (freshTxn && (freshTxn.status === 'success' || freshTxn.status === 'failed')) {
      workerLogger.info(
        { transactionId, status: freshTxn.status },
        `[Worker] Transaction ${transactionId} reached terminal state '${freshTxn.status}' before lock acquisition. Acknowledging message.`
      );
      channel.ack(msg);
      return;
    }

    workerLogger.info(
      { transactionId, attempt: retryCount + 1 },
      `[Worker] Processing payment for transaction ${transactionId} (Attempt ${retryCount + 1}/${MAX_PAYMENT_RETRIES + 1})`
    );

    // 3. Execute Payment Side Effect
    const result = gatewayRunner(paymentMethod);

    const finalTxnStatus = result.success ? 'success' : 'failed';
    const finalOrderStatus = result.success ? 'success' : 'failed';

    // 4. Update Database State
    await updateTransactionStatus(
      transactionId,
      finalTxnStatus,
      result.gatewayResponse,
      result.failureReason
    );

    await updateOrderStatus(orderId, finalOrderStatus);

    // 5. Publish Webhook Event
    const webhookPayload = {
      merchantId,
      transactionId,
      orderId,
      orderRef,
      txnRef: txnRef || transaction.txnRef,
      eventType: result.success ? 'payment.success' : 'payment.failed',
      data: {
        orderRef,
        txnRef: txnRef || transaction.txnRef,
        amount: amount ?? transaction.amount,
        paymentMethod,
        status: finalTxnStatus,
        gatewayResponse: result.gatewayResponse,
        failureReason: result.failureReason
      }
    };

    channel.publish(
      EXCHANGES.WEBHOOK,
      'webhook.deliver',
      Buffer.from(JSON.stringify(webhookPayload)),
      {
        persistent: true,
        headers: {
          'x-correlation-id': correlationId,
          traceId: correlationId
        },
        correlationId
      }
    );

    workerLogger.info(
      { transactionId, status: finalTxnStatus },
      `[Worker] Transaction ${transactionId} completed with status: ${finalTxnStatus}`
    );

    // 6. Acknowledge Message
    channel.ack(msg);
  } catch (error) {
    workerLogger.error(
      { err: error, transactionId },
      `[Worker] Error processing message (Transaction ${transactionId})`
    );

    if (retryCount < MAX_PAYMENT_RETRIES) {
      workerLogger.info(`[Worker] Retrying transaction ${transactionId}...`);

      const newPayload = { ...payload, retryCount: retryCount + 1 };
      channel.publish(
        '', // default exchange
        QUEUES.PAYMENT_PROCESSING,
        Buffer.from(JSON.stringify(newPayload)),
        {
          persistent: true,
          headers: {
            'x-correlation-id': correlationId,
            traceId: correlationId
          },
          correlationId
        }
      );

      // Acknowledge the original message now that retry message is enqueued
      channel.ack(msg);
    } else {
      workerLogger.info(
        `[Worker] Max retries reached for transaction ${transactionId}. Sending to DLQ.`
      );

      // Update DB status to reflect system failure
      try {
        await updateTransactionStatus(
          transactionId,
          'failed',
          undefined,
          'System Error: Max retries exceeded'
        );
        await updateOrderStatus(orderId, 'failed');
      } catch (dbErr) {
        workerLogger.error(
          { err: dbErr },
          `[Worker] Failed to update DB after max retries: ${transactionId}`
        );
      }

      // NACK without requeue sends it to the DLX/DLQ
      channel.nack(msg, false, false);
    }
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

let paymentConsumerTag: string | null = null;
let paymentChannel: amqp.Channel | null = null;
const activePaymentJobs = new Set<Promise<void>>();

export async function stopPaymentWorker(): Promise<void> {
  if (paymentChannel && paymentConsumerTag) {
    logger.info({ consumerTag: paymentConsumerTag }, '[Payment Worker] Cancelling consumer subscription');
    try {
      await paymentChannel.cancel(paymentConsumerTag);
    } catch (err) {
      logger.warn({ err }, '[Payment Worker] Notice: error while cancelling consumer tag');
    }
    paymentConsumerTag = null;
  }

  if (activePaymentJobs.size > 0) {
    logger.info(
      { inFlightCount: activePaymentJobs.size },
      '[Payment Worker] Waiting for in-flight payment jobs to finish'
    );
    await Promise.allSettled(Array.from(activePaymentJobs));
    logger.info('[Payment Worker] All in-flight payment jobs finished');
  }
}

export async function startPaymentWorker() {
  const channel = await getRabbitMQChannel();
  paymentChannel = channel;
  logger.info(`Payment worker listening on ${QUEUES.PAYMENT_PROCESSING}`);

  // Prefetch to process one message at a time
  await channel.prefetch(1);

  const { consumerTag } = await channel.consume(QUEUES.PAYMENT_PROCESSING, (msg) => {
    if (!msg) return;
    const jobPromise = handlePaymentMessage(channel, msg).finally(() => {
      activePaymentJobs.delete(jobPromise);
    });
    activePaymentJobs.add(jobPromise);
  });

  paymentConsumerTag = consumerTag;
  return { consumerTag, channel };
}

// If run directly via node/tsx
if (
  process.argv[1] &&
  (process.argv[1].endsWith('payment.worker.ts') || process.argv[1].endsWith('payment.worker.js'))
) {
  import('../utils/shutdown.js').then(({ createWorkerShutdownHandler }) => {
    startPaymentWorker()
      .then(() => {
        createWorkerShutdownHandler({
          workerName: 'payment-worker',
          onStop: stopPaymentWorker
        });
      })
      .catch((err) => {
        logger.fatal({ err }, 'Failed to start worker');
        process.exit(1);
      });
  });
}
