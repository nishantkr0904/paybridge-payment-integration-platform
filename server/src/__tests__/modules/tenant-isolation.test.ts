import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type amqp from 'amqplib';
import { pool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import {
  createOrder,
  findOrderByRef,
  findOrderByRefPublic,
  findOrderById,
  updateOrderStatus,
  createTransaction,
  findTransactionById,
  findTransactionsByOrderId,
  updateTransactionStatus
} from '../../modules/payment/payment.repository.js';
import { getOrderStatus, processPayment } from '../../modules/payment/payment.service.js';
import { handlePaymentMessage, type PaymentChannel } from '../../workers/payment.worker.js';
import { HttpError } from '../../utils/http-error.js';
import { generateUlid } from '../../utils/ulid.js';

describe('TASK-103: Repository-Layer Tenant Scoping (SEC-002, AT-SEC-001, Invariant I9)', () => {
  let merchant1Id: number;
  let merchant2Id: number;

  beforeAll(async () => {
    await connectRedis();
    const conn = await pool.getConnection();
    try {
      const email1 = `tenant_m1_${Date.now()}@example.com`;
      const email2 = `tenant_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (res2 as unknown as { insertId: number }).insertId;
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    const conn = await pool.getConnection();
    try {
      if (merchant1Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant1Id]);
      if (merchant2Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant2Id]);
    } finally {
      conn.release();
    }
    await disconnectRedis();
  });

  describe('Order Repository Tenant Scoping', () => {
    it('enforces merchant_id in SQL when looking up orders by order_ref', async () => {
      const orderRef = generateUlid();
      const order1 = await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 2500,
        currency: 'INR',
        description: 'M1 Order'
      });

      // Same merchant lookup succeeds
      const foundOwn = await findOrderByRef(orderRef, merchant1Id);
      expect(foundOwn).not.toBeNull();
      expect(foundOwn?.id).toBe(order1.id);
      expect(foundOwn?.merchantId).toBe(merchant1Id);

      // Cross-merchant lookup returns NULL at SQL query boundary
      const foundOther = await findOrderByRef(orderRef, merchant2Id);
      expect(foundOther).toBeNull();

      // Public customer checkout lookup succeeds without merchant auth
      const foundPublic = await findOrderByRefPublic(orderRef);
      expect(foundPublic).not.toBeNull();
      expect(foundPublic?.id).toBe(order1.id);
    });

    it('enforces merchant_id in SQL when looking up orders by ID', async () => {
      const orderRef = generateUlid();
      const order = await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 3000,
        currency: 'INR'
      });

      const foundOwn = await findOrderById(order.id, merchant1Id);
      expect(foundOwn).not.toBeNull();
      expect(foundOwn?.id).toBe(order.id);

      const foundOther = await findOrderById(order.id, merchant2Id);
      expect(foundOther).toBeNull();
    });

    it('enforces merchant_id in SQL when updating order status', async () => {
      const orderRef = generateUlid();
      const order = await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 4000,
        currency: 'INR'
      });

      // Cross-merchant update affects 0 rows and returns false
      const otherUpdated = await updateOrderStatus(order.id, merchant2Id, 'failed');
      expect(otherUpdated).toBe(false);

      const unchanged = await findOrderById(order.id, merchant1Id);
      expect(unchanged?.status).toBe('pending');

      // Same-merchant update succeeds
      const ownUpdated = await updateOrderStatus(order.id, merchant1Id, 'processing');
      expect(ownUpdated).toBe(true);

      const updated = await findOrderById(order.id, merchant1Id);
      expect(updated?.status).toBe('processing');
    });
  });

  describe('Transaction Repository Tenant Scoping', () => {
    it('enforces tenant ownership via order JOIN when looking up transactions by ID', async () => {
      const orderRef = generateUlid();
      const order = await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 1500,
        currency: 'INR'
      });

      const txnRef = generateUlid();
      const txn = await createTransaction({
        orderId: order.id,
        txnRef,
        paymentMethod: 'card',
        amount: 1500
      });

      // Same merchant lookup succeeds
      const foundOwn = await findTransactionById(txn.id, merchant1Id);
      expect(foundOwn).not.toBeNull();
      expect(foundOwn?.id).toBe(txn.id);

      // Cross-merchant lookup returns NULL
      const foundOther = await findTransactionById(txn.id, merchant2Id);
      expect(foundOther).toBeNull();
    });

    it('enforces tenant ownership via order JOIN when listing transactions by orderId', async () => {
      const orderRef = generateUlid();
      const order = await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 1200,
        currency: 'INR'
      });

      const txnRef = generateUlid();
      await createTransaction({
        orderId: order.id,
        txnRef,
        paymentMethod: 'upi',
        amount: 1200
      });

      const listOwn = await findTransactionsByOrderId(order.id, merchant1Id);
      expect(listOwn.length).toBe(1);
      expect(listOwn[0].txnRef).toBe(txnRef);

      const listOther = await findTransactionsByOrderId(order.id, merchant2Id);
      expect(listOther.length).toBe(0);
    });

    it('enforces tenant ownership when updating transaction status', async () => {
      const orderRef = generateUlid();
      const order = await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 8000,
        currency: 'INR'
      });

      const txnRef = generateUlid();
      const txn = await createTransaction({
        orderId: order.id,
        txnRef,
        paymentMethod: 'netbanking',
        amount: 8000
      });

      // Cross-merchant update affects 0 rows
      const otherUpdated = await updateTransactionStatus(
        txn.id,
        merchant2Id,
        'failed',
        { error: 'hack' },
        'Attacker injection'
      );
      expect(otherUpdated).toBe(false);

      const unchanged = await findTransactionById(txn.id, merchant1Id);
      expect(unchanged?.status).toBe('initiated');

      // Same-merchant update succeeds
      const ownUpdated = await updateTransactionStatus(
        txn.id,
        merchant1Id,
        'success',
        { authCode: 'AUTH123' }
      );
      expect(ownUpdated).toBe(true);

      const updated = await findTransactionById(txn.id, merchant1Id);
      expect(updated?.status).toBe('success');
    });
  });

  describe('Service Layer Tenant Isolation (No In-Memory Leakage)', () => {
    it('returns 404 ORDER_NOT_FOUND when requesting order status for a foreign merchant', async () => {
      const orderRef = generateUlid();
      await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 500,
        currency: 'INR'
      });

      // Same merchant succeeds
      const result = await getOrderStatus(orderRef, merchant1Id);
      expect(result.order.orderRef).toBe(orderRef);

      // Cross-merchant throws 404 (not 403, zero data leakage)
      await expect(getOrderStatus(orderRef, merchant2Id)).rejects.toThrow(HttpError);
      try {
        await getOrderStatus(orderRef, merchant2Id);
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(404);
        expect((err as HttpError).code).toBe('ORDER_NOT_FOUND');
      }
    });

    it('prevents cross-tenant payment processing at repository boundary', async () => {
      const orderRef = generateUlid();
      await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 900,
        currency: 'INR'
      });

      // Merchant 2 attempting to process Merchant 1's order gets 404 immediately
      await expect(
        processPayment(orderRef, merchant2Id, { paymentMethod: 'card' })
      ).rejects.toThrow(HttpError);

      try {
        await processPayment(orderRef, merchant2Id, { paymentMethod: 'card' });
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(404);
      }
    });
  });

  describe('Payment Worker Tenant Scoping', () => {
    it('worker nacks to DLQ when message payload carries mismatched merchantId for transaction', async () => {
      const orderRef = generateUlid();
      const order = await createOrder({
        merchantId: merchant1Id,
        orderRef,
        amount: 3500,
        currency: 'INR'
      });

      const txnRef = generateUlid();
      const txn = await createTransaction({
        orderId: order.id,
        txnRef,
        paymentMethod: 'card',
        amount: 3500
      });

      // Craft worker message with Merchant 2 trying to process Merchant 1's transaction
      const fraudulentMsg = {
        content: Buffer.from(
          JSON.stringify({
            transactionId: txn.id,
            orderId: order.id,
            merchantId: merchant2Id, // Mismatched merchant ID
            orderRef,
            txnRef,
            paymentMethod: 'card',
            amount: 3500
          })
        ),
        properties: { headers: { 'x-correlation-id': '01JTEST0000000000000000000' } }
      };

      const mockChannel: PaymentChannel = {
        ack: () => {},
        nack: (msg, allUpTo, requeue) => {
          expect(requeue).toBe(false); // Sent to DLQ
        },
        publish: () => true
      };

      await handlePaymentMessage(
        mockChannel,
        fraudulentMsg as unknown as amqp.ConsumeMessage
      );

      // Verify transaction was NOT updated
      const freshTxn = await findTransactionById(txn.id, merchant1Id);
      expect(freshTxn?.status).toBe('initiated');
    });
  });
});
