import 'dotenv/config';
import { logger } from '../utils/logger.js';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';

let dlqConsumerTag: string | null = null;
let dlqChannel: import('amqplib').Channel | null = null;
const activeDlqJobs = new Set<Promise<void>>();

export async function stopDlqWorker(): Promise<void> {
  if (dlqChannel && dlqConsumerTag) {
    logger.info({ consumerTag: dlqConsumerTag }, '[DLQ Worker] Cancelling consumer subscription');
    try {
      await dlqChannel.cancel(dlqConsumerTag);
    } catch (err) {
      logger.warn({ err }, '[DLQ Worker] Notice: error while cancelling consumer tag');
    }
    dlqConsumerTag = null;
  }

  if (activeDlqJobs.size > 0) {
    logger.info(
      { inFlightCount: activeDlqJobs.size },
      '[DLQ Worker] Waiting for in-flight DLQ jobs to finish'
    );
    await Promise.allSettled(Array.from(activeDlqJobs));
    logger.info('[DLQ Worker] All in-flight DLQ jobs finished');
  }
}

export async function startDlqWorker() {
  const channel = await getRabbitMQChannel();
  dlqChannel = channel;
  logger.info(`DLQ worker listening on ${QUEUES.PAYMENT_DLQ}`);

  await channel.prefetch(1);

  const { consumerTag } = await channel.consume(QUEUES.PAYMENT_DLQ, (msg) => {
    if (!msg) return;

    const jobPromise = (async () => {
      try {
        const payload = JSON.parse(msg.content.toString());
        logger.info(
          {
            transactionId: payload.transactionId,
            messageId: msg.properties.messageId,
            reason: msg.properties.headers?.['x-first-death-reason'],
            exchange: msg.properties.headers?.['x-first-death-exchange']
          },
          `[DLQ Worker] Received dead-lettered message`
        );

        // Acknowledge after logging
        channel.ack(msg);
      } catch (err) {
        logger.error({ err }, '[DLQ Worker] Error parsing DLQ message');
        // Still ack unparseable messages so they don't block
        channel.ack(msg);
      }
    })();

    activeDlqJobs.add(jobPromise);
    jobPromise.finally(() => {
      activeDlqJobs.delete(jobPromise);
    });
  });

  dlqConsumerTag = consumerTag;
  return { consumerTag, channel };
}

// If run directly via node/tsx
if (process.argv[1] && (process.argv[1].endsWith('dlq.worker.ts') || process.argv[1].endsWith('dlq.worker.js'))) {
  import('../utils/shutdown.js').then(({ createWorkerShutdownHandler }) => {
    startDlqWorker()
      .then(() => {
        createWorkerShutdownHandler({
          workerName: 'dlq-worker',
          onStop: stopDlqWorker
        });
      })
      .catch((err) => {
        logger.fatal({ err }, 'Failed to start DLQ worker');
        process.exit(1);
      });
  });
}
