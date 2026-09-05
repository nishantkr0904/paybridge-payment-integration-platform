import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { pool } from '../../../config/database.js';
import { connectRedis, disconnectRedis } from '../../../infrastructure/redis.js';
import { getMetrics, resetMetricsRegistry } from '../../../infrastructure/metrics.js';
import { signAccessToken } from '../../../utils/token.js';
import { generateUlid } from '../../../utils/ulid.js';
import {
  detectCheckoutAbandonmentTimeouts,
  checkOrderTimeout
} from '../../../modules/payment/timeout-detector.service.js';
import { getOrderAbandonmentHistory } from '../../../modules/payment/abandonment.repository.js';
import { HttpError } from '../../../utils/http-error.js';

describe('BT-D2: Checkout Abandonment Timeout Detection', () => {
  let server: Server;
  let baseUrl: string;
  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;

  beforeAll(async () => {
    await connectRedis();
    resetMetricsRegistry();

    const app = createApp();
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;

    const conn = await pool.getConnection();
    try {
      const email1 = `timeout_m1_${Date.now()}@example.com`;
      const email2 = `timeout_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Timeout Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = res1.insertId;

      const [res2] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Timeout Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = res2.insertId;

      token1 = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Timeout Merchant 1',
        roles: ['merchant']
      });

      token2 = signAccessToken({
        id: merchant2Id,
        email: email2,
        merchantName: 'Timeout Merchant 2',
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
  /*  1. Timeout Detection Core Logic & Boundary Checks                 */
  /* ------------------------------------------------------------------ */
  describe('Inactivity & Boundary Conditions', () => {
    it('detects inactive checkout order past timeout threshold', async () => {
      const orderRef = generateUlid();
      const baseTime = new Date('2026-03-01T12:00:00.000Z');
      const lastActive = new Date(baseTime.getTime() - 1000 * 1000); // 1000s ago (> 900s)

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 250.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({
            stage: 'details_entered',
            lastActiveAt: lastActive.toISOString(),
            customerEmail: 'shopper1@example.com'
          })
        ]
      );

      const result = await checkOrderTimeout(orderRef, merchant1Id, {
        now: baseTime,
        timeoutThresholdSeconds: 900
      });

      expect(result.isAbandoned).toBe(true);
      expect(result.isDuplicate).toBe(false);
      expect(result.dwellTimeSeconds).toBe(1000);
      expect(result.thresholdSeconds).toBe(900);
      expect(result.stage).toBe('details_entered');
      expect(result.eventId).toBeDefined();

      // Check DB persistence
      const history = await getOrderAbandonmentHistory(merchant1Id, (await getOrderId(orderRef)));
      expect(history.length).toBe(1);
      expect(history[0]?.source).toBe('timeout_detector');
      expect(history[0]?.amountMinorUnits).toBe(25000);
      expect(history[0]?.stage).toBe('details_entered');
    });

    it('does NOT mark active checkout as abandoned when dwell < threshold (threshold - 1s)', async () => {
      const orderRef = generateUlid();
      const baseTime = new Date('2026-03-01T12:00:00.000Z');
      const lastActive = new Date(baseTime.getTime() - 899 * 1000); // 899s ago (< 900s)

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 150.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({
            stage: 'method_selected',
            selectedPaymentMethod: 'upi',
            lastActiveAt: lastActive.toISOString()
          })
        ]
      );

      const result = await checkOrderTimeout(orderRef, merchant1Id, {
        now: baseTime,
        timeoutThresholdSeconds: 900
      });

      expect(result.isAbandoned).toBe(false);
      expect(result.isDuplicate).toBe(false);
      expect(result.dwellTimeSeconds).toBe(899);
      expect(result.reason).toBe('within_timeout_threshold');

      // Verify no abandonment history recorded
      const history = await getOrderAbandonmentHistory(merchant1Id, (await getOrderId(orderRef)));
      expect(history.length).toBe(0);
    });

    it('marks checkout as abandoned at exact threshold boundary (dwell == threshold)', async () => {
      const orderRef = generateUlid();
      const baseTime = new Date('2026-03-01T12:00:00.000Z');
      const lastActive = new Date(baseTime.getTime() - 900 * 1000); // exactly 900s ago

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 500.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({
            stage: 'arrived_only',
            lastActiveAt: lastActive.toISOString()
          })
        ]
      );

      const result = await checkOrderTimeout(orderRef, merchant1Id, {
        now: baseTime,
        timeoutThresholdSeconds: 900
      });

      expect(result.isAbandoned).toBe(true);
      expect(result.dwellTimeSeconds).toBe(900);
      expect(result.stage).toBe('arrived_only');
    });

    it('honors custom configured threshold (e.g. 300s)', async () => {
      const orderRef = generateUlid();
      const baseTime = new Date('2026-03-01T12:00:00.000Z');
      const lastActive = new Date(baseTime.getTime() - 350 * 1000); // 350s ago

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 75.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({
            lastActiveAt: lastActive.toISOString()
          })
        ]
      );

      // Within 900s default -> NOT abandoned
      const checkDefault = await checkOrderTimeout(orderRef, merchant1Id, {
        now: baseTime,
        timeoutThresholdSeconds: 900
      });
      expect(checkDefault.isAbandoned).toBe(false);

      // Past custom 300s -> abandoned!
      const checkCustom = await checkOrderTimeout(orderRef, merchant1Id, {
        now: baseTime,
        timeoutThresholdSeconds: 300
      });
      expect(checkCustom.isAbandoned).toBe(true);
      expect(checkCustom.thresholdSeconds).toBe(300);
    });

    it('falls back to order.createdAt when lastActiveAt is absent in metadata', async () => {
      const orderRef = generateUlid();
      const baseTime = new Date('2026-03-01T12:00:00.000Z');
      const createdAt = new Date(baseTime.getTime() - 1200 * 1000); // 1200s ago

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, created_at, metadata) VALUES (?, ?, 199.00, 'INR', 'pending', ?, ?)`,
        [
          merchant1Id,
          orderRef,
          createdAt,
          JSON.stringify({
            customerEmail: 'fallback@example.com'
          })
        ]
      );

      const result = await checkOrderTimeout(orderRef, merchant1Id, {
        now: baseTime,
        timeoutThresholdSeconds: 900
      });

      expect(result.isAbandoned).toBe(true);
      expect(result.dwellTimeSeconds).toBe(1200);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  2. Duplicate Suppression & Idempotency                            */
  /* ------------------------------------------------------------------ */
  describe('Duplicate Suppression / Safe Repeated Execution', () => {
    it('skips duplicate timeout abandonment if no new checkout activity occurred', async () => {
      const orderRef = generateUlid();
      const baseTime = new Date('2026-03-01T12:00:00.000Z');
      const lastActive = new Date(baseTime.getTime() - 1000 * 1000);

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 300.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({
            stage: 'details_entered',
            lastActiveAt: lastActive.toISOString()
          })
        ]
      );

      // Run 1: First detection marks abandoned
      const run1 = await checkOrderTimeout(orderRef, merchant1Id, {
        now: baseTime,
        timeoutThresholdSeconds: 900
      });
      expect(run1.isAbandoned).toBe(true);
      expect(run1.isDuplicate).toBe(false);

      // Run 2: Second detection 5 minutes later without new checkout activity
      const laterTime = new Date(baseTime.getTime() + 300 * 1000);
      const run2 = await checkOrderTimeout(orderRef, merchant1Id, {
        now: laterTime,
        timeoutThresholdSeconds: 900
      });

      expect(run2.isAbandoned).toBe(false);
      expect(run2.isDuplicate).toBe(true);
      expect(run2.reason).toBe('already_timed_out_no_new_activity');

      // History should only have 1 event
      const history = await getOrderAbandonmentHistory(merchant1Id, (await getOrderId(orderRef)));
      expect(history.length).toBe(1);
    });

    it('allows new abandonment detection if subsequent user activity is recorded', async () => {
      const orderRef = generateUlid();
      const t1 = new Date('2026-03-01T12:00:00.000Z');
      const initialActive = new Date(t1.getTime() - 1000 * 1000);

      const [insertRes] = await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 400.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({
            stage: 'arrived_only',
            lastActiveAt: initialActive.toISOString()
          })
        ]
      );
      const orderId = insertRes.insertId;

      // Timeout 1
      const run1 = await checkOrderTimeout(orderRef, merchant1Id, { now: t1, timeoutThresholdSeconds: 900 });
      expect(run1.isAbandoned).toBe(true);

      // User returns at t2 and interacts (updates lastActiveAt and stage to details_entered)
      const t2 = new Date('2026-03-01T13:00:00.000Z');
      const [orderRows] = await pool.query<RowDataPacket[]>(
        `SELECT metadata FROM orders WHERE id = ?`,
        [orderId]
      );
      const rawMeta = orderRows[0]!.metadata;
      const currentMeta =
        typeof rawMeta === 'string' ? JSON.parse(rawMeta) : { ...(rawMeta as Record<string, unknown>) };
      currentMeta.stage = 'details_entered';
      currentMeta.lastActiveAt = t2.toISOString();

      await pool.query(
        `UPDATE orders SET metadata = ? WHERE id = ?`,
        [JSON.stringify(currentMeta), orderId]
      );

      // Timeout 2: 1000 seconds after t2
      const t3 = new Date(t2.getTime() + 1000 * 1000);
      const run2 = await checkOrderTimeout(orderRef, merchant1Id, { now: t3, timeoutThresholdSeconds: 900 });
      expect(run2.isAbandoned).toBe(true);
      expect(run2.stage).toBe('details_entered');

      // History should now have 2 distinct abandonment events
      const history = await getOrderAbandonmentHistory(merchant1Id, orderId);
      expect(history.length).toBe(2);
      expect(history[0]?.stage).toBe('arrived_only');
      expect(history[1]?.stage).toBe('details_entered');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  3. Non-Terminal Order Invariance                                  */
  /* ------------------------------------------------------------------ */
  describe('Non-Terminal Invariance', () => {
    it('refuses to abandon an already successfully paid order', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 100.00, 'INR', 'success', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({ lastActiveAt: new Date(Date.now() - 2000000).toISOString() })
        ]
      );

      await expect(
        checkOrderTimeout(orderRef, merchant1Id, { timeoutThresholdSeconds: 900 })
      ).rejects.toThrow(HttpError);
    });

    it('refuses to abandon an already failed order', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 100.00, 'INR', 'failed', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({ lastActiveAt: new Date(Date.now() - 2000000).toISOString() })
        ]
      );

      await expect(
        checkOrderTimeout(orderRef, merchant1Id, { timeoutThresholdSeconds: 900 })
      ).rejects.toThrow(HttpError);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  4. Tenant Isolation                                               */
  /* ------------------------------------------------------------------ */
  describe('Tenant Isolation (SEC-002 / Invariant I9)', () => {
    it('rejects cross-tenant timeout evaluation for single order', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 100.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      // Merchant 2 attempts to check Merchant 1's order
      await expect(
        checkOrderTimeout(orderRef, merchant2Id, { timeoutThresholdSeconds: 900 })
      ).rejects.toThrow(HttpError);
    });

    it('batch timeout detection only processes orders for specified merchant', async () => {
      const m1Ref = generateUlid();
      const m2Ref = generateUlid();
      const oldTime = new Date(Date.now() - 5000000);

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, created_at, metadata) VALUES (?, ?, 100.00, 'INR', 'pending', ?, ?)`,
        [merchant1Id, m1Ref, oldTime, JSON.stringify({ lastActiveAt: oldTime.toISOString() })]
      );

      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, created_at, metadata) VALUES (?, ?, 200.00, 'INR', 'pending', ?, ?)`,
        [merchant2Id, m2Ref, oldTime, JSON.stringify({ lastActiveAt: oldTime.toISOString() })]
      );

      // Scan exclusively for Merchant 1
      const report = await detectCheckoutAbandonmentTimeouts({
        merchantId: merchant1Id,
        timeoutThresholdSeconds: 900
      });

      expect(report.scannedCount).toBeGreaterThan(0);
      expect(report.abandonedOrderRefs).toContain(m1Ref);
      expect(report.abandonedOrderRefs).not.toContain(m2Ref);

      // Verify Merchant 2's order was untouched
      const m2History = await getOrderAbandonmentHistory(merchant2Id, (await getOrderId(m2Ref)));
      expect(m2History.length).toBe(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  5. Batch Scanner Service                                          */
  /* ------------------------------------------------------------------ */
  describe('Batch Scanner detectCheckoutAbandonmentTimeouts', () => {
    it('correctly categorizes active, timed out, and duplicate orders', async () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      const timedOutRef = generateUlid();
      const activeRef = generateUlid();

      // Timed out order
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 120.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          timedOutRef,
          JSON.stringify({ lastActiveAt: new Date(now.getTime() - 1000 * 1000).toISOString() })
        ]
      );

      // Active order
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 130.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          activeRef,
          JSON.stringify({ lastActiveAt: new Date(now.getTime() - 100 * 1000).toISOString() })
        ]
      );

      // First run: detect timed out
      const report1 = await detectCheckoutAbandonmentTimeouts({
        merchantId: merchant1Id,
        timeoutThresholdSeconds: 900,
        now
      });

      expect(report1.abandonedOrderRefs).toContain(timedOutRef);
      expect(report1.abandonedOrderRefs).not.toContain(activeRef);
      expect(report1.detectedCount).toBeGreaterThanOrEqual(1);

      // Second run immediately after: timed out order is now duplicate
      const report2 = await detectCheckoutAbandonmentTimeouts({
        merchantId: merchant1Id,
        timeoutThresholdSeconds: 900,
        now
      });

      expect(report2.duplicateCount).toBeGreaterThanOrEqual(1);
      const dupItem = report2.results.find((r) => r.orderRef === timedOutRef);
      expect(dupItem?.isDuplicate).toBe(true);
      expect(dupItem?.abandoned).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  6. HTTP API Endpoints                                             */
  /* ------------------------------------------------------------------ */
  describe('HTTP API Endpoints', () => {
    it('POST /api/payments/checkout/timeout-detection runs batch scan for merchant', async () => {
      const res = await fetch(`${baseUrl}/api/payments/checkout/timeout-detection`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          timeoutThresholdSeconds: 600,
          limit: 50
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('scannedCount');
      expect(data).toHaveProperty('detectedCount');
      expect(data).toHaveProperty('skippedCount');
      expect(data).toHaveProperty('duplicateCount');
      expect(data).toHaveProperty('abandonedOrderRefs');
      expect(data).toHaveProperty('thresholdSeconds', 600);
    });

    it('POST /api/payments/checkout/timeout-detection with orderRef evaluates single order', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 210.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({ lastActiveAt: new Date(Date.now() - 5000000).toISOString() })
        ]
      );

      const res = await fetch(`${baseUrl}/api/payments/checkout/timeout-detection`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          orderRef,
          timeoutThresholdSeconds: 900
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.orderRef).toBe(orderRef);
      expect(data.isAbandoned).toBe(true);
      expect(data.isDuplicate).toBe(false);
    });

    it('POST /api/payments/orders/:orderRef/timeout-detection evaluates order route', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 350.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({ lastActiveAt: new Date(Date.now() - 5000000).toISOString() })
        ]
      );

      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/timeout-detection`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          timeoutThresholdSeconds: 900
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.orderRef).toBe(orderRef);
      expect(data.isAbandoned).toBe(true);
    });

    it('rejects unauthenticated request to timeout detection with 401', async () => {
      const res = await fetch(`${baseUrl}/api/payments/checkout/timeout-detection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent order', async () => {
      const fakeRef = generateUlid();
      const res = await fetch(`${baseUrl}/api/payments/orders/${fakeRef}/timeout-detection`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when merchant 2 attempts to evaluate merchant 1 order via HTTP', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 100.00, 'INR', 'pending')`,
        [merchant1Id, orderRef]
      );

      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/timeout-detection`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(404);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  7. Prometheus Metrics Integration                                 */
  /* ------------------------------------------------------------------ */
  describe('Prometheus Metrics', () => {
    it('records checkout abandonment metrics in Prometheus', async () => {
      const orderRef = generateUlid();
      await pool.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, metadata) VALUES (?, ?, 600.00, 'INR', 'pending', ?)`,
        [
          merchant1Id,
          orderRef,
          JSON.stringify({
            stage: 'method_selected',
            selectedPaymentMethod: 'card',
            lastActiveAt: new Date(Date.now() - 5000000).toISOString()
          })
        ]
      );

      await checkOrderTimeout(orderRef, merchant1Id, { timeoutThresholdSeconds: 900 });

      const metrics = await getMetrics();
      expect(metrics).toContain('checkout_abandonments_detected_total');
      expect(metrics).toContain('checkout_abandonment_dwell_time_seconds');
      expect(metrics).toContain('source="timeout_detector"');
    });
  });

  // Helper
  async function getOrderId(orderRef: string): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM orders WHERE order_ref = ?`,
      [orderRef]
    );
    return rows[0]!.id;
  }
});
