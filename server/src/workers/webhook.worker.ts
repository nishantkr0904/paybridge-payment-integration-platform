import 'dotenv/config';
import { logger } from '../utils/logger.js';
import crypto from 'node:crypto';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';
import { getWebhookEndpoints } from '../modules/webhook/webhook.repository.js';
import { pool } from '../config/database.js';
import { generateUlid } from '../utils/ulid.js';
import type { ResultSetHeader } from 'mysql2';

async function logDelivery(endpointId: number, eventType: string, payload: Record<string, unknown>, status: 'pending' | 'success' | 'failed', responseStatus: number | null): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, status, response_status) VALUES (?, ?, ?, ?, ?)`,
    [endpointId, eventType, JSON.stringify(payload), status, responseStatus]
  );
  return result.insertId;
}

async function updateDelivery(id: number, status: 'success' | 'failed', responseStatus: number | null) {
  await pool.execute(
    `UPDATE webhook_deliveries SET status = ?, response_status = ? WHERE id = ?`,
    [status, responseStatus, id]
  );
}

let webhookConsumerTag: string | null = null;
let webhookChannel: import('amqplib').Channel | null = null;
const activeWebhookJobs = new Set<Promise<void>>();

export async function stopWebhookWorker(): Promise<void> {
  if (webhookChannel && webhookConsumerTag) {
    logger.info({ consumerTag: webhookConsumerTag }, '[Webhook Worker] Cancelling consumer subscription');
    try {
      await webhookChannel.cancel(webhookConsumerTag);
    } catch (err) {
      logger.warn({ err }, '[Webhook Worker] Notice: error while cancelling consumer tag');
    }
    webhookConsumerTag = null;
  }

  if (activeWebhookJobs.size > 0) {
    logger.info(
      { inFlightCount: activeWebhookJobs.size },
      '[Webhook Worker] Waiting for in-flight webhook jobs to finish'
    );
    await Promise.allSettled(Array.from(activeWebhookJobs));
    logger.info('[Webhook Worker] All in-flight webhook jobs finished');
  }
}

export async function startWebhookWorker() {
  const channel = await getRabbitMQChannel();
  webhookChannel = channel;
  logger.info(`Webhook worker listening on ${QUEUES.WEBHOOK_DELIVERY}`);

  await channel.prefetch(5);

  const { consumerTag } = await channel.consume(QUEUES.WEBHOOK_DELIVERY, (msg) => {
    if (!msg) return;

    const jobPromise = (async () => {
      const correlationId =
        (msg.properties?.headers?.['x-correlation-id'] as string | undefined) ||
        (msg.properties?.headers?.traceId as string | undefined) ||
        msg.properties?.correlationId ||
        generateUlid();

      let payload;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        logger.error({ err, correlationId, traceId: correlationId }, '[Webhook Worker] Failed to parse message');
        channel.ack(msg); // Malformed, just drop it
        return;
      }

      const { merchantId, eventType, data, retryCount = 0 } = payload;
      const MAX_RETRIES = 5;

      const workerLogger = logger.child({
        correlationId,
        traceId: correlationId,
        merchantId
      });

      workerLogger.info(`[Webhook Worker] Delivering ${eventType} to merchant ${merchantId} (Attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);

      try {
        // Find active webhook endpoint for merchant
        const endpoints = await getWebhookEndpoints(merchantId);
        const activeEndpoint = endpoints.find(e => e.isActive);

        if (!activeEndpoint) {
          workerLogger.info(`[Webhook Worker] No active webhook endpoint found for merchant ${merchantId}. Skipping.`);
          channel.ack(msg);
          return;
        }

        // Prepare payload to send
        const payloadToSend = {
          id: `evt_${crypto.randomBytes(12).toString('hex')}`,
          type: eventType,
          created: new Date().toISOString(),
          data
        };

        const payloadString = JSON.stringify(payloadToSend);
        const signature = crypto.createHmac('sha256', activeEndpoint.secret).update(payloadString).digest('hex');

        // Log pending delivery
        const deliveryId = await logDelivery(activeEndpoint.id, eventType, payloadToSend, 'pending', null);

        try {
          const response = await fetch(activeEndpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-paybridge-signature': signature,
              'User-Agent': 'PayBridge-Webhook/1.0'
            },
            body: payloadString,
            // Timeout after 5 seconds
            signal: AbortSignal.timeout(5000)
          });

          const isSuccess = response.status >= 200 && response.status < 300;

          await updateDelivery(deliveryId, isSuccess ? 'success' : 'failed', response.status);

          if (isSuccess) {
            workerLogger.info(`[Webhook Worker] Delivery successful. HTTP ${response.status}`);
            channel.ack(msg);
          } else {
            throw new Error(`Non-success HTTP status ${response.status}`);
          }
        } catch (deliveryError) {
          // Network error, timeout, or 500 status code
          workerLogger.error({ err: deliveryError }, `[Webhook Worker] Delivery failed`);

          // Ensure DB is updated to reflect failure if not already updated
          await updateDelivery(deliveryId, 'failed', null);
          throw deliveryError;
        }
      } catch {
        if (retryCount < MAX_RETRIES) {
          const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s, 8s, 16s
          workerLogger.info(`[Webhook Worker] Retrying in ${backoffMs}ms...`);

          await new Promise((resolve) => setTimeout(resolve, backoffMs));

          const newPayload = { ...payload, retryCount: retryCount + 1 };
          channel.publish(
            '',
            QUEUES.WEBHOOK_DELIVERY,
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

          channel.ack(msg);
        } else {
          workerLogger.error(`[Webhook Worker] Max retries reached for webhook delivery.`);
          channel.ack(msg); // Drop after max retries
        }
      }
    })();

    activeWebhookJobs.add(jobPromise);
    jobPromise.finally(() => {
      activeWebhookJobs.delete(jobPromise);
    });
  });

  webhookConsumerTag = consumerTag;
  return { consumerTag, channel };
}

if (process.argv[1] && (process.argv[1].endsWith('webhook.worker.ts') || process.argv[1].endsWith('webhook.worker.js'))) {
  import('../utils/shutdown.js').then(({ createWorkerShutdownHandler }) => {
    startWebhookWorker()
      .then(() => {
        createWorkerShutdownHandler({
          workerName: 'webhook-worker',
          onStop: stopWebhookWorker
        });
      })
      .catch((err) => {
        logger.error({ err }, 'Failed to start worker');
        process.exit(1);
      });
  });
}
