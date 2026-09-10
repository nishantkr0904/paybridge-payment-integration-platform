import type { Server } from 'node:http';
import type { ResultSetHeader } from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { signAccessToken } from '../../utils/token.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { connectRabbitMQ, disconnectRabbitMQ } from '../../infrastructure/rabbitmq.js';
import { ROLE_PERMISSIONS } from '../../types/auth.js';
import { hasPermission } from '../../middleware/authorize.js';
import { generateUlid } from '../../utils/ulid.js';

describe('Phase B-2: Payment Route-Level Authorization (/api/payments)', () => {
  let server: Server;
  let baseUrl: string;
  let merchantId: number;
  let orderRef: string;

  // Role tokens
  let platformOperatorToken: string;
  let merchantOperatorToken: string;
  let merchantDeveloperToken: string;
  let financeAnalystToken: string;
  let riskComplianceReviewerToken: string;
  let merchantAdminToken: string;
  let legacyMerchantToken: string;

  beforeAll(async () => {
    await connectRedis();
    await connectRabbitMQ();

    // 1. Seed merchant and initial order in database
    const merchantEmail = `pay_auth_m_${Date.now()}@example.com`;
    const [mResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (email, password_hash, merchant_name) VALUES (?, 'hash', 'Payment Auth Merchant')`,
      [merchantEmail]
    );
    merchantId = mResult.insertId;

    orderRef = generateUlid();
    await pool.query<ResultSetHeader>(
      `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 25000, 'INR', 'pending')`,
      [merchantId, orderRef]
    );

    // 2. Generate signed access tokens for all roles
    merchantOperatorToken = signAccessToken({
      id: merchantId,
      email: `merchant_op_${Date.now()}@example.com`,
      merchantName: 'Payment Auth Merchant',
      roles: ['merchant_operator']
    });

    merchantDeveloperToken = signAccessToken({
      id: merchantId,
      email: `merchant_dev_${Date.now()}@example.com`,
      merchantName: 'Payment Auth Merchant',
      roles: ['merchant_developer']
    });

    merchantAdminToken = signAccessToken({
      id: merchantId,
      email: `merchant_admin_${Date.now()}@example.com`,
      merchantName: 'Payment Auth Merchant',
      roles: ['merchant_admin']
    });

    legacyMerchantToken = signAccessToken({
      id: merchantId,
      email: `legacy_merchant_${Date.now()}@example.com`,
      merchantName: 'Payment Auth Merchant',
      roles: ['merchant']
    });

    financeAnalystToken = signAccessToken({
      id: merchantId,
      email: `finance_analyst_${Date.now()}@example.com`,
      merchantName: 'Payment Auth Merchant',
      roles: ['finance_analyst']
    });

    riskComplianceReviewerToken = signAccessToken({
      id: merchantId,
      email: `risk_compliance_${Date.now()}@example.com`,
      merchantName: 'Payment Auth Merchant',
      roles: ['risk_compliance_reviewer']
    });

    platformOperatorToken = signAccessToken({
      id: 999991,
      email: 'platform_operator@paybridge.internal',
      merchantName: 'PayBridge Platform Operations',
      roles: ['platform_operator']
    });

    // 3. Start test HTTP server
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await disconnectRabbitMQ();
    await disconnectRedis();
  });

  /* ------------------------------------------------------------------ */
  /*  Canonical Role-Permission Mapping Invariants                      */
  /* ------------------------------------------------------------------ */

  describe('RBAC Canonical Mapping Invariants for Payments', () => {
    it('verifies that merchant, merchant_admin, merchant_operator, and merchant_developer possess both payment:read and payment:create', () => {
      for (const role of ['merchant', 'merchant_admin', 'merchant_operator', 'merchant_developer'] as const) {
        expect(ROLE_PERMISSIONS[role]).toContain('payment:read');
        expect(ROLE_PERMISSIONS[role]).toContain('payment:create');
        expect(hasPermission([role], 'payment:read')).toBe(true);
        expect(hasPermission([role], 'payment:create')).toBe(true);
      }
    });

    it('verifies that finance_analyst and risk_compliance_reviewer possess payment:read but NOT payment:create', () => {
      for (const role of ['finance_analyst', 'risk_compliance_reviewer'] as const) {
        expect(ROLE_PERMISSIONS[role]).toContain('payment:read');
        expect(ROLE_PERMISSIONS[role]).not.toContain('payment:create');
        expect(hasPermission([role], 'payment:read')).toBe(true);
        expect(hasPermission([role], 'payment:create')).toBe(false);
      }
    });

    it('verifies that platform_operator possesses neither payment:read nor payment:create', () => {
      expect(ROLE_PERMISSIONS.platform_operator).not.toContain('payment:read');
      expect(ROLE_PERMISSIONS.platform_operator).not.toContain('payment:create');
      expect(hasPermission(['platform_operator'], 'payment:read')).toBe(false);
      expect(hasPermission(['platform_operator'], 'payment:create')).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Authentication Verification (Unauthenticated -> 401)              */
  /* ------------------------------------------------------------------ */

  describe('Authentication Boundary (Unauthenticated -> 401)', () => {
    it('unauthenticated GET /api/payments/orders returns 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('unauthenticated GET /api/payments/orders/:orderRef returns 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('unauthenticated POST /api/payments/orders returns 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 100.0, currency: 'INR' })
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('unauthenticated POST /api/payments/orders/:orderRef/pay returns 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethod: 'card' })
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('unauthenticated POST /api/payments/orders/:orderRef/abandonment returns 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandonment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1' })
      });
      expect(res.status).toBe(401);
    });

    it('unauthenticated POST /api/payments/checkout/timeout-detection returns 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/payments/checkout/timeout-detection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(401);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  payment:read Authorization Coverage                               */
  /* ------------------------------------------------------------------ */

  describe('payment:read Authorization Coverage', () => {
    const authorizedReadRoles = [
      { name: 'merchant_operator', token: () => merchantOperatorToken },
      { name: 'merchant_developer', token: () => merchantDeveloperToken },
      { name: 'finance_analyst', token: () => financeAnalystToken },
      { name: 'risk_compliance_reviewer', token: () => riskComplianceReviewerToken },
      { name: 'merchant_admin', token: () => merchantAdminToken },
      { name: 'merchant (legacy)', token: () => legacyMerchantToken }
    ];

    for (const { name, token } of authorizedReadRoles) {
      it(`allows ${name} to GET /api/payments/orders (200 OK)`, async () => {
        const res = await fetch(`${baseUrl}/api/payments/orders`, {
          headers: { Authorization: `Bearer ${token()}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { orders: unknown[]; total: number };
        expect(Array.isArray(data.orders)).toBe(true);
      });

      it(`allows ${name} to GET /api/payments/orders/:orderRef (200 OK)`, async () => {
        const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}`, {
          headers: { Authorization: `Bearer ${token()}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { order: { orderRef: string } };
        expect(data.order.orderRef).toBe(orderRef);
      });
    }

    it('denies platform_operator on GET /api/payments/orders (403 AUTH_FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
      expect(data.error.message).toContain('Missing required permission(s): payment:read');
    });

    it('denies platform_operator on GET /api/payments/orders/:orderRef (403 AUTH_FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
      expect(data.error.message).toContain('Missing required permission(s): payment:read');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  payment:create Authorization Coverage                             */
  /* ------------------------------------------------------------------ */

  describe('payment:create Authorization Coverage', () => {
    const authorizedCreateRoles = [
      { name: 'merchant_operator', token: () => merchantOperatorToken },
      { name: 'merchant_developer', token: () => merchantDeveloperToken },
      { name: 'merchant_admin', token: () => merchantAdminToken },
      { name: 'merchant (legacy)', token: () => legacyMerchantToken }
    ];

    const deniedCreateRoles = [
      { name: 'finance_analyst', token: () => financeAnalystToken },
      { name: 'risk_compliance_reviewer', token: () => riskComplianceReviewerToken },
      { name: 'platform_operator', token: () => platformOperatorToken }
    ];

    /* 1. POST /api/payments/orders */
    describe('POST /api/payments/orders', () => {
      for (const { name, token } of authorizedCreateRoles) {
        it(`allows ${name} to create order (201 Created)`, async () => {
          const res = await fetch(`${baseUrl}/api/payments/orders`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token()}`
            },
            body: JSON.stringify({
              amount: 150.0,
              currency: 'INR',
              description: `Order created by ${name}`
            })
          });
          expect(res.status).toBe(201);
          const data = (await res.json()) as { id: number; orderRef: string };
          expect(data.id).toBeDefined();
          expect(data.orderRef).toBeDefined();
        });
      }

      for (const { name, token } of deniedCreateRoles) {
        it(`denies ${name} from creating order (403 AUTH_FORBIDDEN)`, async () => {
          const res = await fetch(`${baseUrl}/api/payments/orders`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token()}`
            },
            body: JSON.stringify({ amount: 150.0, currency: 'INR' })
          });
          expect(res.status).toBe(403);
          const data = (await res.json()) as { error: { code: string; message: string } };
          expect(data.error.code).toBe('AUTH_FORBIDDEN');
          expect(data.error.message).toContain('Missing required permission(s): payment:create');
        });
      }
    });

    /* 2. POST /api/payments/orders/:orderRef/pay */
    describe('POST /api/payments/orders/:orderRef/pay', () => {
      it('allows merchant_operator to process payment (202 Accepted)', async () => {
        // Create fresh order to pay
        const testOrderRef = generateUlid();
        await pool.query(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 5000, 'INR', 'pending')`,
          [merchantId, testOrderRef]
        );

        const res = await fetch(`${baseUrl}/api/payments/orders/${testOrderRef}/pay`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${merchantOperatorToken}`
          },
          body: JSON.stringify({ paymentMethod: 'card' })
        });
        expect(res.status).toBe(202);
        const data = (await res.json()) as { orderRef: string; status: string };
        expect(data.orderRef).toBe(testOrderRef);
        expect(data.status).toBe('processing');
      });

      for (const { name, token } of deniedCreateRoles) {
        it(`denies ${name} from processing payment (403 AUTH_FORBIDDEN)`, async () => {
          const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/pay`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token()}`
            },
            body: JSON.stringify({ paymentMethod: 'card' })
          });
          expect(res.status).toBe(403);
          const data = (await res.json()) as { error: { code: string; message: string } };
          expect(data.error.code).toBe('AUTH_FORBIDDEN');
          expect(data.error.message).toContain('Missing required permission(s): payment:create');
        });
      }
    });

    /* 3. POST /api/payments/orders/:orderRef/abandonment & /abandoned (Aliases) */
    describe('Abandonment Ingestion Aliases (/abandonment vs /abandoned)', () => {
      it('allows merchant_developer on POST /orders/:orderRef/abandonment (202 Accepted)', async () => {
        const testOrderRef = generateUlid();
        await pool.query(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 5000, 'INR', 'pending')`,
          [merchantId, testOrderRef]
        );

        const res = await fetch(`${baseUrl}/api/payments/orders/${testOrderRef}/abandonment`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${merchantDeveloperToken}`
          },
          body: JSON.stringify({
            sessionId: 'sess_1',
            stage: 'method_selected',
            selectedPaymentMethod: 'card',
            dwellTimeSeconds: 40
          })
        });
        expect(res.status).toBe(202);
      });

      it('allows merchant_developer on POST /orders/:orderRef/abandoned (202 Accepted)', async () => {
        const testOrderRef = generateUlid();
        await pool.query(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 5000, 'INR', 'pending')`,
          [merchantId, testOrderRef]
        );

        const res = await fetch(`${baseUrl}/api/payments/orders/${testOrderRef}/abandoned`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${merchantDeveloperToken}`
          },
          body: JSON.stringify({
            sessionId: 'sess_2',
            stage: 'method_selected',
            selectedPaymentMethod: 'upi',
            dwellTimeSeconds: 50
          })
        });
        expect(res.status).toBe(202);
      });

      for (const { name, token } of deniedCreateRoles) {
        it(`denies ${name} on /abandonment (403 AUTH_FORBIDDEN)`, async () => {
          const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandonment`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token()}`
            },
            body: JSON.stringify({ sessionId: 's' })
          });
          expect(res.status).toBe(403);
          const data = (await res.json()) as { error: { code: string } };
          expect(data.error.code).toBe('AUTH_FORBIDDEN');
        });

        it(`denies ${name} on /abandoned (403 AUTH_FORBIDDEN)`, async () => {
          const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/abandoned`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token()}`
            },
            body: JSON.stringify({ sessionId: 's' })
          });
          expect(res.status).toBe(403);
          const data = (await res.json()) as { error: { code: string } };
          expect(data.error.code).toBe('AUTH_FORBIDDEN');
        });
      }
    });

    /* 4. Timeout Detection Routes (/checkout/timeout-detection & /orders/:orderRef/timeout-detection) */
    describe('Timeout Detection Routes (/checkout/timeout-detection & /orders/:orderRef/timeout-detection)', () => {
      it('allows merchant_operator on POST /checkout/timeout-detection (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/payments/checkout/timeout-detection`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${merchantOperatorToken}`
          },
          body: JSON.stringify({ timeoutThresholdSeconds: 300 })
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { scannedCount: number };
        expect(data.scannedCount).toBeDefined();
      });

      it('allows merchant_operator on POST /orders/:orderRef/timeout-detection (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/timeout-detection`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${merchantOperatorToken}`
          },
          body: JSON.stringify({ timeoutThresholdSeconds: 300 })
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { orderRef: string; isAbandoned: boolean };
        expect(data.orderRef).toBe(orderRef);
        expect(typeof data.isAbandoned).toBe('boolean');
      });

      for (const { name, token } of deniedCreateRoles) {
        it(`denies ${name} on /checkout/timeout-detection (403 AUTH_FORBIDDEN)`, async () => {
          const res = await fetch(`${baseUrl}/api/payments/checkout/timeout-detection`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token()}`
            },
            body: JSON.stringify({})
          });
          expect(res.status).toBe(403);
          const data = (await res.json()) as { error: { code: string } };
          expect(data.error.code).toBe('AUTH_FORBIDDEN');
        });

        it(`denies ${name} on /orders/:orderRef/timeout-detection (403 AUTH_FORBIDDEN)`, async () => {
          const res = await fetch(`${baseUrl}/api/payments/orders/${orderRef}/timeout-detection`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token()}`
            },
            body: JSON.stringify({})
          });
          expect(res.status).toBe(403);
          const data = (await res.json()) as { error: { code: string } };
          expect(data.error.code).toBe('AUTH_FORBIDDEN');
        });
      }
    });
  });
});
