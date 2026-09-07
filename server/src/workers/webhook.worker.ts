import 'dotenv/config';
import crypto from 'node:crypto';
import type amqp from 'amqplib';
import { logger } from '../utils/logger.js';
import { getRabbitMQChannel, QUEUES } from '../infrastructure/rabbitmq.js';
import {
  getWebhookEndpoints,
  logWebhookDelivery,
  updateWebhookDelivery
} from '../modules/webhook/webhook.repository.js';
import { generateUlid } from '../utils/ulid.js';

import { env } from '../config/env.js';
import {
  validateWebhookDestination,
  type DnsLookupFunction
} from '../utils/ssrf.js';

export const MAX_WEBHOOK_RETRIES = 5;

export interface WebhookChannel {
  ack(message: amqp.Message, allUpTo?: boolean): void;
  nack(message: amqp.Message, allUpTo?: boolean, requeue?: boolean): void;
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options?: amqp.Options.Publish
  ): boolean;
}

export interface WebhookHandlerOptions {
  fetchFn?: typeof fetch;
  scheduleRetry?: (action: () => void, delayMs: number) => NodeJS.Timeout | unknown;
  maxRetries?: number;
  dnsLookupFn?: DnsLookupFunction;
  allowedInternalTargets?: string;
}

export interface PendingWebhookRetry {
  timer: NodeJS.Timeout;
  action: () => void;
}

export const pendingWebhookRetries = new Set<PendingWebhookRetry>();

export function scheduleDelayedWebhookPublish(
  action: () => void,
  delayMs: number
): NodeJS.Timeout {
  const pending: PendingWebhookRetry = {
    timer: null as unknown as NodeJS.Timeout,
    action
  };

  pending.timer = setTimeout(() => {
    pendingWebhookRetries.delete(pending);
    action();
  }, delayMs);

  pendingWebhookRetries.add(pending);
  return pending.timer;
}

export function flushPendingWebhookRetries(): void {
  if (pendingWebhookRetries.size > 0) {
    logger.info(
      { count: pendingWebhookRetries.size },
      '[Webhook Worker] Flushing pending retries immediately before shutdown'
    );
    for (const pending of pendingWebhookRetries) {
      clearTimeout(pending.timer);
      try {
        pending.action();
      } catch (err) {
        logger.error({ err }, '[Webhook Worker] Error executing flushed pending retry');
      }
    }
    pendingWebhookRetries.clear();
  }
}

export function clearPendingWebhookRetries(): void {
  for (const pending of pendingWebhookRetries) {
    clearTimeout(pending.timer);
  }
  pendingWebhookRetries.clear();
}

export function isRedirectError(err: unknown): boolean {
  if (!err) return false;
  const errorObj = err as { message?: string; cause?: unknown };
  const message = typeof errorObj.message === 'string' ? errorObj.message.toLowerCase() : '';
  const causeMessage =
    errorObj.cause && typeof (errorObj.cause as { message?: string }).message === 'string'
      ? (errorObj.cause as { message: string }).message.toLowerCase()
      : '';
  const str = String(err).toLowerCase();
  return (
    message.includes('redirect') ||
    causeMessage.includes('redirect') ||
    str.includes('redirect')
  );
}

/* ------------------------------------------------------------------ */
/*  Webhook Message Handler (Non-Blocking Retry / Observability)      */
/* ------------------------------------------------------------------ */

export async function handleWebhookMessage(
  channel: WebhookChannel,
  msg: amqp.ConsumeMessage,
  options?: WebhookHandlerOptions
): Promise<void> {
  const correlationId =
    (msg.properties?.headers?.['x-correlation-id'] as string | undefined) ||
    (msg.properties?.headers?.traceId as string | undefined) ||
    msg.properties?.correlationId ||
    generateUlid();

  let payload: {
    merchantId?: number;
    eventType?: string;
    data?: unknown;
    retryCount?: number;
    [key: string]: unknown;
  };

  try {
    payload = JSON.parse(msg.content.toString());
  } catch (err) {
    logger.error(
      { err, correlationId, traceId: correlationId },
      '[Webhook Worker] Failed to parse message, dropping malformed payload'
    );
    channel.ack(msg);
    return;
  }

  const { merchantId, eventType, data, retryCount = 0 } = payload;
  const maxRetries = options?.maxRetries ?? MAX_WEBHOOK_RETRIES;

  if (typeof merchantId !== 'number' || !eventType) {
    logger.error(
      { payload, correlationId },
      '[Webhook Worker] Missing required merchantId or eventType, dropping message'
    );
    channel.ack(msg);
    return;
  }

  const workerLogger = logger.child({
    correlationId,
    traceId: correlationId,
    merchantId
  });

  workerLogger.info(
    `[Webhook Worker] Delivering ${eventType} to merchant ${merchantId} (Attempt ${retryCount + 1}/${maxRetries + 1})`
  );

  try {
    const endpoints = await getWebhookEndpoints(merchantId);
    const activeEndpoint = endpoints.find((e) => e.isActive);

    if (!activeEndpoint) {
      workerLogger.info(
        `[Webhook Worker] No active webhook endpoint found for merchant ${merchantId}. Skipping.`
      );
      channel.ack(msg);
      return;
    }

    const payloadToSend = {
      id: `evt_${crypto.randomBytes(12).toString('hex')}`,
      type: eventType,
      created: new Date().toISOString(),
      data
    };

    const payloadString = JSON.stringify(payloadToSend);
    const signature = crypto
      .createHmac('sha256', activeEndpoint.secret)
      .update(payloadString)
      .digest('hex');

    const deliveryId = await logWebhookDelivery(
      activeEndpoint.id,
      eventType,
      payloadToSend,
      'pending',
      null
    );

    const destinationValidation = await validateWebhookDestination(
      activeEndpoint.url,
      options?.allowedInternalTargets ?? env.WEBHOOK_ALLOWED_INTERNAL_TARGETS,
      options?.dnsLookupFn
    );

    if (destinationValidation.status === 'BLOCKED') {
      workerLogger.warn(
        {
          reason: 'BLOCKED_SSRF_TARGET',
          detail: destinationValidation.reason,
          url: activeEndpoint.url
        },
        `[Webhook Worker] Delivery blocked by SSRF policy: ${destinationValidation.reason}`
      );
      await updateWebhookDelivery(deliveryId, 'failed', null).catch(() => {});
      channel.ack(msg);
      return;
    }

    if (destinationValidation.status === 'DNS_ERROR') {
      workerLogger.error(
        { err: destinationValidation.error, url: activeEndpoint.url },
        `[Webhook Worker] DNS resolution failed for webhook target`
      );
      await updateWebhookDelivery(deliveryId, 'failed', null).catch(() => {});
      throw destinationValidation.error;
    }

    const fetchImpl = options?.fetchFn ?? fetch;

    try {
      const response = await fetchImpl(activeEndpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-paybridge-signature': signature,
          'User-Agent': 'PayBridge-Webhook/1.0'
        },
        body: payloadString,
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });

      const isSuccess = response.status >= 200 && response.status < 300;
      await updateWebhookDelivery(deliveryId, isSuccess ? 'success' : 'failed', response.status);

      if (isSuccess) {
        workerLogger.info(`[Webhook Worker] Delivery successful. HTTP ${response.status}`);
        channel.ack(msg);
        return;
      } else {
        throw new Error(`Non-success HTTP status ${response.status}`);
      }
    } catch (deliveryError) {
      if (isRedirectError(deliveryError)) {
        workerLogger.warn(
          {
            reason: 'BLOCKED_SSRF_TARGET',
            detail: 'REDIRECT_NOT_ALLOWED',
            url: activeEndpoint.url,
            err: deliveryError
          },
          `[Webhook Worker] Delivery blocked by SSRF policy: redirect encountered`
        );
        await updateWebhookDelivery(deliveryId, 'failed', null).catch(() => {});
        channel.ack(msg);
        return;
      }

      workerLogger.error({ err: deliveryError }, `[Webhook Worker] Delivery failed`);
      await updateWebhookDelivery(deliveryId, 'failed', null).catch(() => {});
      throw deliveryError;
    }
  } catch {
    if (retryCount < maxRetries) {
      const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s, 8s, 16s
      workerLogger.info(
        `[Webhook Worker] Scheduling non-blocking retry in ${backoffMs}ms (Attempt ${retryCount + 1}/${maxRetries})...`
      );

      // Immediately acknowledge the current message so the worker prefetch slot is freed
      channel.ack(msg);

      const newPayload = { ...payload, retryCount: retryCount + 1 };
      const scheduleFn = options?.scheduleRetry ?? scheduleDelayedWebhookPublish;

      scheduleFn(() => {
        try {
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
          workerLogger.info(
            `[Webhook Worker] Delayed retry message dispatched to queue (Attempt ${retryCount + 2})`
          );
        } catch (pubErr) {
          workerLogger.error(
            { err: pubErr },
            '[Webhook Worker] Failed to publish delayed retry message'
          );
        }
      }, backoffMs);
    } else {
      workerLogger.error(`[Webhook Worker] Max retries (${maxRetries}) reached for webhook delivery.`);
      channel.ack(msg); // Drop after max retries
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Worker Lifecycle & Graceful Shutdown Integration                  */
/* ------------------------------------------------------------------ */

let webhookConsumerTag: string | null = null;
let webhookChannel: amqp.Channel | null = null;
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

  // Flush pending retries to RabbitMQ so no delivery attempts are lost across process restarts
  flushPendingWebhookRetries();

  if (activeWebhookJobs.size > 0) {
    logger.info(
      { inFlightCount: activeWebhookJobs.size },
      '[Webhook Worker] Waiting for in-flight webhook jobs to finish'
    );
    await Promise.allSettled(Array.from(activeWebhookJobs));
    logger.info('[Webhook Worker] All in-flight webhook jobs finished');
  }
}

export async function startWebhookWorker(customChannel?: amqp.Channel) {
  const channel = customChannel || (await getRabbitMQChannel());
  webhookChannel = channel;
  logger.info(`Webhook worker listening on ${QUEUES.WEBHOOK_DELIVERY}`);

  await channel.prefetch(5);

  const { consumerTag } = await channel.consume(QUEUES.WEBHOOK_DELIVERY, (msg) => {
    if (!msg) return;

    const jobPromise = handleWebhookMessage(channel, msg)
      .catch((err) => {
        logger.error({ err }, '[Webhook Worker] Unhandled exception in handleWebhookMessage');
      })
      .finally(() => {
        activeWebhookJobs.delete(jobPromise);
      });

    activeWebhookJobs.add(jobPromise);
  });

  webhookConsumerTag = consumerTag;
  return { consumerTag, channel };
}

// If run directly via node/tsx
if (
  process.argv[1] &&
  (process.argv[1].endsWith('webhook.worker.ts') || process.argv[1].endsWith('webhook.worker.js'))
) {
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
