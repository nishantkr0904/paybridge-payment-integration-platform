import { describe, it, expect, vi, beforeEach } from 'vitest';
import type amqp from 'amqplib';
import * as redisInfra from '../../infrastructure/redis.js';
import * as rabbitmqInfra from '../../infrastructure/rabbitmq.js';
import * as paymentRepo from '../../modules/payment/payment.repository.js';
import {
  handlePaymentMessage,
  type GatewaySimulationResult,
  type PaymentChannel
} from '../../workers/payment.worker.js';
import type { Transaction } from '../../modules/payment/payment.types.js';

vi.mock('../../infrastructure/redis.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  redis: {},
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn()
}));

vi.mock('../../infrastructure/rabbitmq.js', () => ({
  getRabbitMQChannel: vi.fn(),
  QUEUES: {
    PAYMENT_PROCESSING: 'payment_processing_queue',
    PAYMENT_DLQ: 'payment_dlq',
    WEBHOOK_DELIVERY: 'webhook_queue'
  },
  EXCHANGES: {
    PAYMENT: 'payment_exchange',
    DLX: 'dlx_exchange',
    WEBHOOK: 'webhook_exchange'
  }
}));

vi.mock('../../modules/payment/payment.repository.js', () => ({
  findTransactionById: vi.fn(),
  updateTransactionStatus: vi.fn(),
  updateOrderStatus: vi.fn()
}));

describe('Payment Worker Execution Safety (payment.worker.ts)', () => {
  const mockTransaction: Transaction = {
    id: 501,
    orderId: 101,
    txnRef: '01M0AJX6N6SPVYPE0T9EHPGD5F',
    paymentMethod: 'card',
    status: 'processing',
    gatewayResponse: null,
    failureReason: null,
    amount: 1500,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const validJobPayload = {
    transactionId: 501,
    orderId: 101,
    merchantId: 1,
    orderRef: '01M0AJX6JAD1K8PX8AXXXWJDHS',
    txnRef: '01M0AJX6N6SPVYPE0T9EHPGD5F',
    paymentMethod: 'card',
    amount: 1500,
    retryCount: 0
  };

  let mockChannel: PaymentChannel;

  function createMockMessage(payload: unknown): amqp.ConsumeMessage {
    const content =
      typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(JSON.stringify(payload));
    return {
      content,
      fields: {} as unknown as amqp.ConsumeMessageFields,
      properties: {} as amqp.MessageProperties
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockChannel = {
      ack: vi.fn(),
      nack: vi.fn(),
      publish: vi.fn().mockReturnValue(true)
    };

    vi.mocked(redisInfra.acquireLock).mockResolvedValue('worker-lock-token-123');
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    vi.mocked(paymentRepo.findTransactionById).mockResolvedValue({ ...mockTransaction });
    vi.mocked(paymentRepo.updateTransactionStatus).mockResolvedValue(true);
    vi.mocked(paymentRepo.updateOrderStatus).mockResolvedValue(true);
  });

  describe('1. Valid Job Processing & State Transitions', () => {
    it('processes a valid payment job successfully and acknowledges message', async () => {
      const mockGatewaySuccess: GatewaySimulationResult = {
        success: true,
        gatewayResponse: {
          provider: 'paybridge-sim',
          method: 'card',
          authCode: 'AUTH_OK_123',
          processedAt: new Date().toISOString()
        }
      };
      const mockGateway = vi.fn().mockReturnValue(mockGatewaySuccess);

      const msg = createMockMessage(validJobPayload);
      await handlePaymentMessage(mockChannel, msg, mockGateway);

      // Lock lifecycle
      expect(redisInfra.acquireLock).toHaveBeenCalledWith('lock:worker:txn:501', 30);
      expect(redisInfra.releaseLock).toHaveBeenCalledWith(
        'lock:worker:txn:501',
        'worker-lock-token-123'
      );

      // Side effect execution
      expect(mockGateway).toHaveBeenCalledWith('card');

      // State persistence
      expect(paymentRepo.updateTransactionStatus).toHaveBeenCalledWith(
        501,
        1,
        'success',
        mockGatewaySuccess.gatewayResponse,
        undefined
      );
      expect(paymentRepo.updateOrderStatus).toHaveBeenCalledWith(101, 1, 'success');

      // Webhook published
      expect(mockChannel.publish).toHaveBeenCalledWith(
        rabbitmqInfra.EXCHANGES.WEBHOOK,
        'webhook.deliver',
        expect.any(Buffer),
        expect.objectContaining({ persistent: true })
      );

      // Acknowledged
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('handles business/issuer declines safely by persisting failure and acknowledging message', async () => {
      const mockGatewayDecline: GatewaySimulationResult = {
        success: false,
        gatewayResponse: {
          provider: 'paybridge-sim',
          method: 'card',
          errorCode: 'GATEWAY_DECLINED',
          processedAt: new Date().toISOString()
        },
        failureReason: 'Insufficient funds'
      };
      const mockGateway = vi.fn().mockReturnValue(mockGatewayDecline);

      const msg = createMockMessage(validJobPayload);
      await handlePaymentMessage(mockChannel, msg, mockGateway);

      expect(paymentRepo.updateTransactionStatus).toHaveBeenCalledWith(
        501,
        1,
        'failed',
        mockGatewayDecline.gatewayResponse,
        'Insufficient funds'
      );
      expect(paymentRepo.updateOrderStatus).toHaveBeenCalledWith(101, 1, 'failed');

      // Webhook published with payment.failed
      expect(mockChannel.publish).toHaveBeenCalledWith(
        rabbitmqInfra.EXCHANGES.WEBHOOK,
        'webhook.deliver',
        expect.any(Buffer),
        expect.objectContaining({ persistent: true })
      );

      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });
  });

  describe('2. Duplicate Delivery Safety', () => {
    it('does NOT execute payment side effect if transaction is already in success terminal state', async () => {
      vi.mocked(paymentRepo.findTransactionById).mockResolvedValue({
        ...mockTransaction,
        status: 'success'
      });

      const mockGateway = vi.fn();
      const msg = createMockMessage(validJobPayload);

      await handlePaymentMessage(mockChannel, msg, mockGateway);

      // Side effect must NOT be called
      expect(mockGateway).not.toHaveBeenCalled();
      expect(paymentRepo.updateTransactionStatus).not.toHaveBeenCalled();
      expect(paymentRepo.updateOrderStatus).not.toHaveBeenCalled();
      expect(mockChannel.publish).not.toHaveBeenCalled();

      // Lock should not even be acquired
      expect(redisInfra.acquireLock).not.toHaveBeenCalled();

      // Message safely acknowledged
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it('does NOT execute payment side effect if transaction is already in failed terminal state', async () => {
      vi.mocked(paymentRepo.findTransactionById).mockResolvedValue({
        ...mockTransaction,
        status: 'failed'
      });

      const mockGateway = vi.fn();
      const msg = createMockMessage(validJobPayload);

      await handlePaymentMessage(mockChannel, msg, mockGateway);

      expect(mockGateway).not.toHaveBeenCalled();
      expect(paymentRepo.updateTransactionStatus).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  describe('3. Concurrency Protection & Contention', () => {
    it('prevents concurrent worker from double processing when lock cannot be acquired', async () => {
      // Simulate another worker holding the lock
      vi.mocked(redisInfra.acquireLock).mockResolvedValue(null);

      const mockGateway = vi.fn();
      const msg = createMockMessage(validJobPayload);

      await handlePaymentMessage(mockChannel, msg, mockGateway);

      // Must not execute side effect
      expect(mockGateway).not.toHaveBeenCalled();
      expect(paymentRepo.updateTransactionStatus).not.toHaveBeenCalled();

      // Must nack with requeue=true so it can be retried later
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, true);
      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(redisInfra.releaseLock).not.toHaveBeenCalled();
    });
  });

  describe('4. Retry Handling & DLQ Exhaustion', () => {
    it('enqueues retry message and acknowledges current message when transient error occurs', async () => {
      const mockGateway = vi.fn().mockImplementation(() => {
        throw new Error('Transient Gateway Timeout');
      });

      const msg = createMockMessage({ ...validJobPayload, retryCount: 1 });
      await handlePaymentMessage(mockChannel, msg, mockGateway);

      // Publishes retry message with retryCount: 2
      expect(mockChannel.publish).toHaveBeenCalledWith(
        '',
        rabbitmqInfra.QUEUES.PAYMENT_PROCESSING,
        expect.any(Buffer),
        expect.objectContaining({ persistent: true })
      );

      const publishedPayload = JSON.parse(
        vi.mocked(mockChannel.publish).mock.calls[0]?.[2]?.toString() ?? '{}'
      );
      expect(publishedPayload.retryCount).toBe(2);

      // Acknowledges the original message
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('sends message to DLQ and updates database state when max retries are exhausted', async () => {
      const mockGateway = vi.fn().mockImplementation(() => {
        throw new Error('Transient Gateway Timeout');
      });

      const msg = createMockMessage({ ...validJobPayload, retryCount: 3 });
      await handlePaymentMessage(mockChannel, msg, mockGateway);

      // Database marked failed due to max retry exhaustion
      expect(paymentRepo.updateTransactionStatus).toHaveBeenCalledWith(
        501,
        1,
        'failed',
        undefined,
        'System Error: Max retries exceeded'
      );
      expect(paymentRepo.updateOrderStatus).toHaveBeenCalledWith(101, 1, 'failed');

      // NACK without requeue (sends to DLQ)
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });
  });

  describe('5. Malformed Data & Unknown Transaction Handling', () => {
    it('sends malformed non-JSON messages directly to DLQ without requeue', async () => {
      const msg = createMockMessage('invalid-json-string');
      await handlePaymentMessage(mockChannel, msg);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('sends payloads missing required fields directly to DLQ', async () => {
      const msg = createMockMessage({ transactionId: 501 }); // Missing orderId, orderRef, paymentMethod
      await handlePaymentMessage(mockChannel, msg);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('sends message to DLQ when transaction ID does not exist in DB', async () => {
      vi.mocked(paymentRepo.findTransactionById).mockResolvedValue(null);

      const msg = createMockMessage(validJobPayload);
      await handlePaymentMessage(mockChannel, msg);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });
  });

  describe('6. Failure Safety on DB Write Errors', () => {
    it('does NOT acknowledge message as success if database update throws', async () => {
      vi.mocked(paymentRepo.updateTransactionStatus).mockRejectedValue(
        new Error('DB Connection Lost')
      );

      const mockGatewaySuccess: GatewaySimulationResult = {
        success: true,
        gatewayResponse: { provider: 'paybridge-sim' }
      };
      const mockGateway = vi.fn().mockReturnValue(mockGatewaySuccess);

      const msg = createMockMessage(validJobPayload);
      await handlePaymentMessage(mockChannel, msg, mockGateway);

      // Because DB write threw, it enters the error retry path rather than acknowledging as success
      expect(mockChannel.publish).toHaveBeenCalledWith(
        '',
        rabbitmqInfra.QUEUES.PAYMENT_PROCESSING,
        expect.any(Buffer),
        expect.objectContaining({ persistent: true })
      );
    });
  });
});
