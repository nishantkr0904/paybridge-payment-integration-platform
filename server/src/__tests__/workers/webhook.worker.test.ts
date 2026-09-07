import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type amqp from 'amqplib';
import * as webhookRepo from '../../modules/webhook/webhook.repository.js';
import {
  handleWebhookMessage,
  startWebhookWorker,
  stopWebhookWorker,
  clearPendingWebhookRetries,
  flushPendingWebhookRetries,
  scheduleDelayedWebhookPublish,
  MAX_WEBHOOK_RETRIES,
  type WebhookChannel
} from '../../workers/webhook.worker.js';

vi.mock('../../infrastructure/rabbitmq.js', () => ({
  getRabbitMQChannel: vi.fn(),
  QUEUES: {
    WEBHOOK_DELIVERY: 'webhook_queue'
  },
  EXCHANGES: {
    WEBHOOK: 'webhook_exchange'
  }
}));

vi.mock('../../modules/webhook/webhook.repository.js', () => ({
  getWebhookEndpoints: vi.fn(),
  logWebhookDelivery: vi.fn(),
  updateWebhookDelivery: vi.fn()
}));

describe('Webhook Worker Execution & Non-Blocking Retries (webhook.worker.ts)', () => {
  let mockChannel: WebhookChannel;

  function createMockMessage(payload: unknown, headers: Record<string, unknown> = {}): amqp.ConsumeMessage {
    const content =
      typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(JSON.stringify(payload));
    return {
      content,
      fields: {
        deliveryTag: 1,
        redelivered: false,
        exchange: 'webhook_exchange',
        routingKey: 'webhook.deliver',
        consumerTag: 'amq.ctag-webhook-test'
      },
      properties: {
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        headers: {
          'x-correlation-id': '01M0TESTCORRELATIONID0001',
          ...headers
        },
        deliveryMode: 2,
        priority: 0,
        correlationId: '01M0TESTCORRELATIONID0001',
        messageId: '01M0TESTMSGID000000000001'
      } as unknown as amqp.MessageProperties
    };
  }

  const validEndpoint = {
    id: 10,
    merchantId: 1,
    url: 'https://merchant-api.example.com/webhooks',
    secret: 'whsec_test_secret_key_12345',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const validPayload = {
    merchantId: 1,
    eventType: 'payment.success',
    data: {
      orderRef: 'ord_12345',
      amount: 5000,
      currency: 'INR'
    },
    retryCount: 0
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearPendingWebhookRetries();

    mockChannel = {
      ack: vi.fn(),
      nack: vi.fn(),
      publish: vi.fn().mockReturnValue(true)
    };

    vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([validEndpoint]);
    vi.mocked(webhookRepo.logWebhookDelivery).mockResolvedValue(101);
    vi.mocked(webhookRepo.updateWebhookDelivery).mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearPendingWebhookRetries();
  });

  /* ------------------------------------------------------------------ */
  /*  1. Successful Delivery                                            */
  /* ------------------------------------------------------------------ */

  describe('1. Successful Webhook Delivery', () => {
    it('delivers webhook payload with HMAC-SHA256 signature and acks message on HTTP 200', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200
      } as Response);

      const msg = createMockMessage(validPayload);
      await handleWebhookMessage(mockChannel, msg, { fetchFn: mockFetch });

      expect(webhookRepo.logWebhookDelivery).toHaveBeenCalledWith(
        10,
        'payment.success',
        expect.objectContaining({
          type: 'payment.success',
          data: validPayload.data
        }),
        'pending',
        null
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://merchant-api.example.com/webhooks',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-paybridge-signature': expect.any(String),
            'User-Agent': 'PayBridge-Webhook/1.0'
          })
        })
      );

      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'success', 200);
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.publish).not.toHaveBeenCalled();
    });

    it('acknowledges and drops message when merchant has no active webhook endpoint', async () => {
      vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([]);
      const mockFetch = vi.fn();

      const msg = createMockMessage(validPayload);
      await handleWebhookMessage(mockChannel, msg, { fetchFn: mockFetch });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.logWebhookDelivery).not.toHaveBeenCalled();
    });

    it('acknowledges and drops malformed non-JSON message', async () => {
      const mockFetch = vi.fn();
      const msg = createMockMessage('not-valid-json{{{');

      await handleWebhookMessage(mockChannel, msg, { fetchFn: mockFetch });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it('acknowledges and drops message missing merchantId or eventType', async () => {
      const mockFetch = vi.fn();
      const msg = createMockMessage({ data: { foo: 'bar' } });

      await handleWebhookMessage(mockChannel, msg, { fetchFn: mockFetch });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Asynchronous Non-Blocking Retry Scheduling                     */
  /* ------------------------------------------------------------------ */

  describe('2. Asynchronous Non-Blocking Retry Scheduling', () => {
    it('immediately acks message and schedules asynchronous retry without blocking event loop', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const mockScheduleRetry = vi.fn();

      const msg = createMockMessage(validPayload);
      const startTime = Date.now();

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      const elapsedTime = Date.now() - startTime;

      // Must complete immediately without sleeping (well under 100ms)
      expect(elapsedTime).toBeLessThan(100);

      // Must immediately ack original message to free prefetch slot
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);

      // Must record failure in delivery log
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);

      // Must schedule retry for attempt 0 -> 1000ms backoff
      expect(mockScheduleRetry).toHaveBeenCalledWith(expect.any(Function), 1000);
      expect(mockChannel.publish).not.toHaveBeenCalled();

      // Executing the scheduled callback should publish incremented retryCount to queue
      const scheduledCallback = mockScheduleRetry.mock.calls[0][0];
      scheduledCallback();

      expect(mockChannel.publish).toHaveBeenCalledWith(
        '',
        'webhook_queue',
        expect.any(Buffer),
        expect.objectContaining({
          persistent: true,
          headers: expect.objectContaining({
            'x-correlation-id': '01M0TESTCORRELATIONID0001'
          }),
          correlationId: '01M0TESTCORRELATIONID0001'
        })
      );

      const publishedBuffer = vi.mocked(mockChannel.publish).mock.calls[0][2];
      const publishedPayload = JSON.parse(publishedBuffer.toString());
      expect(publishedPayload.retryCount).toBe(1);
    });

    it('enforces exponential backoff schedule: 1s, 2s, 4s, 8s, 16s across retry attempts', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 503 } as Response);
      const expectedBackoffs = [
        { retryCount: 0, expectedDelayMs: 1000 },
        { retryCount: 1, expectedDelayMs: 2000 },
        { retryCount: 2, expectedDelayMs: 4000 },
        { retryCount: 3, expectedDelayMs: 8000 },
        { retryCount: 4, expectedDelayMs: 16000 }
      ];

      for (const { retryCount, expectedDelayMs } of expectedBackoffs) {
        const mockScheduleRetry = vi.fn();
        const msg = createMockMessage({ ...validPayload, retryCount });

        await handleWebhookMessage(mockChannel, msg, {
          fetchFn: mockFetch,
          scheduleRetry: mockScheduleRetry
        });

        expect(mockScheduleRetry).toHaveBeenCalledWith(expect.any(Function), expectedDelayMs);
        expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      }
    });

    it('drops message after reaching MAX_RETRIES (5) without scheduling further retries', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 500 } as Response);
      const mockScheduleRetry = vi.fn();

      const msg = createMockMessage({ ...validPayload, retryCount: MAX_WEBHOOK_RETRIES });

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.publish).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Worker Lifecycle & Shutdown Integration                        */
  /* ------------------------------------------------------------------ */

  describe('3. Worker Lifecycle & Shutdown Integration', () => {
    it('starts worker with prefetch(5) and cancels consumer on stop', async () => {
      const mockAmqpChannel = {
        prefetch: vi.fn().mockResolvedValue(undefined),
        consume: vi.fn().mockResolvedValue({ consumerTag: 'amq.ctag-webhook-worker-1' }),
        cancel: vi.fn().mockResolvedValue(undefined)
      } as unknown as amqp.Channel;

      const worker = await startWebhookWorker(mockAmqpChannel);

      expect(mockAmqpChannel.prefetch).toHaveBeenCalledWith(5);
      expect(mockAmqpChannel.consume).toHaveBeenCalledWith(
        'webhook_queue',
        expect.any(Function)
      );
      expect(worker.consumerTag).toBe('amq.ctag-webhook-worker-1');

      await stopWebhookWorker();
      expect(mockAmqpChannel.cancel).toHaveBeenCalledWith('amq.ctag-webhook-worker-1');
    });

    it('flushes pending retries immediately upon graceful shutdown', () => {
      const mockAction = vi.fn();
      scheduleDelayedWebhookPublish(mockAction, 5000);

      expect(mockAction).not.toHaveBeenCalled();

      // Trigger flushPendingWebhookRetries directly
      flushPendingWebhookRetries();
      expect(mockAction).toHaveBeenCalledTimes(1);
    });
  });
});
