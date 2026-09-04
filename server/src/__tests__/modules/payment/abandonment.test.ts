import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResultSetHeader } from 'mysql2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { pool } from '../../../config/database.js';
import { connectRedis, disconnectRedis } from '../../../infrastructure/redis.js';
import { signAccessToken } from '../../../utils/token.js';
import { generateUlid } from '../../../utils/ulid.js';
import {
  CHECKOUT_ABANDONMENT_STAGES,
  CheckoutAbandonmentInputSchema,
  CheckoutAbandonedEventSchema,
  type CheckoutAbandonmentInput
} from '../../../modules/payment/abandonment.types.js';
import {
  recordOrderAbandonment,
  getOrderAbandonmentHistory
} from '../../../modules/payment/abandonment.repository.js';
import { ingestCheckoutAbandonment } from '../../../modules/payment/abandonment.service.js';
import { EXCHANGES, ROUTING_KEYS } from '../../../infrastructure/rabbitmq.js';

describe('BT-D1: Checkout Abandonment Event Schema & Ingestion Path', () => {
  let server: Server;
  let baseUrl: string;
  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;

  beforeAll(async () => {
    await connectRedis();

    const app = createApp();
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;

    const conn = await pool.getConnection();
    try {
      const email1 = `abandon_m1_${Date.now()}@example.com`;
      const email2 = `abandon_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Abandon Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = res1.insertId;

      const [res2] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Abandon Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = res2.insertId;

      token1 = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Abandon Merchant 1',
        roles: ['merchant']
      });

      token2 = signAccessToken({
        id: merchant2Id,
        email: email2,
        merchantName: 'Abandon Merchant 2',
        roles: ['merchant']
      });
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await disconnectRedis();
  });

  /* ------------------------------------------------------------------ */
  /*  1. Schema Validation Tests                                        */
  /* ------------------------------------------------------------------ */
  describe('Schema Validation (CheckoutAbandonmentInputSchema & CheckoutAbandonedEventSchema)', () => {
    it('accepts all 5 canonical abandonment stages', () => {
      for (const stage of CHECKOUT_ABANDONMENT_STAGES) {
        const input: CheckoutAbandonmentInput = {
          stage,
          dwellTimeSeconds: 45,
          validationFailureCount: 1,
          customerEmail: 'shopper@example.com',
          hasConsentedChannel: true
        };
        const parsed = CheckoutAbandonmentInputSchema.safeParse(input);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.stage).toBe(stage);
        }
      }
    });

    it('rejects invalid abandonment stage', () => {
      const input = {
        stage: 'page_closed_early',
        dwellTimeSeconds: 10
      };
      const result = CheckoutAbandonmentInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('stage must be one of');
      }
    });

    it('rejects negative dwell time or negative validation failure count', () => {
      const res1 = CheckoutAbandonmentInputSchema.safeParse({
        stage: 'method_selected',
        dwellTimeSeconds: -5
      });
      expect(res1.success).toBe(false);

      const res2 = CheckoutAbandonmentInputSchema.safeParse({
        stage: 'method_selected',
        validationFailureCount: -1
      });
      expect(res2.success).toBe(false);
    });

    it('rejects invalid customer email format', () => {
      const result = CheckoutAbandonmentInputSchema.safeParse({
        stage: 'details_entered',
        customerEmail: 'not-an-email'
      });
      expect(result.success).toBe(false);
    });

    it('validates canonical event schema and normalizes currency', () => {
      const canonical = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: 1,
        orderId: 10,
        orderRef: generateUlid(),
        sessionId: 'sess_123',
        stage: 'details_entered',
        selectedPaymentMethod: 'upi',
        dwellTimeSeconds: 120,
        validationFailureCount: 0,
        amountMinorUnits: 499900,
        currency: 'inr',
        customerEmail: 'buyer@example.com',
        customerPhone: '+919876543210',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'client_beacon',
        correlationId: generateUlid(),
        traceId: generateUlid()
      };

      const parsed = CheckoutAbandonedEventSchema.safeParse(canonical);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.currency).toBe('INR');
        expect(parsed.data.amountMinorUnits).toBe(499900);
        expect(parsed.data.hasConsentedChannel).toBe(true);
      }
    });

    it('rejects canonical event with non-integer or non-positive amountMinorUnits', () => {
      const invalidEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: 1,
        orderId: 10,
        orderRef: generateUlid(),
        stage: 'arrived_only',
        dwellTimeSeconds: 0,
        validationFailureCount: 0,
        amountMinorUnits: 49.99, // Non-integer
        currency: 'INR',
        hasConsentedChannel: false,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'merchant_api',
        correlationId: generateUlid(),
        traceId: generateUlid()
      };

      const result = CheckoutAbandonedEventSchema.safeParse(invalidEvent);
      expect(result.success).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Repository Persistence & Deduplication Tests                   */
  /* ------------------------------------------------------------------ */
  describe('Abandonment Repository & Order Metadata Persistence', () => {
    it('persists abandonment event into order metadata and tracks history', async () => {
      const orderRef = generateUlid();
      const [orderRes] = await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 1500.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );
      const orderId = orderRes.insertId;

      const eventId = generateUlid();
      const correlationId = generateUlid();

      const event = CheckoutAbandonedEventSchema.parse({
        eventId,
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        sessionId: 'sess_repo_1',
        stage: 'method_selected',
        selectedPaymentMethod: 'upi',
        dwellTimeSeconds: 30,
        validationFailureCount: 0,
        amountMinorUnits: 150000,
        currency: 'INR',
        customerEmail: 'cust1@example.com',
        hasConsentedChannel: false,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'merchant_api',
        correlationId,
        traceId: correlationId
      });

      const recordResult = await recordOrderAbandonment(merchant1Id, orderId, event);
      expect(recordResult.isDuplicate).toBe(false);
      expect(recordResult.totalAbandonmentCount).toBe(1);

      const history = await getOrderAbandonmentHistory(merchant1Id, orderId);
      expect(history.length).toBe(1);
      expect(history[0]?.eventId).toBe(eventId);
      expect(history[0]?.stage).toBe('method_selected');
      expect(history[0]?.amountMinorUnits).toBe(150000);
    });

    it('detects duplicate abandonment events by eventId and skips duplicate addition', async () => {
      const orderRef = generateUlid();
      const [orderRes] = await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 2000.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );
      const orderId = orderRes.insertId;

      const event = CheckoutAbandonedEventSchema.parse({
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        sessionId: 'sess_dup_1',
        stage: 'details_entered',
        dwellTimeSeconds: 60,
        validationFailureCount: 1,
        amountMinorUnits: 200000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'client_beacon',
        correlationId: generateUlid(),
        traceId: generateUlid()
      });

      const firstRecord = await recordOrderAbandonment(merchant1Id, orderId, event);
      expect(firstRecord.isDuplicate).toBe(false);

      // Ingest the identical event again
      const secondRecord = await recordOrderAbandonment(merchant1Id, orderId, event);
      expect(secondRecord.isDuplicate).toBe(true);
      expect(secondRecord.totalAbandonmentCount).toBe(1);

      const history = await getOrderAbandonmentHistory(merchant1Id, orderId);
      expect(history.length).toBe(1);
    });

    it('records multiple distinct abandonment sessions against the same order', async () => {
      const orderRef = generateUlid();
      const [orderRes] = await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 3500.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );
      const orderId = orderRes.insertId;

      // Session 1: arrived_only
      const event1 = CheckoutAbandonedEventSchema.parse({
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        sessionId: 'sess_multi_1',
        stage: 'arrived_only',
        dwellTimeSeconds: 5,
        validationFailureCount: 0,
        amountMinorUnits: 350000,
        currency: 'INR',
        hasConsentedChannel: false,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'timeout_detector',
        correlationId: generateUlid(),
        traceId: generateUlid()
      });
      await recordOrderAbandonment(merchant1Id, orderId, event1);

      // Session 2: returned and reached details_entered
      const event2 = CheckoutAbandonedEventSchema.parse({
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        sessionId: 'sess_multi_2',
        stage: 'details_entered',
        dwellTimeSeconds: 150,
        validationFailureCount: 2,
        amountMinorUnits: 350000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'client_beacon',
        correlationId: generateUlid(),
        traceId: generateUlid()
      });
      const record2 = await recordOrderAbandonment(merchant1Id, orderId, event2);
      expect(record2.isDuplicate).toBe(false);
      expect(record2.totalAbandonmentCount).toBe(2);

      const history = await getOrderAbandonmentHistory(merchant1Id, orderId);
      expect(history.length).toBe(2);
      expect(history[0]?.stage).toBe('arrived_only');
      expect(history[1]?.stage).toBe('details_entered');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Ingestion Service Logic & Broker Dispatch                      */
  /* ------------------------------------------------------------------ */
  describe('Ingestion Service Logic (ingestCheckoutAbandonment)', () => {
    it('successfully ingests valid abandonment and publishes to RabbitMQ', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 2500.50, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      const mockPublish = vi.fn().mockReturnValue(true);
      const mockChannel = {
        publish: mockPublish
      } as unknown as import('amqplib').Channel;

      const correlationId = generateUlid();
      const result = await ingestCheckoutAbandonment({
        merchantId: merchant1Id,
        orderRef,
        input: {
          sessionId: 'sess_srv_1',
          stage: 'submit_attempted_failed_validation',
          selectedPaymentMethod: 'card',
          dwellTimeSeconds: 80,
          validationFailureCount: 3,
          customerEmail: 'shopper@example.com',
          hasConsentedChannel: true
        },
        correlationId,
        customChannel: mockChannel
      });

      expect(result.success).toBe(true);
      expect(result.isDuplicate).toBe(false);
      expect(result.amountMinorUnits).toBe(250050); // 2500.50 * 100
      expect(result.stage).toBe('submit_attempted_failed_validation');
      expect(result.routingKey).toBe(ROUTING_KEYS.CHECKOUT_ABANDONED);

      // Verify RabbitMQ publish was invoked with correct exchange and routing key
      expect(mockPublish).toHaveBeenCalledTimes(1);
      const [exchange, routingKey, buffer, options] = mockPublish.mock.calls[0];
      expect(exchange).toBe(EXCHANGES.PAYMENT);
      expect(routingKey).toBe(ROUTING_KEYS.CHECKOUT_ABANDONED);

      const publishedPayload = JSON.parse(buffer.toString());
      expect(publishedPayload.eventType).toBe('checkout.abandoned');
      expect(publishedPayload.amountMinorUnits).toBe(250050);
      expect(publishedPayload.orderRef).toBe(orderRef);
      expect(options.correlationId).toBe(correlationId);
      expect(options.headers['x-correlation-id']).toBe(correlationId);
      expect(options.headers['x-order-ref']).toBe(orderRef);
    });

    it('skips RabbitMQ publication if event is a duplicate', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 1000.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      const mockPublish = vi.fn().mockReturnValue(true);
      const mockChannel = { publish: mockPublish } as unknown as import('amqplib').Channel;

      const input = {
        sessionId: 'sess_dup_check',
        stage: 'method_selected' as const,
        dwellTimeSeconds: 20
      };

      // Ingest first time -> publishes
      const res1 = await ingestCheckoutAbandonment({
        merchantId: merchant1Id,
        orderRef,
        input,
        correlationId: generateUlid(),
        customChannel: mockChannel
      });
      expect(res1.isDuplicate).toBe(false);
      expect(mockPublish).toHaveBeenCalledTimes(1);

      // Ingest second time with same session & stage -> skips publish
      const res2 = await ingestCheckoutAbandonment({
        merchantId: merchant1Id,
        orderRef,
        input,
        correlationId: generateUlid(),
        customChannel: mockChannel
      });
      expect(res2.isDuplicate).toBe(true);
      // Publish count remains 1
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it('enforces tenant isolation and rejects order belonging to another merchant', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 500.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      // Merchant 2 attempts to ingest abandonment for Merchant 1's order
      await expect(
        ingestCheckoutAbandonment({
          merchantId: merchant2Id,
          orderRef,
          input: { stage: 'arrived_only' },
          correlationId: generateUlid()
        })
      ).rejects.toThrow('Order does not exist or does not belong to merchant');
    });

    it('rejects non-existent order with 404 ORDER_NOT_FOUND', async () => {
      await expect(
        ingestCheckoutAbandonment({
          merchantId: merchant1Id,
          orderRef: generateUlid(),
          input: { stage: 'arrived_only' },
          correlationId: generateUlid()
        })
      ).rejects.toThrow('Order does not exist or does not belong to merchant');
    });

    it('rejects already completed order with 409 ORDER_ALREADY_PAID', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 1000.00, 'INR', 'success')`,
        [merchant1Id, orderRef]
      );

      await expect(
        ingestCheckoutAbandonment({
          merchantId: merchant1Id,
          orderRef,
          input: { stage: 'method_selected' },
          correlationId: generateUlid()
        })
      ).rejects.toThrow('This order has already been successfully paid');
    });

    it('rejects already failed order with 409 ORDER_ALREADY_FAILED', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 1000.00, 'INR', 'failed')`,
        [merchant1Id, orderRef]
      );

      await expect(
        ingestCheckoutAbandonment({
          merchantId: merchant1Id,
          orderRef,
          input: { stage: 'method_selected' },
          correlationId: generateUlid()
        })
      ).rejects.toThrow('This order is already in failed status');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. HTTP API Endpoint Integration Tests                           */
  /* ------------------------------------------------------------------ */
  describe('HTTP API Endpoint (POST /api/payments/orders/:orderRef/abandonment)', () => {
    it('returns 202 Accepted with ingestion result for authenticated merchant', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 4500.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandonment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify({
          sessionId: 'sess_http_1',
          stage: 'details_entered',
          selectedPaymentMethod: 'upi',
          dwellTimeSeconds: 95,
          validationFailureCount: 1,
          customerEmail: 'checkout_user@example.com',
          hasConsentedChannel: true
        })
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.orderRef).toBe(orderRef);
      expect(body.merchantId).toBe(merchant1Id);
      expect(body.stage).toBe('details_entered');
      expect(body.amountMinorUnits).toBe(450000);
      expect(body.currency).toBe('INR');
      expect(body.isDuplicate).toBe(false);
      expect(body.routingKey).toBe('checkout.abandoned');
      expect(body.eventId).toBeDefined();
    });

    it('returns 401 Unauthorized when missing authentication token', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders/${generateUlid()}/abandonment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'arrived_only' })
      });

      expect(res.status).toBe(401);
    });

    it('returns 404 Not Found when merchant accesses another merchant order', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 1200.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      // Merchant 2 calls endpoint with Merchant 1's order
      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandonment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token2}`
        },
        body: JSON.stringify({ stage: 'arrived_only' })
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 Bad Request on invalid stage', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders/${generateUlid()}/abandonment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify({ stage: 'invalid_stage_xyz' })
      });

      expect(res.status).toBe(400);
    });

    it('supports Idempotency-Key header and safely replays cached response', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 750.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      const idempotencyKey = `idemp_ab_${generateUlid()}`;
      const payload = {
        sessionId: 'sess_idem_test',
        stage: 'method_selected',
        dwellTimeSeconds: 40
      };

      // First request
      const res1 = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandonment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token1}`,
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(payload)
      });

      expect(res1.status).toBe(202);
      const data1 = await res1.json();

      // Second request with same idempotency key
      const res2 = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandonment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token1}`,
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(payload)
      });

      expect(res2.status).toBe(202);
      const data2 = await res2.json();
      expect(data2.eventId).toBe(data1.eventId);
    });

    it('works identically via alias route POST /api/payments/orders/:orderRef/abandoned', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 890.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandoned`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token1}`
        },
        body: JSON.stringify({
          stage: 'submit_blocked',
          dwellTimeSeconds: 55
        })
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.stage).toBe('submit_blocked');
      expect(body.amountMinorUnits).toBe(89000);
    });
  });
});
