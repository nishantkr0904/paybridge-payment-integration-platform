import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpError } from '../../../utils/http-error.js';
import * as redisInfra from '../../../infrastructure/redis.js';
import * as rabbitmqInfra from '../../../infrastructure/rabbitmq.js';
import * as paymentRepo from '../../../modules/payment/payment.repository.js';
import { processPayment } from '../../../modules/payment/payment.service.js';
import type { Order, Transaction } from '../../../modules/payment/payment.types.js';

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
  findOrderByRef: vi.fn(),
  createTransaction: vi.fn(),
  updateTransactionStatus: vi.fn(),
  updateOrderStatus: vi.fn(),
  createOrder: vi.fn(),
  findOrdersByMerchantId: vi.fn(),
  findTransactionsByOrderId: vi.fn(),
  getOrderCountsByMerchant: vi.fn()
}));

describe('Payment Service Lock Integration (payment.service.ts)', () => {
  const mockOrder: Order = {
    id: 101,
    merchantId: 1,
    orderRef: 'ord_test_123',
    amount: 5000,
    currency: 'INR',
    description: 'Test Order',
    status: 'pending',
    customerEmail: 'customer@example.com',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockTransaction: Transaction = {
    id: 202,
    orderId: 101,
    txnRef: 'txn_test_456',
    paymentMethod: 'card',
    status: 'initiated',
    gatewayResponse: null,
    failureReason: null,
    amount: 5000,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const mockRabbitChannel = {
    publish: vi.fn().mockReturnValue(true)
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(paymentRepo.findOrderByRef).mockResolvedValue({ ...mockOrder });
    vi.mocked(paymentRepo.createTransaction).mockResolvedValue({ ...mockTransaction });
    vi.mocked(paymentRepo.updateTransactionStatus).mockResolvedValue();
    vi.mocked(paymentRepo.updateOrderStatus).mockResolvedValue();
    vi.mocked(rabbitmqInfra.getRabbitMQChannel).mockResolvedValue(mockRabbitChannel as unknown as ReturnType<typeof rabbitmqInfra.getRabbitMQChannel> extends Promise<infer U> ? U : never);
  });

  it('allows protected operation to execute when lock is acquired and releases lock afterwards', async () => {
    const lockToken = 'owner-token-abc-123';
    vi.mocked(redisInfra.acquireLock).mockResolvedValue(lockToken);
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);

    const result = await processPayment('ord_test_123', 1, { paymentMethod: 'card' });

    // Verify lock acquisition with deterministic key and 10s TTL
    expect(redisInfra.acquireLock).toHaveBeenCalledTimes(1);
    expect(redisInfra.acquireLock).toHaveBeenCalledWith('lock:order:ord_test_123', 10);

    // Verify critical section executed
    expect(paymentRepo.findOrderByRef).toHaveBeenCalledWith('ord_test_123');
    expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(1);
    expect(paymentRepo.updateTransactionStatus).toHaveBeenCalledWith(202, 'processing');
    expect(paymentRepo.updateOrderStatus).toHaveBeenCalledWith(101, 'processing');
    expect(mockRabbitChannel.publish).toHaveBeenCalledTimes(1);

    // Verify expected return contract
    expect(result).toMatchObject({
      orderRef: 'ord_test_123',
      status: 'processing',
      paymentMethod: 'card',
      amount: 5000,
      currency: 'INR'
    });

    // Verify lock release in finally block with matching token
    expect(redisInfra.releaseLock).toHaveBeenCalledTimes(1);
    expect(redisInfra.releaseLock).toHaveBeenCalledWith('lock:order:ord_test_123', lockToken);
  });

  it('prevents protected operation from executing when lock acquisition fails (returns 429 and does not release lock)', async () => {
    // Simulate lock held by another process
    vi.mocked(redisInfra.acquireLock).mockResolvedValue(null);

    await expect(
      processPayment('ord_test_123', 1, { paymentMethod: 'card' })
    ).rejects.toThrow(HttpError);

    await expect(
      processPayment('ord_test_123', 1, { paymentMethod: 'card' })
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'ORDER_PROCESSING'
    });

    // Verify critical section was NOT entered
    expect(paymentRepo.findOrderByRef).not.toHaveBeenCalled();
    expect(paymentRepo.createTransaction).not.toHaveBeenCalled();
    expect(mockRabbitChannel.publish).not.toHaveBeenCalled();

    // Verify releaseLock was NOT called since lock was not acquired
    expect(redisInfra.releaseLock).not.toHaveBeenCalled();
  });

  it('releases lock when protected operation throws an error (e.g. database error)', async () => {
    const lockToken = 'owner-token-err-1';
    vi.mocked(redisInfra.acquireLock).mockResolvedValue(lockToken);
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    vi.mocked(paymentRepo.createTransaction).mockRejectedValue(new Error('DB Connection Lost'));

    await expect(
      processPayment('ord_test_123', 1, { paymentMethod: 'card' })
    ).rejects.toThrow('DB Connection Lost');

    // Verify lock was acquired and then released in finally
    expect(redisInfra.acquireLock).toHaveBeenCalledWith('lock:order:ord_test_123', 10);
    expect(redisInfra.releaseLock).toHaveBeenCalledWith('lock:order:ord_test_123', lockToken);
  });

  it('releases lock when order validation fails (e.g. order not found 404)', async () => {
    const lockToken = 'owner-token-404';
    vi.mocked(redisInfra.acquireLock).mockResolvedValue(lockToken);
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    vi.mocked(paymentRepo.findOrderByRef).mockResolvedValue(null);

    await expect(
      processPayment('ord_not_found', 1, { paymentMethod: 'card' })
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND'
    });

    expect(redisInfra.releaseLock).toHaveBeenCalledWith('lock:order:ord_not_found', lockToken);
  });

  it('releases lock when order already paid (409 ORDER_ALREADY_PAID)', async () => {
    const lockToken = 'owner-token-409';
    vi.mocked(redisInfra.acquireLock).mockResolvedValue(lockToken);
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    vi.mocked(paymentRepo.findOrderByRef).mockResolvedValue({
      ...mockOrder,
      status: 'success'
    });

    await expect(
      processPayment('ord_test_123', 1, { paymentMethod: 'card' })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_ALREADY_PAID'
    });

    expect(redisInfra.releaseLock).toHaveBeenCalledWith('lock:order:ord_test_123', lockToken);
  });

  it('releases lock when order already processing (409 ORDER_PROCESSING)', async () => {
    const lockToken = 'owner-token-proc';
    vi.mocked(redisInfra.acquireLock).mockResolvedValue(lockToken);
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    vi.mocked(paymentRepo.findOrderByRef).mockResolvedValue({
      ...mockOrder,
      status: 'processing'
    });

    await expect(
      processPayment('ord_test_123', 1, { paymentMethod: 'card' })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_PROCESSING'
    });

    expect(redisInfra.releaseLock).toHaveBeenCalledWith('lock:order:ord_test_123', lockToken);
  });

  it('releases lock when RabbitMQ channel publish throws', async () => {
    const lockToken = 'owner-token-rmq-err';
    vi.mocked(redisInfra.acquireLock).mockResolvedValue(lockToken);
    vi.mocked(redisInfra.releaseLock).mockResolvedValue(true);
    mockRabbitChannel.publish.mockImplementationOnce(() => {
      throw new Error('RabbitMQ channel closed');
    });

    await expect(
      processPayment('ord_test_123', 1, { paymentMethod: 'card' })
    ).rejects.toThrow('RabbitMQ channel closed');

    expect(redisInfra.releaseLock).toHaveBeenCalledWith('lock:order:ord_test_123', lockToken);
  });

  describe('Concurrency & Isolation Behavior (In-Memory Fake Lock Manager)', () => {
    it('prevents concurrent requests using the same logical key from both entering critical section', async () => {
      // In-memory fake lock storage
      const activeLocks = new Map<string, string>();

      vi.mocked(redisInfra.acquireLock).mockImplementation(async (key: string, _ttl: number, customToken?: string) => {
        if (activeLocks.has(key)) {
          return null; // lock already held
        }
        const token = customToken || `token-${Math.random()}`;
        activeLocks.set(key, token);
        return token;
      });

      vi.mocked(redisInfra.releaseLock).mockImplementation(async (key: string, token: string) => {
        if (activeLocks.get(key) === token) {
          activeLocks.delete(key);
          return true;
        }
        return false;
      });

      // Simulate a small delay in createTransaction to test overlapping concurrent requests
      vi.mocked(paymentRepo.createTransaction).mockImplementation(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ...mockTransaction, ...input, id: 999 };
      });

      // Fire two concurrent requests for the exact same orderRef
      const req1 = processPayment('ord_concurrent_same', 1, { paymentMethod: 'card' });
      const req2 = processPayment('ord_concurrent_same', 1, { paymentMethod: 'upi' });

      const results = await Promise.allSettled([req1, req2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one request succeeded and one was rejected with 429
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedError).toBeInstanceOf(HttpError);
      expect(rejectedError.statusCode).toBe(429);
      expect(rejectedError.code).toBe('ORDER_PROCESSING');

      // Exactly one transaction created
      expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(1);

      // Lock is cleanly released at the end
      expect(activeLocks.has('lock:order:ord_concurrent_same')).toBe(false);
    });

    it('allows requests using different logical keys to proceed concurrently without unnecessary serialization', async () => {
      const activeLocks = new Map<string, string>();

      vi.mocked(redisInfra.acquireLock).mockImplementation(async (key: string, _ttl: number, customToken?: string) => {
        if (activeLocks.has(key)) {
          return null;
        }
        const token = customToken || `token-${Math.random()}`;
        activeLocks.set(key, token);
        return token;
      });

      vi.mocked(redisInfra.releaseLock).mockImplementation(async (key: string, token: string) => {
        if (activeLocks.get(key) === token) {
          activeLocks.delete(key);
          return true;
        }
        return false;
      });

      vi.mocked(paymentRepo.createTransaction).mockImplementation(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ...mockTransaction, ...input, id: Math.floor(Math.random() * 1000) };
      });

      // Fire concurrent requests for DIFFERENT orderRefs
      const reqA = processPayment('ord_key_A', 1, { paymentMethod: 'card' });
      const reqB = processPayment('ord_key_B', 1, { paymentMethod: 'upi' });
      const reqC = processPayment('ord_key_C', 1, { paymentMethod: 'netbanking' });

      const results = await Promise.allSettled([reqA, reqB, reqC]);

      // All 3 succeed concurrently without blocking each other
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(3);
      expect(paymentRepo.createTransaction).toHaveBeenCalledTimes(3);

      expect(activeLocks.size).toBe(0);
    });

    it('prevents an ownership mismatch from releasing another owner lock', async () => {
      const activeLocks = new Map<string, string>();

      vi.mocked(redisInfra.acquireLock).mockImplementation(async (key: string, _ttl: number, customToken?: string) => {
        if (activeLocks.has(key)) {
          return null;
        }
        const token = customToken || `token-${Math.random()}`;
        activeLocks.set(key, token);
        return token;
      });

      vi.mocked(redisInfra.releaseLock).mockImplementation(async (key: string, token: string) => {
        // Lua atomic compare-and-delete behavior
        if (activeLocks.get(key) === token) {
          activeLocks.delete(key);
          return true;
        }
        return false;
      });

      const lockKey = 'lock:order:ord_ownership_test';
      const originalToken = 'token-original-holder';
      const stolenToken = 'token-second-holder';

      // Simulate: original holder acquired lock
      activeLocks.set(lockKey, originalToken);

      // Simulate: lock expired and second holder acquired it
      activeLocks.set(lockKey, stolenToken);

      // Original holder attempts to release with old token
      const releaseResult = await redisInfra.releaseLock(lockKey, originalToken);

      // Release must fail (no-op)
      expect(releaseResult).toBe(false);

      // Lock is still held by second holder
      expect(activeLocks.get(lockKey)).toBe(stolenToken);

      // Second holder releases with correct token
      const validRelease = await redisInfra.releaseLock(lockKey, stolenToken);
      expect(validRelease).toBe(true);
      expect(activeLocks.has(lockKey)).toBe(false);
    });
  });
});
