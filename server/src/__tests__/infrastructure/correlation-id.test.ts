import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type amqp from 'amqplib';
import {
  CORRELATION_ID_HEADER,
  ALT_REQUEST_ID_HEADER,
  isValidCorrelationId,
  normalizeCorrelationId,
  correlationIdMiddleware
} from '../../middleware/correlation-id.js';
import { createApp } from '../../app.js';
import { processPayment } from '../../modules/payment/payment.service.js';
import { handlePaymentMessage } from '../../workers/payment.worker.js';
import * as rabbitmqInfra from '../../infrastructure/rabbitmq.js';
import * as redisInfra from '../../infrastructure/redis.js';
import * as idempotencyService from '../../modules/idempotency/idempotency.service.js';
import * as paymentRepo from '../../modules/payment/payment.repository.js';
import { logger } from '../../utils/logger.js';

describe('Correlation ID Propagation & Tracing (TASK-005 / AT-OBS-001)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Correlation ID Validation & Normalization', () => {
    it('accepts valid alphanumeric, UUID, and ULID correlation IDs', () => {
      expect(isValidCorrelationId('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
      expect(isValidCorrelationId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidCorrelationId('req_checkout.123_abc:99')).toBe(true);
    });

    it('rejects empty, non-string, or oversized correlation IDs', () => {
      expect(isValidCorrelationId('')).toBe(false);
      expect(isValidCorrelationId('   ')).toBe(false);
      expect(isValidCorrelationId(null)).toBe(false);
      expect(isValidCorrelationId(undefined)).toBe(false);
      expect(isValidCorrelationId(12345)).toBe(false);
      expect(isValidCorrelationId('a'.repeat(129))).toBe(false);
    });

    it('rejects strings with control characters, spaces, or log-injection vectors', () => {
      expect(isValidCorrelationId('id\nwith\nnewlines')).toBe(false);
      expect(isValidCorrelationId('id\rwith\rcarriage')).toBe(false);
      expect(isValidCorrelationId('id with spaces')).toBe(false);
      expect(isValidCorrelationId('<script>alert(1)</script>')).toBe(false);
      expect(isValidCorrelationId('id"with"quotes')).toBe(false);
    });

    it('normalizes valid IDs and generates fresh IDs for invalid inputs', () => {
      const valid = 'trace-id-abc-123';
      expect(normalizeCorrelationId(valid)).toBe(valid);

      const generatedForInvalid = normalizeCorrelationId('invalid\nid');
      expect(typeof generatedForInvalid).toBe('string');
      expect(generatedForInvalid.length).toBeGreaterThan(10);
      expect(isValidCorrelationId(generatedForInvalid)).toBe(true);

      const generatedForEmpty = normalizeCorrelationId('');
      expect(isValidCorrelationId(generatedForEmpty)).toBe(true);
    });
  });

  describe('Correlation ID Express Middleware', () => {
    it('generates a fresh correlation ID when no headers are provided', () => {
      const req = {
        headers: {}
      } as unknown as Request;

      const setHeaderMock = vi.fn();
      const res = {
        setHeader: setHeaderMock
      } as unknown as Response;

      const nextMock = vi.fn();

      correlationIdMiddleware(req, res, nextMock);

      expect(req.correlationId).toBeDefined();
      expect(req.id).toBe(req.correlationId);
      expect(isValidCorrelationId(req.correlationId)).toBe(true);
      expect(setHeaderMock).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        req.correlationId
      );
      expect(nextMock).toHaveBeenCalledTimes(1);
    });

    it('preserves a valid client-provided x-correlation-id header', () => {
      const clientCorrelationId = 'client-trace-999-xyz';
      const req = {
        headers: {
          [CORRELATION_ID_HEADER]: clientCorrelationId
        }
      } as unknown as Request;

      const setHeaderMock = vi.fn();
      const res = {
        setHeader: setHeaderMock
      } as unknown as Response;

      const nextMock = vi.fn();

      correlationIdMiddleware(req, res, nextMock);

      expect(req.correlationId).toBe(clientCorrelationId);
      expect(req.id).toBe(clientCorrelationId);
      expect(setHeaderMock).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        clientCorrelationId
      );
      expect(nextMock).toHaveBeenCalledTimes(1);
    });

    it('preserves x-request-id as fallback when x-correlation-id is absent', () => {
      const clientRequestId = 'client-req-555';
      const req = {
        headers: {
          [ALT_REQUEST_ID_HEADER]: clientRequestId
        }
      } as unknown as Request;

      const setHeaderMock = vi.fn();
      const res = {
        setHeader: setHeaderMock
      } as unknown as Response;

      const nextMock = vi.fn();

      correlationIdMiddleware(req, res, nextMock);

      expect(req.correlationId).toBe(clientRequestId);
      expect(setHeaderMock).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        clientRequestId
      );
    });

    it('sanitizes oversized or malicious headers and generates a safe alternative', () => {
      const maliciousId = 'malicious\nid\nwith\r\ninjection';
      const req = {
        headers: {
          [CORRELATION_ID_HEADER]: maliciousId
        }
      } as unknown as Request;

      const setHeaderMock = vi.fn();
      const res = {
        setHeader: setHeaderMock
      } as unknown as Response;

      const nextMock = vi.fn();

      correlationIdMiddleware(req, res, nextMock);

      expect(req.correlationId).not.toBe(maliciousId);
      expect(isValidCorrelationId(req.correlationId)).toBe(true);
      expect(setHeaderMock).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        req.correlationId
      );
    });
  });

  describe('HTTP End-to-End API Header Reflection', () => {
    it('sets x-correlation-id response header on route handling', () => {
      const app = createApp();

      const reqHeaders = { 'x-correlation-id': 'e2e-trace-header-123' };
      const responseHeaders: Record<string, string> = {};

      const req = {
        url: '/api/health',
        method: 'GET',
        headers: reqHeaders
      };

      const res = {
        statusCode: 200,
        setHeader(name: string, val: string) {
          responseHeaders[name.toLowerCase()] = val;
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json: vi.fn()
      };

      // Execute through Express app router
      interface RouterLayer {
        name?: string;
        route?: { path: string };
        handle_request: (req: unknown, res: unknown, next: () => void) => void;
      }
      const middlewareLayer = (app as unknown as { _router: { stack: RouterLayer[] } })._router.stack.find(
        (s) => s.handle_request === correlationIdMiddleware || s.name === 'correlationIdMiddleware'
      );
      expect(middlewareLayer).toBeDefined();

      middlewareLayer?.handle_request(req, res, () => {});
      expect(responseHeaders['x-correlation-id']).toBe('e2e-trace-header-123');
    });
  });

  describe('HTTP → RabbitMQ Message Header Propagation', () => {
    it('includes correlationId and traceId in RabbitMQ publish options when processing payment', async () => {
      const mockChannel = {
        publish: vi.fn().mockReturnValue(true)
      };
      vi.spyOn(rabbitmqInfra, 'getRabbitMQChannel').mockResolvedValue(
        mockChannel as unknown as amqp.Channel
      );

      vi.spyOn(redisInfra, 'acquireLock').mockResolvedValue('lock-token-123');
      vi.spyOn(redisInfra, 'releaseLock').mockResolvedValue(true);

      vi.spyOn(paymentRepo, 'findOrderByRef').mockResolvedValue({
        id: 10,
        merchantId: 1,
        orderRef: 'ord_prop_test',
        amount: 2500,
        currency: 'USD',
        description: 'Test Order',
        status: 'pending',
        customerEmail: 'test@example.com',
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      vi.spyOn(paymentRepo, 'createTransaction').mockResolvedValue({
        id: 101,
        orderId: 10,
        txnRef: 'txn_prop_test',
        paymentMethod: 'card',
        status: 'initiated',
        gatewayResponse: null,
        failureReason: null,
        amount: 2500,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      vi.spyOn(paymentRepo, 'updateTransactionStatus').mockResolvedValue(true);
      vi.spyOn(paymentRepo, 'updateOrderStatus').mockResolvedValue(true);

      // Bypass idempotency layer for direct publish assertion
      vi.spyOn(idempotencyService, 'executeWithIdempotency').mockImplementation(
        async (opts) => {
          const actionResult = await opts.action();
          return {
            isIdempotentReplay: false,
            statusCode: actionResult.statusCode,
            data: actionResult.data
          };
        }
      );

      const correlationId = 'http-corr-id-777';

      await processPayment(
        'ord_prop_test',
        1,
        { paymentMethod: 'card' },
        undefined,
        correlationId
      );

      expect(mockChannel.publish).toHaveBeenCalledTimes(1);
      const publishCall = mockChannel.publish.mock.calls[0];
      const publishOptions = publishCall[3];

      expect(publishOptions).toBeDefined();
      expect(publishOptions.correlationId).toBe(correlationId);
      expect(publishOptions.headers).toBeDefined();
      expect(publishOptions.headers['x-correlation-id']).toBe(correlationId);
      expect(publishOptions.headers.traceId).toBe(correlationId);
    });
  });

  describe('Worker Consumption & Downstream Propagation', () => {
    it('extracts correlationId from message headers and creates a contextual child logger', async () => {
      const childLoggerSpy = vi.spyOn(logger, 'child');

      const mockChannel = {
        ack: vi.fn(),
        nack: vi.fn(),
        publish: vi.fn().mockReturnValue(true)
      };

      const correlationId = 'msg-corr-888';

      const mockMsg = {
        content: Buffer.from(
          JSON.stringify({
            transactionId: 202,
            orderId: 20,
            merchantId: 1,
            orderRef: 'ord_worker_test',
            txnRef: 'txn_worker_test',
            paymentMethod: 'card',
            amount: 3000
          })
        ),
        properties: {
          headers: {
            'x-correlation-id': correlationId,
            traceId: correlationId
          },
          correlationId
        }
      } as unknown as amqp.ConsumeMessage;

      vi.spyOn(paymentRepo, 'findTransactionById').mockResolvedValue({
        id: 202,
        orderId: 20,
        amount: 3000,
        status: 'processing',
        txnRef: 'txn_worker_test',
        paymentMethod: 'card',
        gatewayResponse: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      vi.spyOn(redisInfra, 'acquireLock').mockResolvedValue('lock-token');
      vi.spyOn(redisInfra, 'releaseLock').mockResolvedValue(true);
      vi.spyOn(paymentRepo, 'updateTransactionStatus').mockResolvedValue(true);
      await handlePaymentMessage(
        mockChannel as unknown as amqp.Channel,
        mockMsg,
        () => ({
          success: true,
          gatewayResponse: { auth: 'ok' }
        })
      );

      // Assert logger.child was created with the extracted correlationId and traceId
      expect(childLoggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId,
          traceId: correlationId,
          transactionId: 202
        })
      );

      // Assert downstream webhook publication received the exact same correlationId
      expect(mockChannel.publish).toHaveBeenCalledWith(
        rabbitmqInfra.EXCHANGES.WEBHOOK,
        'webhook.deliver',
        expect.any(Buffer),
        expect.objectContaining({
          correlationId,
          headers: expect.objectContaining({
            'x-correlation-id': correlationId,
            traceId: correlationId
          })
        })
      );
    });

    it('gracefully handles legacy messages without correlation headers by generating a fresh ID', async () => {
      const childLoggerSpy = vi.spyOn(logger, 'child');

      const mockChannel = {
        ack: vi.fn(),
        nack: vi.fn(),
        publish: vi.fn().mockReturnValue(true)
      };

      const mockLegacyMsg = {
        content: Buffer.from(
          JSON.stringify({
            transactionId: 203,
            orderId: 20,
            merchantId: 1,
            orderRef: 'ord_legacy_test',
            paymentMethod: 'card'
          })
        ),
        properties: {} // No headers, no correlationId
      } as unknown as amqp.ConsumeMessage;

      vi.spyOn(paymentRepo, 'findTransactionById').mockResolvedValue({
        id: 203,
        orderId: 20,
        amount: 1500,
        status: 'processing',
        txnRef: 'txn_legacy_test',
        paymentMethod: 'card',
        gatewayResponse: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      vi.spyOn(redisInfra, 'acquireLock').mockResolvedValue('lock-token');
      vi.spyOn(redisInfra, 'releaseLock').mockResolvedValue(true);
      vi.spyOn(paymentRepo, 'updateTransactionStatus').mockResolvedValue(true);
      vi.spyOn(paymentRepo, 'updateOrderStatus').mockResolvedValue(true);

      await handlePaymentMessage(mockChannel as unknown as amqp.Channel, mockLegacyMsg);

      expect(childLoggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: expect.any(String),
          traceId: expect.any(String),
          transactionId: 203
        })
      );
    });
  });
});
