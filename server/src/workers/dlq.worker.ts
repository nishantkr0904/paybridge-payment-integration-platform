import 'dotenv/config';
import { logger } from '../utils/logger.js';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';

export async function startDlqWorker() {
  const channel = await getRabbitMQChannel();
  logger.info(`DLQ worker listening on ${QUEUES.PAYMENT_DLQ}`);

  await channel.prefetch(1);

  await channel.consume(QUEUES.PAYMENT_DLQ, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      logger.info({ transactionId: payload.transactionId, messageId: msg.properties.messageId, reason: msg.properties.headers?.['x-first-death-reason'], exchange: msg.properties.headers?.['x-first-death-exchange'] }, `[DLQ Worker] Received dead-lettered message`);

      // In a real system, you might:
      // 1. Send an alert to Slack/PagerDuty
      // 2. Save it to a permanent "Failed Jobs" database table for admin review
      // 3. Keep it in the DLQ until manually replayed

      // For now, we will just ack it so it's removed from the queue after logging
      channel.ack(msg);
    } catch (err) {
      logger.error({ err }, '[DLQ Worker] Error parsing DLQ message');
      // We still ack it because we can't process it anyway
      channel.ack(msg);
    }
  });
}

// If run directly via node/tsx
if (process.argv[1] && process.argv[1].endsWith('dlq.worker.ts')) {
  startDlqWorker().catch((err) => {
    logger.fatal({ err }, 'Failed to start DLQ worker');
    process.exit(1);
  });
}
