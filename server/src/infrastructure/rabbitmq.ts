import amqp from 'amqplib';
import { z } from 'zod';
import { generateUlid } from '../utils/ulid.js';

const rabbitMqUrl = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

/* ------------------------------------------------------------------ */
/*  Canonical Queue & Exchange Identifiers (§7 / §8 / TASK-401)       */
/* ------------------------------------------------------------------ */

export const QUEUES = {
  PAYMENT_PROCESSING: 'payment_processing_queue',
  PAYMENT_DLQ: 'payment_dlq',
  WEBHOOK_DELIVERY: 'webhook_queue',
  RECOVERY_INGESTION: 'recovery_ingestion_queue',
  RETRY_DELAY_HOLDING: 'retry_delay_holding_queue',
  CHECKOUT_ABANDONMENT: 'checkout_abandonment_queue'
} as const;

export const EXCHANGES = {
  PAYMENT: 'payment_exchange',
  DLX: 'dlx_exchange',
  WEBHOOK: 'webhook_exchange',
  RETRY_DELAY: 'retry_delay_exchange'
} as const;

export const ROUTING_KEYS = {
  PAYMENT_PROCESS: 'payment.process',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_DLQ: 'payment.dlq',
  RECOVERY_DLQ: 'recovery.dlq',
  WEBHOOK_DELIVER: 'webhook.deliver',
  RETRY_DELAY: 'retry.delay',
  CHECKOUT_ABANDONED: 'checkout.abandoned'
} as const;

/* ------------------------------------------------------------------ */
/*  Delay Limits: 1 Minute to 14 Days (TASK-401 / PAY-003)            */
/* ------------------------------------------------------------------ */

export const MIN_RETRY_DELAY_MS = 60 * 1000; // 1 minute (60,000 ms)
export const MAX_RETRY_DELAY_MS = 14 * 24 * 60 * 60 * 1000; // 14 days (1,209,600,000 ms)

/* ------------------------------------------------------------------ */
/*  Custom Errors                                                     */
/* ------------------------------------------------------------------ */

export class InvalidRetryDelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRetryDelayError';
  }
}

export class InvalidDelayedRetryPayloadError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[]
  ) {
    super(message);
    this.name = 'InvalidDelayedRetryPayloadError';
  }
}

/* ------------------------------------------------------------------ */
/*  Delayed Retry Payload & Scheduling Types (TASK-401 / OBS-001)     */
/* ------------------------------------------------------------------ */

export const DelayedRetryPayloadSchema = z.object({
  merchantId: z.number().int().positive(),
  caseId: z.number().int().positive(),
  orderId: z.number().int().positive().optional(),
  transactionId: z.number().int().positive().optional(),
  orderRef: z.string().optional(),
  txnRef: z.string().optional(),
  amountMinorUnits: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  retryAttempt: z.number().int().min(1).max(10),
  actionType: z.string().optional().default('RETRY_PAYMENT'),
  policyEvaluationRef: z.string().optional(),
  correlationId: z.string().min(1),
  traceId: z.string().optional(),
  scheduledAt: z.string().optional(),
  executeAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export type DelayedRetryPayload = z.infer<typeof DelayedRetryPayloadSchema>;

export interface PublishDelayedRetryInput {
  payload: DelayedRetryPayload;
  delayMs: number;
  options?: {
    bypassDelayBoundsForTesting?: boolean;
    targetExchange?: string;
    targetRoutingKey?: string;
  };
}

export interface DelayedRetryPublishResult {
  success: boolean;
  messageId: string;
  correlationId: string;
  traceId: string;
  delayMs: number;
  scheduledAt: string;
  executeAt: string;
  exchange: string;
  routingKey: string;
}

/* ------------------------------------------------------------------ */
/*  Validation Helpers                                                */
/* ------------------------------------------------------------------ */

export function validateDelayBounds(delayMs: number, bypassBounds = false): void {
  if (typeof delayMs !== 'number' || isNaN(delayMs) || !Number.isInteger(delayMs)) {
    throw new InvalidRetryDelayError(`Delay must be an integer number of milliseconds, received: ${delayMs}`);
  }

  if (!bypassBounds) {
    if (delayMs < MIN_RETRY_DELAY_MS) {
      throw new InvalidRetryDelayError(
        `Scheduled delay of ${delayMs}ms is below the minimum allowed delay of ${MIN_RETRY_DELAY_MS}ms (1 minute)`
      );
    }
    if (delayMs > MAX_RETRY_DELAY_MS) {
      throw new InvalidRetryDelayError(
        `Scheduled delay of ${delayMs}ms exceeds the maximum allowed delay of ${MAX_RETRY_DELAY_MS}ms (14 days)`
      );
    }
  } else if (delayMs < 0) {
    throw new InvalidRetryDelayError(`Delay cannot be negative, received: ${delayMs}ms`);
  }
}

/* ------------------------------------------------------------------ */
/*  Publish Delayed Retry Helper (TASK-401 / PAY-003 / AT-RMQ-002)    */
/* ------------------------------------------------------------------ */

export async function publishDelayedRetry(
  input: PublishDelayedRetryInput,
  customChannel?: amqp.Channel
): Promise<DelayedRetryPublishResult> {
  // 1. Validate payload
  const parseResult = DelayedRetryPayloadSchema.safeParse(input.payload);
  if (!parseResult.success) {
    throw new InvalidDelayedRetryPayloadError(
      `Invalid delayed retry payload: ${parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      parseResult.error.errors
    );
  }

  const payload = parseResult.data;

  // 2. Validate delay bounds (1 min to 14 days)
  validateDelayBounds(input.delayMs, input.options?.bypassDelayBoundsForTesting);

  // 3. Obtain channel
  const ch = customChannel || (await getRabbitMQChannel());

  const messageId = generateUlid();
  const scheduledAt = new Date().toISOString();
  const executeAt = new Date(Date.now() + input.delayMs).toISOString();
  const traceId = payload.traceId || payload.correlationId;

  const fullPayload: DelayedRetryPayload = {
    ...payload,
    traceId,
    scheduledAt,
    executeAt
  };

  const exchange = input.options?.targetExchange || EXCHANGES.RETRY_DELAY;
  const routingKey = input.options?.targetRoutingKey || ROUTING_KEYS.RETRY_DELAY;

  const buffer = Buffer.from(JSON.stringify(fullPayload));

  // 4. Publish to Delay Exchange with TTL expiration and persistence
  ch.publish(exchange, routingKey, buffer, {
    persistent: true,
    deliveryMode: 2,
    expiration: String(input.delayMs),
    messageId,
    correlationId: payload.correlationId,
    headers: {
      'x-correlation-id': payload.correlationId,
      'x-trace-id': traceId,
      'x-case-id': payload.caseId,
      'x-merchant-id': payload.merchantId,
      'x-retry-attempt': payload.retryAttempt,
      'x-scheduled-delay-ms': input.delayMs,
      'x-scheduled-at': scheduledAt,
      'x-execute-at': executeAt
    }
  });

  return {
    success: true,
    messageId,
    correlationId: payload.correlationId,
    traceId,
    delayMs: input.delayMs,
    scheduledAt,
    executeAt,
    exchange,
    routingKey
  };
}

/* ------------------------------------------------------------------ */
/*  RabbitMQ Connection & Topology Setup                              */
/* ------------------------------------------------------------------ */

export async function connectRabbitMQ() {
  if (connection && channel) {
    return { connection, channel };
  }

  try {
    connection = await amqp.connect(rabbitMqUrl);
    channel = await connection.createChannel();

    // 1. Setup Dead Letter Exchange
    await channel.assertExchange(EXCHANGES.DLX, 'direct', { durable: true });

    // 2. Setup Payment & Webhook Exchanges
    await channel.assertExchange(EXCHANGES.PAYMENT, 'direct', { durable: true });
    await channel.assertExchange(EXCHANGES.WEBHOOK, 'direct', { durable: true });

    // 3. Setup Retry Delay Exchange (TASK-401)
    await channel.assertExchange(EXCHANGES.RETRY_DELAY, 'direct', { durable: true });

    // 4. Setup DLQ
    await channel.assertQueue(QUEUES.PAYMENT_DLQ, { durable: true });
    await channel.bindQueue(QUEUES.PAYMENT_DLQ, EXCHANGES.DLX, ROUTING_KEYS.PAYMENT_DLQ);
    await channel.bindQueue(QUEUES.PAYMENT_DLQ, EXCHANGES.DLX, ROUTING_KEYS.RECOVERY_DLQ);

    // 5. Setup main processing queue with dead-lettering to DLX
    await channel.assertQueue(QUEUES.PAYMENT_PROCESSING, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.DLX,
        'x-dead-letter-routing-key': ROUTING_KEYS.PAYMENT_DLQ
      }
    });
    await channel.bindQueue(QUEUES.PAYMENT_PROCESSING, EXCHANGES.PAYMENT, ROUTING_KEYS.PAYMENT_PROCESS);

    // 6. Setup Recovery Ingestion Queue with dead-lettering to DLX
    await channel.assertQueue(QUEUES.RECOVERY_INGESTION, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.DLX,
        'x-dead-letter-routing-key': ROUTING_KEYS.RECOVERY_DLQ
      }
    });
    await channel.bindQueue(QUEUES.RECOVERY_INGESTION, EXCHANGES.PAYMENT, ROUTING_KEYS.PAYMENT_FAILED);

    // 7. Setup Webhook Queue
    await channel.assertQueue(QUEUES.WEBHOOK_DELIVERY, { durable: true });
    await channel.bindQueue(QUEUES.WEBHOOK_DELIVERY, EXCHANGES.WEBHOOK, ROUTING_KEYS.WEBHOOK_DELIVER);

    // 8. Setup Retry Delay Holding Queue (TASK-401 / AT-RMQ-002)
    // Messages sit in this queue with no consumers until TTL expires, then dead-letter to PAYMENT_PROCESSING
    await channel.assertQueue(QUEUES.RETRY_DELAY_HOLDING, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.PAYMENT,
        'x-dead-letter-routing-key': ROUTING_KEYS.PAYMENT_PROCESS
      }
    });
    await channel.bindQueue(QUEUES.RETRY_DELAY_HOLDING, EXCHANGES.RETRY_DELAY, ROUTING_KEYS.RETRY_DELAY);

    // 9. Setup Checkout Abandonment Queue with dead-lettering to DLX (BT-D1 / SIG-002)
    await channel.assertQueue(QUEUES.CHECKOUT_ABANDONMENT, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.DLX,
        'x-dead-letter-routing-key': ROUTING_KEYS.RECOVERY_DLQ
      }
    });
    await channel.bindQueue(QUEUES.CHECKOUT_ABANDONMENT, EXCHANGES.PAYMENT, ROUTING_KEYS.CHECKOUT_ABANDONED);

    return { connection, channel };
  } catch (error) {
    console.error('RabbitMQ Connection Error:', error);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  Publish Checkout Abandonment Helper (BT-D1 / SIG-002)             */
/* ------------------------------------------------------------------ */

export async function publishCheckoutAbandoned(
  event: Record<string, unknown>,
  customChannel?: amqp.Channel
): Promise<boolean> {
  const ch = customChannel || (await getRabbitMQChannel());
  const correlationId = (event.correlationId as string) || generateUlid();
  const traceId = (event.traceId as string) || correlationId;

  return ch.publish(
    EXCHANGES.PAYMENT,
    ROUTING_KEYS.CHECKOUT_ABANDONED,
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true,
      deliveryMode: 2,
      messageId: (event.eventId as string) || generateUlid(),
      correlationId,
      headers: {
        'x-correlation-id': correlationId,
        'x-trace-id': traceId,
        'x-merchant-id': event.merchantId,
        'x-order-ref': event.orderRef,
        'x-stage': event.stage
      }
    }
  );
}

export async function getRabbitMQChannel(): Promise<amqp.Channel> {
  if (!channel) {
    const conn = await connectRabbitMQ();
    return conn.channel;
  }
  return channel;
}

export async function disconnectRabbitMQ() {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}
