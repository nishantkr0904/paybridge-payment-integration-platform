import { describe, it, expect, vi, beforeEach } from 'vitest';
import type amqp from 'amqplib';
import * as redisInfra from '../../infrastructure/redis.js';
import * as rabbitmqInfra from '../../infrastructure/rabbitmq.js';
import * as paymentRepo from '../../modules/payment/payment.repository.js';
import * as policyRepo from '../../modules/policy/policy.repository.js';
import * as caseRepo from '../../modules/recovery/case.repository.js';
import * as caseService from '../../modules/recovery/case.service.js';
import {
  handleActionMessage,
  startActionWorker,
  type ActionChannel,
  type ActionJobPayload
} from '../../workers/action.worker.js';
import type { RecoveryCase } from '../../modules/recovery/case.types.js';
import type { Transaction } from '../../modules/payment/payment.types.js';
import type { Policy } from '../../modules/policy/policy.types.js';

vi.mock('../../infrastructure/redis.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  redis: {},
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn()
}));

vi.mock('../../infrastructure/rabbitmq.js', () => ({
  getRabbitMQChannel: vi.fn(),
  publishDelayedRetry: vi.fn(),
  QUEUES: {
    PAYMENT_PROCESSING: 'payment_processing_queue',
    PAYMENT_DLQ: 'payment_dlq',
    WEBHOOK_DELIVERY: 'webhook_queue',
    RECOVERY_INGESTION: 'recovery_ingestion_queue',
    RETRY_DELAY_HOLDING: 'retry_delay_holding_queue'
  },
  EXCHANGES: {
    PAYMENT: 'payment_exchange',
    DLX: 'dlx_exchange',
    WEBHOOK: 'webhook_exchange',
    RETRY_DELAY: 'retry_delay_exchange'
  },
  MIN_RETRY_DELAY_MS: 60000,
  MAX_RETRY_DELAY_MS: 1209600000
}));

vi.mock('../../modules/payment/payment.repository.js', () => ({
  findTransactionById: vi.fn(),
  updateTransactionStatus: vi.fn(),
  updateOrderStatus: vi.fn()
}));

vi.mock('../../modules/policy/policy.repository.js', () => ({
  findActivePolicyByMerchantId: vi.fn()
}));

vi.mock('../../modules/recovery/case.repository.js', () => ({
  findCaseById: vi.fn(),
  findCaseEventsByCaseId: vi.fn()
}));

vi.mock('../../modules/recovery/case.service.js', () => ({
  transitionCase: vi.fn()
}));

describe('TASK-402: Action Handler Workers (RCV-010 / RTY-003 / POL-001 / Invariants I1, I2, I3, I5)', () => {
  let mockChannel: ActionChannel;

  const mockCase: RecoveryCase = {
    id: 202,
    merchantId: 1,
    caseRef: '01M0AJX6JAD1K8PX8AXXXWJDHS',
    orderId: 101,
    transactionId: 501,
    status: 'scheduled' as unknown as RecoveryCase['status'],
    recoverableAmount: 15000,
    currency: 'INR',
    originatingSignal: 'PAYMENT_FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    correlationId: '01M0AJX6N6SPVYPE0T9EHPGD5F',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockTransaction: Transaction = {
    id: 501,
    orderId: 101,
    txnRef: '01M0AJX6N6SPVYPE0T9EHPGD5F',
    paymentMethod: 'card',
    status: 'processing',
    gatewayResponse: null,
    failureReason: null,
    amount: 15000,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockPolicy: Policy = {
    id: 1,
    merchantId: 1,
    version: 1,
    isActive: true,
    autonomyTier: 'T3',
    maxRetries: 3,
    maxContactsPerCustomerPerWeek: 3,
    dailyBudgetMinorUnits: 500000,
    maxIncentivePercent: 10,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    timezone: 'UTC',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const validActionPayload: ActionJobPayload = {
    merchantId: 1,
    caseId: 202,
    orderId: 101,
    transactionId: 501,
    orderRef: 'ORD_01M0AJX6JAD1K8PX',
    txnRef: '01M0AJX6N6SPVYPE0T9EHPGD5F',
    amountMinorUnits: 15000,
    currency: 'INR',
    retryAttempt: 1,
    actionType: 'RETRY_PAYMENT',
    policyEvaluationRef: 'EVAL_01M0AJX6N6SPVYPE',
    correlationId: '01M0AJX6N6SPVYPE0T9EHPGD5F'
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockChannel = {
      ack: vi.fn(),
      nack: vi.fn()
    };

    vi.mocked(caseRepo.findCaseById).mockResolvedValue(mockCase);
    vi.mocked(caseRepo.findCaseEventsByCaseId).mockResolvedValue([]);
    vi.mocked(paymentRepo.findTransactionById).mockResolvedValue(mockTransaction);
    vi.mocked(policyRepo.findActivePolicyByMerchantId).mockResolvedValue(mockPolicy);
    vi.mocked(redisInfra.acquireLock).mockResolvedValue('owner_token_123');
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    vi.mocked(caseService.transitionCase).mockResolvedValue(mockCase);
  });

  const createAmqpMessage = (payload: unknown): amqp.ConsumeMessage =>
    ({
      content: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      fields: {
        deliveryTag: 1,
        redelivered: false,
        exchange: 'payment_exchange',
        routingKey: 'payment.process',
        consumerTag: 'test-ctag'
      },
      properties: {
        correlationId: '01M0AJX6N6SPVYPE0T9EHPGD5F',
        headers: {
          'x-correlation-id': '01M0AJX6N6SPVYPE0T9EHPGD5F',
          'x-trace-id': '01M0AJX6N6SPVYPE0T9EHPGD5F'
        }
      }
    }) as unknown as amqp.ConsumeMessage;

  /* ------------------------------------------------------------------ */
  /*  1. Successful Action Execution (AT-E2E-001 / RCV-010)             */
  /* ------------------------------------------------------------------ */

  describe('1. Successful Action Execution', () => {
    it('executes gateway charge, updates transaction and case to recovered', async () => {
      const mockGateway = vi.fn().mockResolvedValue({
        success: true,
        gatewayResponse: { authCode: 'AUTH123456', provider: 'test-gateway' }
      });

      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      // Verify distributed lock acquired and released
      expect(redisInfra.acquireLock).toHaveBeenCalledWith(
        'lock:worker:action:202',
        30,
        expect.any(String)
      );
      expect(redisInfra.releaseLock).toHaveBeenCalledWith(
        'lock:worker:action:202',
        expect.any(String)
      );

      // Verify stable provider idempotency reference supplied
      expect(mockGateway).toHaveBeenCalledWith(
        'card',
        '01M0AJX6N6SPVYPE0T9EHPGD5F_att1'
      );

      // Verify transaction updated to success and order to paid
      expect(paymentRepo.updateTransactionStatus).toHaveBeenCalledWith(
        501,
        1,
        'success',
        expect.objectContaining({ authCode: 'AUTH123456' })
      );
      expect(paymentRepo.updateOrderStatus).toHaveBeenCalledWith(101, 1, 'success');

      // Verify case state transition to recovered
      expect(caseService.transitionCase).toHaveBeenCalledWith(
        202,
        1,
        'recovered',
        { type: 'system', id: 'action_worker' },
        expect.any(String),
        expect.objectContaining({
          idempotencyKey: 'idem:202:RETRY_PAYMENT:1',
          policyEvaluationRef: 'EVAL_01M0AJX6N6SPVYPE',
          retryAttempt: 1,
          amountRecovered: 15000
        }),
        '01M0AJX6N6SPVYPE0T9EHPGD5F'
      );

      // Verify message ACKed
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Retryable Soft Decline & Delayed Retry Scheduling (RTY-003)    */
  /* ------------------------------------------------------------------ */

  describe('2. Retryable Soft Decline & Delayed Retries', () => {
    it('schedules next delayed retry via publishDelayedRetry on soft decline', async () => {
      const mockGateway = vi.fn().mockResolvedValue({
        success: false,
        failureReason: 'Insufficient funds on card',
        failureCategory: 'INSUFFICIENT_FUNDS',
        gatewayResponse: { errorCode: '51' }
      });

      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      // Verify next retry scheduled via TASK-401 delayed retry publisher
      expect(rabbitmqInfra.publishDelayedRetry).toHaveBeenCalledWith({
        payload: expect.objectContaining({
          caseId: 202,
          merchantId: 1,
          retryAttempt: 2,
          actionType: 'RETRY_PAYMENT',
          policyEvaluationRef: 'EVAL_01M0AJX6N6SPVYPE'
        }),
        delayMs: expect.any(Number)
      });

      // Verify case transitioned to awaiting_outcome with next attempt info
      expect(caseService.transitionCase).toHaveBeenCalledWith(
        202,
        1,
        'awaiting_outcome',
        { type: 'system', id: 'action_worker' },
        expect.stringContaining('Next retry scheduled'),
        expect.objectContaining({
          nextRetryAttempt: 2
        }),
        '01M0AJX6N6SPVYPE0T9EHPGD5F'
      );

      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Hard Decline & Exhausted Retries                               */
  /* ------------------------------------------------------------------ */

  describe('3. Hard Decline & Retry Limit Exhaustion', () => {
    it('transitions case to unrecovered on hard decline without scheduling retry', async () => {
      const mockGateway = vi.fn().mockResolvedValue({
        success: false,
        failureReason: 'Card reported stolen',
        failureCategory: 'ISSUER_HARD_DECLINE',
        gatewayResponse: { errorCode: '43' }
      });

      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(rabbitmqInfra.publishDelayedRetry).not.toHaveBeenCalled();
      expect(paymentRepo.updateTransactionStatus).toHaveBeenCalledWith(
        501,
        1,
        'failed',
        expect.any(Object),
        'Card reported stolen'
      );
      expect(caseService.transitionCase).toHaveBeenCalledWith(
        202,
        1,
        'unrecovered',
        { type: 'system', id: 'action_worker' },
        expect.stringContaining('Recovery failed'),
        expect.any(Object),
        '01M0AJX6N6SPVYPE0T9EHPGD5F'
      );
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it('transitions case to unrecovered when maxRetries is reached', async () => {
      const exhaustedPayload: ActionJobPayload = {
        ...validActionPayload,
        retryAttempt: 3 // Max is 3
      };

      const mockGateway = vi.fn().mockResolvedValue({
        success: false,
        failureReason: 'Temporary network timeout',
        failureCategory: 'TECHNICAL_TRANSIENT',
        gatewayResponse: { errorCode: 'TIMEOUT' }
      });

      const msg = createAmqpMessage(exhaustedPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(rabbitmqInfra.publishDelayedRetry).not.toHaveBeenCalled();
      expect(caseService.transitionCase).toHaveBeenCalledWith(
        202,
        1,
        'unrecovered',
        { type: 'system', id: 'action_worker' },
        expect.stringContaining('Recovery failed'),
        expect.any(Object),
        '01M0AJX6N6SPVYPE0T9EHPGD5F'
      );
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. Payload Validation & Malformed Messages (DLQ Routing)          */
  /* ------------------------------------------------------------------ */

  describe('4. Payload Validation & DLQ Routing (AT-INT-001)', () => {
    it('routes malformed JSON to DLQ without executing gateway side effects', async () => {
      const mockGateway = vi.fn();
      const msg = createAmqpMessage('invalid-json-string');

      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockGateway).not.toHaveBeenCalled();
    });

    it('routes payload missing required fields to DLQ', async () => {
      const mockGateway = vi.fn();
      const msg = createAmqpMessage({
        merchantId: 1,
        // missing caseId, policyEvaluationRef, correlationId
        amountMinorUnits: 500
      });

      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockGateway).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. Tenant Isolation & Cross-Tenant Safety (Invariant I5)          */
  /* ------------------------------------------------------------------ */

  describe('5. Tenant Isolation', () => {
    it('routes to DLQ when case does not belong to specified merchant', async () => {
      vi.mocked(caseRepo.findCaseById).mockResolvedValue(null);
      const mockGateway = vi.fn();

      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(caseRepo.findCaseById).toHaveBeenCalledWith(202, 1);
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockGateway).not.toHaveBeenCalled();
    });

    it('routes to DLQ when transaction does not belong to merchant', async () => {
      vi.mocked(paymentRepo.findTransactionById).mockResolvedValue(null);
      const mockGateway = vi.fn();

      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(paymentRepo.findTransactionById).toHaveBeenCalledWith(501, 1);
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
      expect(mockGateway).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  6. Policy Re-Validation & Inactive Policy Safeguards (RCV-003)    */
  /* ------------------------------------------------------------------ */

  describe('6. Policy Re-Validation & Gating', () => {
    it('cancels action execution if merchant policy was disabled after scheduling', async () => {
      vi.mocked(policyRepo.findActivePolicyByMerchantId).mockResolvedValue({
        ...mockPolicy,
        isActive: false
      });

      const mockGateway = vi.fn();
      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(mockGateway).not.toHaveBeenCalled();
      expect(caseService.transitionCase).toHaveBeenCalledWith(
        202,
        1,
        'unrecovered',
        { type: 'system', id: 'action_worker' },
        expect.stringContaining('Merchant policy inactive or disabled'),
        expect.any(Object),
        '01M0AJX6N6SPVYPE0T9EHPGD5F'
      );
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it('marks case unrecovered if incoming retry attempt exceeds active policy maxRetries', async () => {
      vi.mocked(policyRepo.findActivePolicyByMerchantId).mockResolvedValue({
        ...mockPolicy,
        maxRetries: 2
      });

      const mockGateway = vi.fn();
      const msg = createAmqpMessage({
        ...validActionPayload,
        retryAttempt: 3
      });

      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(mockGateway).not.toHaveBeenCalled();
      expect(caseService.transitionCase).toHaveBeenCalledWith(
        202,
        1,
        'unrecovered',
        { type: 'system', id: 'action_worker' },
        expect.stringContaining('Max retries (2) exceeded'),
        expect.any(Object),
        '01M0AJX6N6SPVYPE0T9EHPGD5F'
      );
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  7. Deterministic Idempotency & Duplicate Delivery (RCV-010 / I3)  */
  /* ------------------------------------------------------------------ */

  describe('7. Deterministic Action Idempotency', () => {
    it('suppresses duplicate execution when action event already exists in event store', async () => {
      vi.mocked(caseRepo.findCaseEventsByCaseId).mockResolvedValue([
        {
          id: 1,
          caseId: 202,
          merchantId: 1,
          fromStatus: 'executing' as unknown as RecoveryCase['status'],
          toStatus: 'recovered' as unknown as RecoveryCase['status'],
          actorType: 'system',
          actorId: 'action_worker',
          reason: 'Payment recovered',
          payload: { idempotencyKey: 'idem:202:RETRY_PAYMENT:1' },
          correlationId: '01M0AJX6N6SPVYPE0T9EHPGD5F',
          createdAt: new Date()
        }
      ]);

      const mockGateway = vi.fn();
      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      // Exactly zero gateway invocations on duplicate delivery
      expect(mockGateway).not.toHaveBeenCalled();
      expect(redisInfra.acquireLock).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it('safely acknowledges terminal case without invoking payment gateway', async () => {
      vi.mocked(caseRepo.findCaseById).mockResolvedValue({
        ...mockCase,
        status: 'recovered' as unknown as RecoveryCase['status']
      });

      const mockGateway = vi.fn();
      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(mockGateway).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it('acknowledges message and transitions case when transaction is already successful', async () => {
      vi.mocked(paymentRepo.findTransactionById).mockResolvedValue({
        ...mockTransaction,
        status: 'success'
      });

      const mockGateway = vi.fn();
      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(mockGateway).not.toHaveBeenCalled();
      expect(caseService.transitionCase).toHaveBeenCalledWith(
        202,
        1,
        'recovered',
        { type: 'system', id: 'action_worker' },
        expect.stringContaining('Transaction already succeeded'),
        expect.any(Object),
        '01M0AJX6N6SPVYPE0T9EHPGD5F'
      );
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  8. Distributed Lock Contention (Invariant I1)                     */
  /* ------------------------------------------------------------------ */

  describe('8. Distributed Lock Contention', () => {
    it('requeues message without side effects when Redis lock cannot be acquired', async () => {
      vi.mocked(redisInfra.acquireLock).mockResolvedValue(null);
      const mockGateway = vi.fn();

      const msg = createAmqpMessage(validActionPayload);
      await handleActionMessage(mockChannel, msg, mockGateway);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, true); // Requeue
      expect(mockGateway).not.toHaveBeenCalled();
      expect(redisInfra.releaseLock).not.toHaveBeenCalled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  9. Worker Lifecycle & Shutdown Integration                        */
  /* ------------------------------------------------------------------ */

  describe('9. Worker Lifecycle & Shutdown Integration', () => {
    it('starts worker with prefetch(1) and cancels consumer on stop', async () => {
      const mockAmqpChannel = {
        prefetch: vi.fn().mockResolvedValue(undefined),
        consume: vi.fn().mockResolvedValue({ consumerTag: 'amq.ctag-action-worker-1' }),
        cancel: vi.fn().mockResolvedValue(undefined)
      } as unknown as amqp.Channel;

      const worker = await startActionWorker(mockAmqpChannel);

      expect(mockAmqpChannel.prefetch).toHaveBeenCalledWith(1);
      expect(mockAmqpChannel.consume).toHaveBeenCalledWith(
        'payment_processing_queue',
        expect.any(Function),
        { noAck: false }
      );
      expect(worker.consumerTag).toBe('amq.ctag-action-worker-1');

      await worker.stop();
      expect(mockAmqpChannel.cancel).toHaveBeenCalledWith('amq.ctag-action-worker-1');
    });
  });
});
