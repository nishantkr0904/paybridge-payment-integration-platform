import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type amqp from 'amqplib';
import * as webhookRepo from '../../modules/webhook/webhook.repository.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { addEndpointSchema } from '../../modules/webhook/webhook.routes.js';
import {
  handleWebhookMessage,
  startWebhookWorker,
  stopWebhookWorker,
  clearPendingWebhookRetries,
  flushPendingWebhookRetries,
  scheduleDelayedWebhookPublish,
  isRedirectError,
  MAX_WEBHOOK_RETRIES,
  type WebhookChannel
} from '../../workers/webhook.worker.js';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn()
  },
  lookup: vi.fn()
}));

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
  let loggedEvents: Array<{ level: string; args: unknown[] }> = [];
  const originalChild = logger.child;

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
    loggedEvents = [];

    // Default DNS mock resolves to a legitimate public IP address
    vi.mocked(dns.lookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 }
    ] as unknown as LookupAddress);

    // Spy on logger child to capture structured log events (e.g. BLOCKED_SSRF_TARGET)
    logger.child = function (bindings: Record<string, unknown>) {
      const child = originalChild.call(logger, bindings);
      const origWarn = child.warn;
      const origError = child.error;
      child.warn = (...args: Parameters<typeof origWarn>) => {
        loggedEvents.push({ level: 'warn', args });
        return origWarn.apply(child, args);
      };
      child.error = (...args: Parameters<typeof origError>) => {
        loggedEvents.push({ level: 'error', args });
        return origError.apply(child, args);
      };
      return child;
    } as typeof logger.child;

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
    logger.child = originalChild;
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
          }),
          redirect: 'error'
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

  /* ------------------------------------------------------------------ */
  /*  4. Ingress Route Validation (addEndpointSchema)                   */
  /* ------------------------------------------------------------------ */

  describe('4. Ingress Route Validation (addEndpointSchema)', () => {
    const originalAllowed = env.WEBHOOK_ALLOWED_INTERNAL_TARGETS;

    beforeEach(() => {
      (env as { WEBHOOK_ALLOWED_INTERNAL_TARGETS: string }).WEBHOOK_ALLOWED_INTERNAL_TARGETS =
        'paybridge-api:4000';
    });

    afterEach(() => {
      (env as { WEBHOOK_ALLOWED_INTERNAL_TARGETS: string }).WEBHOOK_ALLOWED_INTERNAL_TARGETS =
        originalAllowed;
    });

    it('accepts valid public HTTPS endpoints', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://merchant-api.example.com/webhooks'
      });
      expect(result.success).toBe(true);
    });

    it('rejects public plaintext HTTP endpoints', () => {
      const result = addEndpointSchema.safeParse({
        url: 'http://merchant-api.example.com/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/HTTPS for public endpoints/i);
      }
    });

    it('accepts exact configured internal target over HTTP', () => {
      const result = addEndpointSchema.safeParse({
        url: 'http://paybridge-api:4000/api/v1/webhook-test'
      });
      expect(result.success).toBe(true);
    });

    it('rejects internal target on unauthorized port (3306)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'http://paybridge-api:3306/webhooks'
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-HTTP/HTTPS protocol (ftp:)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'ftp://merchant-api.example.com/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/Unsupported protocol/i);
      }
    });

    it('rejects localhost hostname on HTTP and HTTPS', () => {
      const httpResult = addEndpointSchema.safeParse({
        url: 'http://localhost/webhooks'
      });
      expect(httpResult.success).toBe(false);

      const httpsResult = addEndpointSchema.safeParse({
        url: 'https://localhost/webhooks'
      });
      expect(httpsResult.success).toBe(false);
      if (!httpsResult.success) {
        expect(httpsResult.error.issues[0].message).toMatch(/cannot be localhost/i);
      }
    });

    it('rejects literal loopback IP (127.0.0.1)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://127.0.0.1/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects literal cloud metadata IP (169.254.169.254)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://169.254.169.254/latest/meta-data'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects literal private RFC 1918 IP (10.0.0.1)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://10.0.0.1/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects bracketed IPv6 loopback (https://[::1]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[::1]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects bracketed IPv6 link-local (https://[fe80::1]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[fe80::1]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects bracketed IPv4-mapped loopback (https://[::ffff:127.0.0.1]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[::ffff:127.0.0.1]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects bracketed IPv4-mapped metadata (https://[::ffff:169.254.169.254]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[::ffff:169.254.169.254]/latest/meta-data'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects IPv4-compatible loopback (https://[::7f00:1]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[::7f00:1]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects IPv4-compatible private address (https://[::a00:1]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[::a00:1]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects IPv4-compatible metadata (https://[::a9fe:a9fe]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[::a9fe:a9fe]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects 6to4 embedded loopback (https://[2002:7f00:1::]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[2002:7f00:1::]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('rejects 6to4 embedded metadata (https://[2002:a9fe:a9fe::]/webhooks)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'https://[2002:a9fe:a9fe::]/webhooks'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/private or reserved IP address/i);
      }
    });

    it('accepts legitimate paybridge-api:4000 ingress acceptance', () => {
      const result = addEndpointSchema.safeParse({
        url: 'http://paybridge-api:4000/api/webhooks/test-listener'
      });
      expect(result.success).toBe(true);
    });

    it('rejects paybridge-api wrong-port rejection (paybridge-api:3306)', () => {
      const result = addEndpointSchema.safeParse({
        url: 'http://paybridge-api:3306/webhooks'
      });
      expect(result.success).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. Delivery-Time SSRF Validation & Terminal Drop Handling        */
  /* ------------------------------------------------------------------ */

  describe('5. Delivery-Time SSRF Validation & Terminal Drop Handling', () => {
    it('blocks destination resolving to private/loopback IP (127.0.0.1), acks message, logs BLOCKED_SSRF_TARGET, and does not retry', async () => {
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: '127.0.0.1', family: 4 }
      ] as unknown as LookupAddress);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.publish).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);

      const hasBlockedLog = loggedEvents.some((e) =>
        e.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>).reason === 'BLOCKED_SSRF_TARGET'
        )
      );
      expect(hasBlockedLog).toBe(true);
    });

    it('blocks destination resolving to mixed public and private IPs (93.184.216.34 and 10.0.0.1)', async () => {
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 }
      ] as unknown as LookupAddress);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);

      const hasBlockedLog = loggedEvents.some((e) =>
        e.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>).reason === 'BLOCKED_SSRF_TARGET'
        )
      );
      expect(hasBlockedLog).toBe(true);
    });

    it('blocks destination resolving to IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', async () => {
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: '::ffff:127.0.0.1', family: 6 }
      ] as unknown as LookupAddress);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);
    });

    it('blocks destination resolving to cloud metadata IP (169.254.169.254)', async () => {
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: '169.254.169.254', family: 4 }
      ] as unknown as LookupAddress);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);
    });

    it.each([
      ['bracketed IPv6 loopback', 'https://[::1]/webhook'],
      ['bracketed IPv6 link-local', 'https://[fe80::1]/webhook'],
      ['bracketed IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/webhook'],
      ['bracketed IPv4-compatible loopback', 'https://[::7f00:1]/webhook'],
      ['bracketed 6to4 embedded loopback', 'https://[2002:7f00:1::]/webhook']
    ])('blocks delivery to %s (%s) terminally without retries', async (_name, url) => {
      vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([
        {
          ...validEndpoint,
          url
        }
      ]);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);

      const hasBlockedLog = loggedEvents.some((e) =>
        e.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>).reason === 'BLOCKED_SSRF_TARGET'
        )
      );
      expect(hasBlockedLog).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  6. Internal Authority & Port Restrictions                        */
  /* ------------------------------------------------------------------ */

  describe('6. Delivery-Time Internal Authority & Port Restrictions', () => {
    it('allows delivery to exact allowlisted internal authority (paybridge-api:4000)', async () => {
      vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([
        {
          ...validEndpoint,
          url: 'http://paybridge-api:4000/api/v1/webhook-test'
        }
      ]);

      const mockFetch = vi.fn().mockResolvedValue({ status: 200 } as Response);
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        allowedInternalTargets: 'paybridge-api:4000'
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://paybridge-api:4000/api/v1/webhook-test',
        expect.objectContaining({ redirect: 'error' })
      );
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'success', 200);
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it('blocks internal authority on unauthorized port (paybridge-api:3306)', async () => {
      vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([
        {
          ...validEndpoint,
          url: 'http://paybridge-api:3306/webhooks'
        }
      ]);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry,
        allowedInternalTargets: 'paybridge-api:4000'
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);
    });

    it('blocks internal authority on Redis port (paybridge-api:6379)', async () => {
      vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([
        {
          ...validEndpoint,
          url: 'http://paybridge-api:6379/webhooks'
        }
      ]);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry,
        allowedInternalTargets: 'paybridge-api:4000'
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);
    });

    it('blocks internal authority without explicit port 4000 (http://paybridge-api/webhooks)', async () => {
      vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([
        {
          ...validEndpoint,
          url: 'http://paybridge-api/webhooks'
        }
      ]);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry,
        allowedInternalTargets: 'paybridge-api:4000'
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);
    });

    it('blocks other Docker internal services (paybridge-mysql:3306, paybridge-redis:6379, paybridge-rabbitmq:5672)', async () => {
      const blockedUrls = [
        'http://paybridge-mysql:3306/webhooks',
        'http://paybridge-redis:6379/webhooks',
        'http://paybridge-rabbitmq:5672/webhooks'
      ];

      for (const url of blockedUrls) {
        vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([
          {
            ...validEndpoint,
            url
          }
        ]);

        const mockFetch = vi.fn();
        const mockScheduleRetry = vi.fn();
        const msg = createMockMessage(validPayload);

        await handleWebhookMessage(mockChannel, msg, {
          fetchFn: mockFetch,
          scheduleRetry: mockScheduleRetry,
          allowedInternalTargets: 'paybridge-api:4000'
        });

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockScheduleRetry).not.toHaveBeenCalled();
        expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      }
    });

    it('blocks localhost:4000 even if port 4000 is used', async () => {
      vi.mocked(webhookRepo.getWebhookEndpoints).mockResolvedValue([
        {
          ...validEndpoint,
          url: 'http://localhost:4000/webhooks'
        }
      ]);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry,
        allowedInternalTargets: 'paybridge-api:4000'
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  7. Transient DNS Failure vs Deterministic SSRF Distinction        */
  /* ------------------------------------------------------------------ */

  describe('7. Transient DNS Failure Handling', () => {
    it('propagates transient DNS error (EAI_AGAIN) into standard retry pipeline with backoff and does NOT log BLOCKED_SSRF_TARGET', async () => {
      const dnsError = Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
        code: 'EAI_AGAIN'
      });
      vi.mocked(dns.lookup).mockRejectedValue(dnsError);

      const mockFetch = vi.fn();
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);

      // Must schedule retry with 1000ms backoff
      expect(mockScheduleRetry).toHaveBeenCalledWith(expect.any(Function), 1000);

      // Must NOT log BLOCKED_SSRF_TARGET for transient DNS failures
      const hasBlockedLog = loggedEvents.some((e) =>
        e.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>).reason === 'BLOCKED_SSRF_TARGET'
        )
      );
      expect(hasBlockedLog).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  8. Redirect Policy & Terminal Drop Rejection                      */
  /* ------------------------------------------------------------------ */

  describe('8. Redirect Policy & Rejection', () => {
    it('rejects HTTP redirect as terminal security failure, acks message, logs BLOCKED_SSRF_TARGET, and does not retry', async () => {
      // WHATWG Fetch / undici throws TypeError: fetch failed with cause unexpected redirect when redirect: 'error'
      const redirectError = new TypeError('fetch failed', {
        cause: new Error('unexpected redirect')
      });

      const mockFetch = vi.fn().mockRejectedValue(redirectError);
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://merchant-api.example.com/webhooks',
        expect.objectContaining({ redirect: 'error' })
      );
      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.publish).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);

      const hasBlockedLog = loggedEvents.some((e) =>
        e.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            (arg as Record<string, unknown>).reason === 'BLOCKED_SSRF_TARGET' &&
            (arg as Record<string, unknown>).detail === 'REDIRECT_NOT_ALLOWED'
        )
      );
      expect(hasBlockedLog).toBe(true);
    });

    it('rejects custom/standard redirect error messages without cause object', async () => {
      const redirectError = new Error('Redirect mode is set to error: unexpected redirect');

      const mockFetch = vi.fn().mockRejectedValue(redirectError);
      const mockScheduleRetry = vi.fn();
      const msg = createMockMessage(validPayload);

      await handleWebhookMessage(mockChannel, msg, {
        fetchFn: mockFetch,
        scheduleRetry: mockScheduleRetry
      });

      expect(mockScheduleRetry).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(webhookRepo.updateWebhookDelivery).toHaveBeenCalledWith(101, 'failed', null);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  9. isRedirectError Helper Unit Tests                              */
  /* ------------------------------------------------------------------ */

  describe('9. isRedirectError Helper', () => {
    it('correctly identifies various redirect errors', () => {
      const errWithCause = new TypeError('fetch failed', {
        cause: new Error('unexpected redirect')
      });
      expect(isRedirectError(errWithCause)).toBe(true);

      expect(isRedirectError(new Error('Redirect not allowed'))).toBe(true);
      expect(isRedirectError(new Error('HTTP redirect detected'))).toBe(true);
      expect(isRedirectError('redirect failed')).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(isRedirectError(new Error('ECONNREFUSED'))).toBe(false);
      expect(isRedirectError(new Error('ETIMEDOUT'))).toBe(false);
      expect(isRedirectError(new TypeError('Failed to fetch'))).toBe(false);
      expect(isRedirectError(null)).toBe(false);
      expect(isRedirectError(undefined)).toBe(false);
    });
  });
});
