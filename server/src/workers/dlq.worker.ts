import 'dotenv/config';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';

export async function startDlqWorker() {
  const channel = await getRabbitMQChannel();
  console.log('DLQ worker listening on', QUEUES.PAYMENT_DLQ);

  await channel.prefetch(1);

  await channel.consume(QUEUES.PAYMENT_DLQ, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      console.error(`[DLQ Worker] Received permanently failed message for transaction: ${payload.transactionId}`);
      console.error(`[DLQ Worker] Payload:`, payload);

      // In a real system, you might:
      // 1. Send an alert to Slack/PagerDuty
      // 2. Save it to a permanent "Failed Jobs" database table for admin review
      // 3. Keep it in the DLQ until manually replayed

      // For now, we will just ack it so it's removed from the queue after logging
      channel.ack(msg);
    } catch (err) {
      console.error('[DLQ Worker] Error parsing DLQ message', err);
      // We still ack it because we can't process it anyway
      channel.ack(msg);
    }
  });
}

// If run directly via node/tsx
if (process.argv[1] && process.argv[1].endsWith('dlq.worker.ts')) {
  startDlqWorker().catch((err) => {
    console.error('Failed to start DLQ worker', err);
    process.exit(1);
  });
}
