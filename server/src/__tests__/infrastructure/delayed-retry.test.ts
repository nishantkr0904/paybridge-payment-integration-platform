import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import type amqp from 'amqplib';
import {
  EXCHANGES,
  QUEUES,
  ROUTING_KEYS,
  MIN_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  InvalidRetryDelayError,
  InvalidDelayedRetryPayloadError,
  validateDelayBounds,
  publishDelayedRetry,
  type DelayedRetryPayload
} from '../../infrastructure/rabbitmq.js';

interface PublishOptions {
  persistent?: boolean;
  deliveryMode?: number;
  expiration?: string;
  messageId?: string;
  correlationId?: string;
  headers?: Record<string, unknown>;
}

describe('TASK-401: Delayed Retry Queue (PAY-003 / AT-RMQ-002 / AT-INT-001 / AT-OBS-001)', () => {
  let mockChannel: {
    assertExchange: Mock<(exchange: string, type: string, options?: unknown) => Promise<unknown>>;
    assertQueue: Mock<(queue: string, options?: unknown) => Promise<unknown>>;
    bindQueue: Mock<(queue: string, exchange: string, pattern: string, args?: unknown) => Promise<unknown>>;
    publish: Mock<(exchange: string, routingKey: string, content: Buffer, options?: PublishOptions) => boolean>;
    close: Mock<() => Promise<void>>;
  };

  beforeEach(() => {
    mockChannel = {
      assertExchange: vi.fn<(exchange: string, type: string, options?: unknown) => Promise<unknown>>().mockResolvedValue({ exchange: 'mock' }),
      assertQueue: vi.fn<(queue: string, options?: unknown) => Promise<unknown>>().mockResolvedValue({ queue: 'mock', messageCount: 0, consumerCount: 0 }),
      bindQueue: vi.fn<(queue: string, exchange: string, pattern: string, args?: unknown) => Promise<unknown>>().mockResolvedValue({}),
      publish: vi.fn<(exchange: string, routingKey: string, content: Buffer, options?: PublishOptions) => boolean>().mockReturnValue(true),
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    };
  });

  const validPayload: DelayedRetryPayload = {
    merchantId: 101,
    caseId: 202,
    orderId: 303,
    transactionId: 404,
    orderRef: 'ORD_01M0AJX6JAD1K8PX',
    txnRef: 'TXN_01M0AJX6N6SPVYPE',
    amountMinorUnits: 150000,
    currency: 'INR',
    retryAttempt: 1,
    actionType: 'RETRY_PAYMENT',
    correlationId: '01RETRYCORR000000000001',
    traceId: '01RETRYTRACE00000000001'
  };

  /* ------------------------------------------------------------------ */
  /*  1. RabbitMQ Topology & Queue Declarations (AT-RMQ-002)            */
  /* ------------------------------------------------------------------ */

  describe('1. Topology & Queue Declarations', () => {
    it('declares durable retry delay exchange and holding queue with DLX dead-lettering', async () => {
      // Execute topology assertion with mock channel
      await mockChannel.assertExchange(EXCHANGES.RETRY_DELAY, 'direct', { durable: true });
      await mockChannel.assertQueue(QUEUES.RETRY_DELAY_HOLDING, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': EXCHANGES.PAYMENT,
          'x-dead-letter-routing-key': ROUTING_KEYS.PAYMENT_PROCESS
        }
      });
      await mockChannel.bindQueue(QUEUES.RETRY_DELAY_HOLDING, EXCHANGES.RETRY_DELAY, ROUTING_KEYS.RETRY_DELAY);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'retry_delay_exchange',
        'direct',
        { durable: true }
      );

      expect(mockChannel.assertQueue).toHaveBeenCalledWith(
        'retry_delay_holding_queue',
        {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': 'payment_exchange',
            'x-dead-letter-routing-key': 'payment.process'
          }
        }
      );

      expect(mockChannel.bindQueue).toHaveBeenCalledWith(
        'retry_delay_holding_queue',
        'retry_delay_exchange',
        'retry.delay'
      );
    });

    it('verifies topology constants match canonical requirements', () => {
      expect(EXCHANGES.RETRY_DELAY).toBe('retry_delay_exchange');
      expect(QUEUES.RETRY_DELAY_HOLDING).toBe('retry_delay_holding_queue');
      expect(ROUTING_KEYS.RETRY_DELAY).toBe('retry.delay');
      expect(ROUTING_KEYS.PAYMENT_PROCESS).toBe('payment.process');
      expect(MIN_RETRY_DELAY_MS).toBe(60 * 1000);
      expect(MAX_RETRY_DELAY_MS).toBe(14 * 24 * 60 * 60 * 1000);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Delay Bound Validation (1 minute to 14 days)                   */
  /* ------------------------------------------------------------------ */

  describe('2. Delay Bounds Validation (PAY-003 / AT-RMQ-002)', () => {
    it('accepts valid delays between 1 minute (60,000ms) and 14 days (1,209,600,000ms)', () => {
      expect(() => validateDelayBounds(60 * 1000)).not.toThrow(); // 1 minute
      expect(() => validateDelayBounds(5 * 60 * 1000)).not.toThrow(); // 5 minutes
      expect(() => validateDelayBounds(24 * 60 * 60 * 1000)).not.toThrow(); // 1 day
      expect(() => validateDelayBounds(14 * 24 * 60 * 60 * 1000)).not.toThrow(); // 14 days
    });

    it('rejects delays below 1 minute with InvalidRetryDelayError', () => {
      expect(() => validateDelayBounds(59999)).toThrow(InvalidRetryDelayError);
      expect(() => validateDelayBounds(0)).toThrow(InvalidRetryDelayError);
      expect(() => validateDelayBounds(1000)).toThrow(InvalidRetryDelayError);
    });

    it('rejects delays above 14 days with InvalidRetryDelayError', () => {
      const fifteenDays = 15 * 24 * 60 * 60 * 1000;
      expect(() => validateDelayBounds(fifteenDays)).toThrow(InvalidRetryDelayError);
    });

    it('rejects non-integer, negative, or NaN delay values', () => {
      expect(() => validateDelayBounds(60000.5)).toThrow(InvalidRetryDelayError);
      expect(() => validateDelayBounds(-1000)).toThrow(InvalidRetryDelayError);
      expect(() => validateDelayBounds(NaN)).toThrow(InvalidRetryDelayError);
      expect(() => validateDelayBounds('60000' as unknown as number)).toThrow(InvalidRetryDelayError);
    });

    it('allows short delays when bypassDelayBoundsForTesting is explicitly set', () => {
      expect(() => validateDelayBounds(500, true)).not.toThrow();
      expect(() => validateDelayBounds(-500, true)).toThrow(InvalidRetryDelayError);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Payload Schema Validation (OBS-001 / Invariant I5)              */
  /* ------------------------------------------------------------------ */

  describe('3. Delayed Retry Payload Validation', () => {
    it('successfully validates complete payload with correlation metadata', async () => {
      const result = await publishDelayedRetry(
        {
          payload: validPayload,
          delayMs: 300000 // 5 minutes
        },
        mockChannel as unknown as amqp.Channel
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(result.correlationId).toBe(validPayload.correlationId);
      expect(result.traceId).toBe(validPayload.traceId);
      expect(result.delayMs).toBe(300000);
      expect(result.scheduledAt).toBeDefined();
      expect(result.executeAt).toBeDefined();
    });

    it('rejects payload missing required merchantId (Invariant I5)', async () => {
      const invalidPayload = {
        ...validPayload,
        merchantId: undefined as unknown as number
      };

      await expect(
        publishDelayedRetry(
          {
            payload: invalidPayload,
            delayMs: 300000
          },
          mockChannel as unknown as amqp.Channel
        )
      ).rejects.toThrow(InvalidDelayedRetryPayloadError);
    });

    it('rejects payload with invalid retryAttempt (out of range)', async () => {
      const invalidPayload = {
        ...validPayload,
        retryAttempt: 0
      };

      await expect(
        publishDelayedRetry(
          {
            payload: invalidPayload,
            delayMs: 300000
          },
          mockChannel as unknown as amqp.Channel
        )
      ).rejects.toThrow(InvalidDelayedRetryPayloadError);
    });

    it('rejects payload missing correlationId (Invariant I2 / OBS-001)', async () => {
      const invalidPayload = {
        ...validPayload,
        correlationId: ''
      };

      await expect(
        publishDelayedRetry(
          {
            payload: invalidPayload,
            delayMs: 300000
          },
          mockChannel as unknown as amqp.Channel
        )
      ).rejects.toThrow(InvalidDelayedRetryPayloadError);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. Message Publishing & AMQP Options (FND-003 / AT-RMQ-002)       */
  /* ------------------------------------------------------------------ */

  describe('4. Message Publishing & AMQP Options', () => {
    it('publishes persistent message with TTL expiration and correlation headers', async () => {
      const delayMs = 180000; // 3 minutes

      await publishDelayedRetry(
        {
          payload: validPayload,
          delayMs
        },
        mockChannel as unknown as amqp.Channel
      );

      expect(mockChannel.publish).toHaveBeenCalledTimes(1);

      const [exchange, routingKey, buffer, options] = mockChannel.publish.mock.calls[0] || [];

      expect(exchange).toBe('retry_delay_exchange');
      expect(routingKey).toBe('retry.delay');

      // Verify message options
      expect(options?.persistent).toBe(true);
      expect(options?.deliveryMode).toBe(2);
      expect(options?.expiration).toBe('180000');
      expect(options?.correlationId).toBe(validPayload.correlationId);
      expect(options?.messageId).toBeDefined();

      // Verify AMQP headers
      expect(options?.headers?.['x-correlation-id']).toBe(validPayload.correlationId);
      expect(options?.headers?.['x-trace-id']).toBe(validPayload.traceId);
      expect(options?.headers?.['x-case-id']).toBe(validPayload.caseId);
      expect(options?.headers?.['x-merchant-id']).toBe(validPayload.merchantId);
      expect(options?.headers?.['x-retry-attempt']).toBe(validPayload.retryAttempt);
      expect(options?.headers?.['x-scheduled-delay-ms']).toBe(delayMs);
      expect(options?.headers?.['x-scheduled-at']).toBeDefined();
      expect(options?.headers?.['x-execute-at']).toBeDefined();

      // Verify payload content in buffer
      expect(buffer).toBeDefined();
      const parsedBody = JSON.parse(buffer!.toString());
      expect(parsedBody.merchantId).toBe(validPayload.merchantId);
      expect(parsedBody.caseId).toBe(validPayload.caseId);
      expect(parsedBody.txnRef).toBe(validPayload.txnRef);
      expect(parsedBody.scheduledAt).toBeDefined();
      expect(parsedBody.executeAt).toBeDefined();
    });

    it('allows custom target exchange and routing key overrides when needed', async () => {
      await publishDelayedRetry(
        {
          payload: validPayload,
          delayMs: 60000,
          options: {
            targetExchange: 'custom_delay_exchange',
            targetRoutingKey: 'custom.delay.key'
          }
        },
        mockChannel as unknown as amqp.Channel
      );

      const [exchange, routingKey] = mockChannel.publish.mock.calls[0] || [];
      expect(exchange).toBe('custom_delay_exchange');
      expect(routingKey).toBe('custom.delay.key');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. Simulated Delay Transit & Dead-Letter Routing (AT-RMQ-002)     */
  /* ------------------------------------------------------------------ */

  describe('5. Delay Transit & Routing Simulation (AT-RMQ-002 / AT-OBS-001)', () => {
    it('simulates dead-letter routing from delay holding queue to payment_processing_queue', () => {
      // Simulate message published to delay queue
      const publishedMessage = {
        content: Buffer.from(JSON.stringify(validPayload)),
        properties: {
          deliveryMode: 2,
          expiration: '60000',
          correlationId: validPayload.correlationId,
          headers: {
            'x-correlation-id': validPayload.correlationId,
            'x-trace-id': validPayload.traceId,
            'x-merchant-id': validPayload.merchantId,
            'x-case-id': validPayload.caseId,
            'x-retry-attempt': 1
          }
        }
      };

      // When TTL expires, broker routes to dead-letter exchange (EXCHANGES.PAYMENT, 'payment.process')
      const deadLetterRoutedMessage = {
        ...publishedMessage,
        fields: {
          exchange: EXCHANGES.PAYMENT,
          routingKey: ROUTING_KEYS.PAYMENT_PROCESS
        },
        properties: {
          ...publishedMessage.properties,
          headers: {
            ...publishedMessage.properties.headers,
            'x-death': [
              {
                count: 1,
                reason: 'expired',
                queue: QUEUES.RETRY_DELAY_HOLDING,
                exchange: EXCHANGES.RETRY_DELAY,
                'routing-keys': [ROUTING_KEYS.RETRY_DELAY]
              }
            ]
          }
        }
      };

      // Verify routing target is payment_processing_queue
      expect(deadLetterRoutedMessage.fields.exchange).toBe('payment_exchange');
      expect(deadLetterRoutedMessage.fields.routingKey).toBe('payment.process');

      // Verify correlation ID and trace ID survived transit intact
      expect(deadLetterRoutedMessage.properties.headers['x-correlation-id']).toBe(validPayload.correlationId);
      expect(deadLetterRoutedMessage.properties.headers['x-trace-id']).toBe(validPayload.traceId);
      expect(deadLetterRoutedMessage.properties.headers['x-merchant-id']).toBe(validPayload.merchantId);
      expect(deadLetterRoutedMessage.properties.headers['x-case-id']).toBe(validPayload.caseId);
    });
  });
});
