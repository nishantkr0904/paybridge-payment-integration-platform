import 'dotenv/config';
import { logger } from '../utils/logger.js';
import { getRabbitMQChannel, QUEUES, EXCHANGES } from '../infrastructure/rabbitmq.js';
import { updateOrderStatus, updateTransactionStatus } from '../modules/payment/payment.repository.js';
import { generateUlid } from '../utils/ulid.js';

function simulateGateway(method: string): {
  success: boolean;
  gatewayResponse: Record<string, unknown>;
  failureReason?: string;
} {
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

export async function startPaymentWorker() {
  const channel = await getRabbitMQChannel();
  logger.info(`Payment worker listening on ${QUEUES.PAYMENT_PROCESSING}`);

  // Prefetch to process one message at a time
  await channel.prefetch(1);

  await channel.consume(QUEUES.PAYMENT_PROCESSING, async (msg) => {
    if (!msg) return;

    let payload;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch (err) {
      logger.error({ err }, '[Worker] Failed to parse message, sending to DLQ');
      return channel.nack(msg, false, false);
    }

    const { transactionId, orderId, merchantId, orderRef, paymentMethod, retryCount = 0 } = payload;
    const MAX_RETRIES = 3;

    logger.info({ transactionId, attempt: retryCount + 1 }, `[Worker] Processing payment for transaction ${transactionId} (Attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);

    try {
      // We wrap it in a short delay to simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      const result = simulateGateway(paymentMethod);

      const finalTxnStatus = result.success ? 'success' : 'failed';
      const finalOrderStatus = result.success ? 'success' : 'failed';

      await updateTransactionStatus(
        transactionId,
        finalTxnStatus,
        result.gatewayResponse,
        result.failureReason
      );

      await updateOrderStatus(orderId, finalOrderStatus);

      // Publish webhook event
      const webhookPayload = {
        merchantId,
        transactionId,
        orderId,
        orderRef,
        txnRef: payload.txnRef,
        eventType: result.success ? 'payment.success' : 'payment.failed',
        data: {
          orderRef,
          txnRef: payload.txnRef,
          amount: payload.amount,
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
        { persistent: true }
      );

      logger.info({ transactionId, status: finalTxnStatus }, `[Worker] Transaction ${transactionId} completed with status: ${finalTxnStatus}`);
      
      channel.ack(msg);
    } catch (error) {
      logger.error({ err: error }, `[Worker] Error processing message (Transaction ${transactionId})`);
      
      if (retryCount < MAX_RETRIES) {
        logger.info(`[Worker] Retrying transaction ${transactionId} in 2 seconds...`);
        
        // Wait before requeuing to act as a simple backoff
        await new Promise((resolve) => setTimeout(resolve, 2000));
        
        // Publish a new message with incremented retry count
        const newPayload = { ...payload, retryCount: retryCount + 1 };
        channel.publish(
          '', // default exchange
          QUEUES.PAYMENT_PROCESSING,
          Buffer.from(JSON.stringify(newPayload)),
          { persistent: true }
        );
        
        // Ack the original message so it doesn't get processed again
        channel.ack(msg);
      } else {
        logger.info(`[Worker] Max retries reached for transaction ${transactionId}. Sending to DLQ.`);
        // NACK without requeue sends it to the DLX/DLQ
        channel.nack(msg, false, false);
        
        // Optionally update the DB status to reflect the system failure
        try {
          await updateTransactionStatus(transactionId, 'failed', undefined, 'System Error: Max retries exceeded');
          await updateOrderStatus(orderId, 'failed');
        } catch (dbErr) {
          logger.error({ err: dbErr }, `[Worker] Failed to update DB after max retries: ${transactionId}`);
        }
      }
    }
  });
}

// If run directly via node/tsx
if (process.argv[1] && process.argv[1].endsWith('payment.worker.ts')) {
  startPaymentWorker().catch((err) => {
    console.error('Failed to start worker', err);
    process.exit(1);
  });
}
