import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpError } from '../../../utils/http-error.js';
import * as redisInfra from '../../../infrastructure/redis.js';
import * as rabbitmqInfra from '../../../infrastructure/rabbitmq.js';
import * as paymentRepo from '../../../modules/payment/payment.repository.js';
import * as idempotencyRepo from '../../../modules/idempotency/idempotency.repository.js';
import {
  createCheckoutOrder,
  processPayment
} from '../../../modules/payment/payment.service.js';
import type { Order, Transaction } from '../../../modules/payment/payment.types.js';
import type { IdempotencyRecord } from '../../../modules/idempotency/idempotency.types.js';

// Mock dependencies
vi.mock('../../../infrastructure/redis.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  redis: {},
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn()
}));

vi.mock('../../../infrastructure/rabbitmq.js', () => ({
  getRabbitMQChannel: vi.fn(),
  EXCHANGES: {
    PAYMENT: 'payment_exchange',
    DLX: 'dlx_exchange',
    WEBHOOK: 'webhook_exchange'
  }
}));

vi.mock('../../../modules/payment/payment.repository.js', () => ({
  createOrder: vi.fn(),
  findOrderByRef: vi.fn(),
  createTransaction: vi.fn(),
  updateTransactionStatus: vi.fn(),
  updateOrderStatus: vi.fn(),
  findOrdersByMerchantId: vi.fn(),
  findTransactionsByOrderId: vi.fn(),
  getOrderCountsByMerchant: vi.fn()
}));

describe('Payment & Order Idempotency Integration', () => {
  // In-memory mock database table for idempotency_keys
  let inMemoryIdempotencyStore: Map<string, IdempotencyRecord>;

  const mockOrder: Order = {
    id: 101,
    merchantId: 1,
    orderRef: 'ord_idem_test_001',
    amount: 2500,
    currency: 'INR',
    description: 'Idempotent Order',
    status: 'pending',
    customerEmail: 'test@merchant.com',
    metadata: { plan: 'pro' },
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockTransaction: Transaction = {
    id: 303,
    orderId: 101,
    txnRef: 'txn_idem_test_001',
    paymentMethod: 'card',
    status: 'initiated',
    gatewayResponse: null,
    failureReason: null,
    amount: 2500,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockRabbitChannel = {
    publish: vi.fn().mockReturnValue(true)
  };

  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryIdempotencyStore = new Map();

    // Wire up idempotency repository to simulate real MySQL unique constraint on (merchant_id, idempotency_key)
    vi.spyOn(idempotencyRepo, 'insertIdempotencyKey').mockImplementation(async (input) => {
      const storeKey = `${input.merchantId}:${input.idempotencyKey}`;
      if (inMemoryIdempotencyStore.has(storeKey)) {
        const err = new Error(`Duplicate entry '${storeKey}' for key 'uq_idempotency_merchant_key'`);
        (err as unknown as { code: string; errno: number }).code = 'ER_DUP_ENTRY';
        (err as unknown as { code: string; errno: number }).errno = 1062;
        throw err;
      }
      const record: IdempotencyRecord = {
        id: inMemoryIdempotencyStore.size + 1,
        merchantId: input.merchantId,
        idempotencyKey: input.idempotencyKey,
        requestPath: input.requestPath,
        requestHash: input.requestHash,
        responseStatus: null,
        responseBody: null,
        status: 'processing',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      inMemoryIdempotencyStore.set(storeKey, record);
      return true;
    });

    vi.spyOn(idempotencyRepo, 'findIdempotencyKey').mockImplementation(async (merchantId, key) => {
      const storeKey = `${merchantId}:${key}`;
      return inMemoryIdempotencyStore.get(storeKey) ?? null;
    });

    vi.spyOn(idempotencyRepo, 'updateIdempotencyKey').mockImplementation(
      async (merchantId, key, status, responseStatus, responseBody) => {
        const storeKey = `${merchantId}:${key}`;
        const existing = inMemoryIdempotencyStore.get(storeKey);
        if (existing) {
          existing.status = status;
          existing.responseStatus = responseStatus ?? null;
          existing.responseBody = responseBody ?? null;
          existing.updatedAt = new Date();
        }
      }
    );

    vi.spyOn(idempotencyRepo, 'reclaimFailedIdempotencyKey').mockImplementation(
      async (merchantId, key, requestPath, requestHash) => {
        const storeKey = `${merchantId}:${key}`;
        const existing = inMemoryIdempotencyStore.get(storeKey);
        if (existing && existing.status === 'failed') {
          existing.status = 'processing';
          existing.requestPath = requestPath;
          existing.requestHash = requestHash;
          existing.responseStatus = null;
          existing.responseBody = null;
          existing.updatedAt = new Date();
          return true;
        }
        return false;
      }
    );

    // Wire up payment repository mocks
    vi.mocked(paymentRepo.createOrder).mockResolvedValue({ ...mockOrder });
    vi.mocked(paymentRepo.findOrderByRef).mockResolvedValue({ ...mockOrder });
    vi.mocked(paymentRepo.createTransaction).mockResolvedValue({ ...mockTransaction });
    vi.mocked(paymentRepo.updateTransactionStatus).mockResolvedValue(true);
    vi.mocked(paymentRepo.updateOrderStatus).mockResolvedValue(true);

    // Wire up Redis and RabbitMQ mocks
    vi.mocked(redisInfra.acquireLock).mockResolvedValue('test-owner-token');
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    vi.mocked(rabbitmqInfra.getRabbitMQChannel).mockResolvedValue(
      mockRabbitChannel as unknown as ReturnType<typeof rabbitmqInfra.getRabbitMQChannel> extends Promise<infer U> ? U : never
    );
  });

  describe('Order Creation Idempotency (createCheckoutOrder)', () => {
    const createOrderInput = {
      amount: 2500,
      currency: 'INR',
      description: 'Idempotent Order',
      customerEmail: 'test@merchant.com',
      metadata: { plan: 'pro' }
    };

    it('creates order on first attempt and saves idempotency record', async () => {
      const order = await createCheckoutOrder(1, createOrderInput, 'idemp_order_1');

      expect(order).toMatchObject({
        id: 101,
        merchantId: 1,
        amount: 2500,
        currency: 'INR'
      });
      expect(paymentRepo.createOrder).toHaveBeenCalledTimes(1);

      // Verify idempotency record in store is marked 'completed'
      const record = inMemoryIdempotencyStore.get('1:idemp_order_1');
      expect(record).toBeDefined();
      expect(record?.status).toBe('completed');
      expect(record?.responseStatus).toBe(201);
      expect(record?.responseBody).toMatchObject({ id: 101, amount: 2500 });
    });

    it('repeating same request with same key returns existing order without creating new order in DB', async () => {
      // First request
      const firstOrder = await createCheckoutOrder(1, createOrderInput, 'idemp_order_repeat');
      expect(paymentRepo.createOrder).toHaveBeenCalledTimes(1);

      // Second identical request
      const secondOrder = await createCheckoutOrder(1, createOrderInput, 'idemp_order_repeat');

      // Side-effect verification: createOrder must NOT be called again
      expect(paymentRepo.createOrder).toHaveBeenCalledTimes(1);
      expect(secondOrder).toEqual(firstOrder);
    });

    it('concurrent duplicate requests cannot both create orders (one succeeds, one gets 409 in-progress)', async () => {
      // Simulate artificial delay in createOrder to create overlap window
      vi.mocked(paymentRepo.createOrder).mockImplementation(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          ...mockOrder,
          ...input,
          id: 505
        };
      });

      const req1 = createCheckoutOrder(1, createOrderInput, 'idemp_order_concurrent');
      const req2 = createCheckoutOrder(1, createOrderInput, 'idemp_order_concurrent');

      const results = await Promise.allSettled([req1, req2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly 1 creates order, 1 rejected with 409
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(HttpError);
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('IDEMPOTENCY_IN_PROGRESS');

      // Side-effect count: exactly 1 order created in DB
      expect(paymentRepo.createOrder).toHaveBeenCalledTimes(1);
    });

    it('rejects with 409 IDEMPOTENCY_KEY_MISMATCH when same key is reused with different amount', async () => {
      // First request with amount 2500
      await createCheckoutOrder(1, createOrderInput, 'idemp_order_conflict');
      expect(paymentRepo.createOrder).toHaveBeenCalledTimes(1);

      // Second request with conflicting amount 9999
      const conflictingInput = { ...createOrderInput, amount: 9999 };

      await expect(
        createCheckoutOrder(1, conflictingInput, 'idemp_order_conflict')
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_MISMATCH'
      });

      // Still only 1 order created
      expect(paymentRepo.createOrder).toHaveBeenCalledTimes(1);
    });

    it('allows different merchants to use the same idempotency key without collision', async () => {
      const order1 = await createCheckoutOrder(1, createOrderInput, 'shared_key_123');
      const order2 = await createCheckoutOrder(2, createOrderInput, 'shared_key_123');

      expect(order1).toBeDefined();
      expect(order2).toBeDefined();
      expect(paymentRepo.createOrder).toHaveBeenCalledTimes(2);

      // Two distinct records in store
      expect(inMemoryIdempotencyStore.has('1:shared_key_123')).toBe(true);
      expect(inMemoryIdempotencyStore.has('2:shared_key_123')).toBe(true);
    });

    it('recovers from failed request: failed attempt marks key as failed and retry creates order', async () => {
      // First attempt fails due to DB error
      vi.mocked(paymentRepo.createOrder).mockRejectedValueOnce(new Error('DB Timeout'));

      await expect(
        createCheckoutOrder(1, createOrderInput, 'idemp_order_fail_recovery')
      ).rejects.toThrow('DB Timeout');

      // Record is marked 'failed'
      const record = inMemoryIdempotencyStore.get('1:idemp_order_fail_recovery');
      expect(record?.status).toBe('failed');

      // Second attempt succeeds and re-claims key
      const recoveredOrder = await createCheckoutOrder(1, createOrderInput, 'idemp_order_fail_recovery');
      expect(recoveredOrder).toBeDefined();
      expect(record?.status).toBe('completed');
    });
  });

  describe('Payment Processing Idempotency (processPayment)', () => {
    const paymentInput = { paymentMethod: 'card' as const };

    it('processes payment on first attempt with idempotency key, acquires lock, and marks completed', async () => {
      const result = await processPayment('ord_idem_test_001', 1, paymentInput, 'idemp_pay_1');

      expect(result).toMatchObject({
        orderRef: 'ord_idem_test_001',
        status: 'processing',
        paymentMethod: 'card'
      });

      // Verify ordering: Redis lock acquired & released
      expect(redisInfra.acquireLock).toHaveBeenCalledWith('lock:order:ord_idem_test_001', 10);
      expect(redisInfra.releaseLock).toHaveBeenCalledWith('lock:order:ord_idem_test_001', 'test-owner-token');
      expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(1);
      expect(mockRabbitChannel.publish).toHaveBeenCalledTimes(1);

      // Verify idempotency record
      const record = inMemoryIdempotencyStore.get('1:idemp_pay_1');
      expect(record?.status).toBe('completed');
      expect(record?.responseStatus).toBe(202);
    });

    it('repeating payment request with same key returns existing 202 response without re-processing or re-publishing', async () => {
      // First payment
      const firstResult = await processPayment('ord_idem_test_001', 1, paymentInput, 'idemp_pay_repeat');
      expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(1);
      expect(mockRabbitChannel.publish).toHaveBeenCalledTimes(1);
      expect(redisInfra.acquireLock).toHaveBeenCalledTimes(1);

      // Second payment with same key
      const secondResult = await processPayment('ord_idem_test_001', 1, paymentInput, 'idemp_pay_repeat');

      // Must return identical cached result
      expect(secondResult).toEqual(firstResult);

      // Side-effect assertion: Transaction creation and RabbitMQ publish must NOT happen again!
      expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(1);
      expect(mockRabbitChannel.publish).toHaveBeenCalledTimes(1);
      // Redis lock was NOT acquired on idempotent cache hit
      expect(redisInfra.acquireLock).toHaveBeenCalledTimes(1);
    });

    it('rejects with 409 IDEMPOTENCY_KEY_MISMATCH when same key is used with different payment method', async () => {
      await processPayment('ord_idem_test_001', 1, { paymentMethod: 'card' }, 'idemp_pay_mismatch');

      await expect(
        processPayment('ord_idem_test_001', 1, { paymentMethod: 'upi' }, 'idemp_pay_mismatch')
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_MISMATCH'
      });

      expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(1);
    });

    it('concurrent payment requests with the same key cannot double-process', async () => {
      vi.mocked(paymentRepo.createTransaction).mockImplementation(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ...mockTransaction, ...input, id: 707 };
      });

      const req1 = processPayment('ord_idem_test_001', 1, paymentInput, 'idemp_pay_concurrent');
      const req2 = processPayment('ord_idem_test_001', 1, paymentInput, 'idemp_pay_concurrent');

      const results = await Promise.allSettled([req1, req2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('IDEMPOTENCY_IN_PROGRESS');

      // Side effects: transaction and queue message produced exactly once
      expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(1);
      expect(mockRabbitChannel.publish).toHaveBeenCalledTimes(1);
    });
  });
});
