import 'dotenv/config';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';
import { updateOrderStatus, updateTransactionStatus } from '../modules/payment/payment.repository.js';
import { generateUlid } from '../utils/ulid.js';

function simulateGateway(method: string): {
  success: boolean;
  gatewayResponse: Record<string, unknown>;
  failureReason?: string;
} {
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
    'Transaction timeout',
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
  console.log('Payment worker listening on', QUEUES.PAYMENT_PROCESSING);

  // Prefetch to process one message at a time
  await channel.prefetch(1);

  await channel.consume(QUEUES.PAYMENT_PROCESSING, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      const { transactionId, orderId, paymentMethod } = payload;

      console.log(`[Worker] Processing payment for transaction ${transactionId}`);

      // Simulate the gateway call
      // In reality, this would be an HTTP call to Stripe/Adyen, etc.
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

      console.log(`[Worker] Transaction ${transactionId} completed with status: ${finalTxnStatus}`);
      
      channel.ack(msg);
    } catch (error) {
      console.error('[Worker] Error processing message', error);
      // If there's an unexpected error, NACK it and do not requeue (send to DLQ)
      channel.nack(msg, false, false);
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
