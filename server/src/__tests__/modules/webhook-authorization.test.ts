import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResultSetHeader } from 'mysql2';
import { createApp } from '../../app.js';
import { pool, closePool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { signAccessToken } from '../../utils/token.js';
import { ROLE_PERMISSIONS, type Role } from '../../types/auth.js';
import { createWebhookEndpoint, logWebhookDelivery } from '../../modules/webhook/webhook.repository.js';

describe('Merchant Developer — Task 2: Webhook RBAC Authorization & Tenant Isolation', () => {
  let server: Server;
  let baseUrl: string;

  let merchant1Id: number;
  let merchant2Id: number;

  let merchantDeveloperToken: string;
  let merchantAdminToken: string;
  let legacyMerchantToken: string;
  let merchantOperatorToken: string;
  let financeAnalystToken: string;
  let riskComplianceReviewerToken: string;
  let platformOperatorToken: string;
  let readOnlySecretMaskedToken: string;
  let managerNoSecretToken: string;

  let m2DeveloperToken: string;

  let m1EndpointId: number;
  let m2EndpointId: number;
  const m1Secret = 'whsec_merchant_1_super_secret_key_123';
  const m2Secret = 'whsec_merchant_2_super_secret_key_456';

  beforeAll(async () => {
    await connectRedis();

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    const conn = await pool.getConnection();
    try {
      const email1 = `webhook_auth_m1_${Date.now()}@example.com`;
      const email2 = `webhook_auth_m2_${Date.now()}@example.com`;

      const [m1] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Webhook Auth Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = m1.insertId;

      const [m2] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Webhook Auth Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = m2.insertId;

      // Seed 1 endpoint for Merchant 1
      m1EndpointId = await createWebhookEndpoint(
        merchant1Id,
        'https://api.merchant1.example.com/webhooks',
        m1Secret
      );

      // Seed 1 delivery for Merchant 1
      await logWebhookDelivery(
        m1EndpointId,
        'payment.succeeded',
        { id: 'evt_m1_001', test: true },
        'success',
        200
      );

      // Seed 1 endpoint for Merchant 2
      m2EndpointId = await createWebhookEndpoint(
        merchant2Id,
        'https://api.merchant2.example.com/webhooks',
        m2Secret
      );

      // Seed 1 delivery for Merchant 2
      await logWebhookDelivery(
        m2EndpointId,
        'payment.failed',
        { id: 'evt_m2_001', test: true },
        'failed',
        500
      );

      // Generate signed JWT tokens for Merchant 1 personas (with correct id field)
      merchantDeveloperToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['merchant_developer']
      });

      merchantAdminToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['merchant_admin']
      });

      legacyMerchantToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['merchant']
      });

      merchantOperatorToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['merchant_operator']
      });

      financeAnalystToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['finance_analyst']
      });

      riskComplianceReviewerToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['risk_compliance_reviewer']
      });

      platformOperatorToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['platform_operator']
      });

      // Register temporary test role with webhook:read but lacking webhook:secret:read
      (ROLE_PERMISSIONS as Record<string, readonly string[]>)['test_webhook_reader'] = ['webhook:read'];
      readOnlySecretMaskedToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['test_webhook_reader']
      });

      // Register temporary test role with webhook:manage but lacking webhook:secret:read
      (ROLE_PERMISSIONS as Record<string, readonly string[]>)['test_webhook_manager_no_secret'] = ['webhook:manage'];
      managerNoSecretToken = signAccessToken({
        id: merchant1Id,
        email: email1,
        merchantName: 'Webhook Auth Merchant 1',
        roles: ['test_webhook_manager_no_secret']
      });

      // Merchant 2 Developer Token
      m2DeveloperToken = signAccessToken({
        id: merchant2Id,
        email: email2,
        merchantName: 'Webhook Auth Merchant 2',
        roles: ['merchant_developer']
      });
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    delete (ROLE_PERMISSIONS as Record<string, readonly string[]>)['test_webhook_reader'];
    delete (ROLE_PERMISSIONS as Record<string, readonly string[]>)['test_webhook_manager_no_secret'];
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectRedis();
    await closePool();
  });

  describe('1. GET /api/webhooks/endpoints Authorization', () => {
    it('allows merchant_developer (possesses webhook:read & webhook:secret:read) with unmasked secret', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { endpoints: Array<{ id: number; url: string; secret: string }> };
      expect(data.endpoints.length).toBeGreaterThanOrEqual(1);
      const found = data.endpoints.find((ep) => ep.id === m1EndpointId);
      expect(found).toBeDefined();
      expect(found?.secret).toBe(m1Secret);
    });

    it('allows merchant_admin with unmasked secret', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${merchantAdminToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { endpoints: Array<{ id: number; url: string; secret: string }> };
      const found = data.endpoints.find((ep) => ep.id === m1EndpointId);
      expect(found?.secret).toBe(m1Secret);
    });

    it('allows legacy merchant role with unmasked secret', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${legacyMerchantToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { endpoints: Array<{ id: number; url: string; secret: string }> };
      const found = data.endpoints.find((ep) => ep.id === m1EndpointId);
      expect(found?.secret).toBe(m1Secret);
    });

    it('rejects merchant_operator with 403 AUTH_FORBIDDEN (lacks webhook:read)', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${merchantOperatorToken}` }
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string; message: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
      expect(err.error.message).toContain('webhook:read');
    });

    it('rejects finance_analyst with 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${financeAnalystToken}` }
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
    });

    it('rejects risk_compliance_reviewer with 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
    });

    it('rejects platform_operator with 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
    });

    it('rejects unauthenticated request with 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`);

      expect(res.status).toBe(401);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_TOKEN_MISSING');
    });
  });

  describe('2. POST /api/webhooks/endpoints Authorization & Validation', () => {
    it('allows merchant_developer (possesses webhook:manage) to create endpoint', async () => {
      const testUrl = `https://merchant.example.com/webhooks/dev_${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${merchantDeveloperToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: testUrl })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { id: number; url: string; secret: string };
      expect(data.id).toBeTruthy();
      expect(data.url).toBe(testUrl);
      expect(data.secret).toMatch(/^whsec_[a-f0-9]{48}$/);
    });

    it('allows merchant_admin (possesses webhook:manage) to create endpoint', async () => {
      const testUrl = `https://merchant.example.com/webhooks/admin_${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${merchantAdminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: testUrl })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { id: number; url: string };
      expect(data.url).toBe(testUrl);
    });

    it('rejects merchant_operator with 403 AUTH_FORBIDDEN (lacks webhook:manage)', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${merchantOperatorToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: 'https://merchant.example.com/webhook' })
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string; message: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
      expect(err.error.message).toContain('webhook:manage');
    });

    it('rejects finance_analyst with 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${financeAnalystToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: 'https://merchant.example.com/webhook' })
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
    });

    it('rejects unauthenticated request with 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://merchant.example.com/webhook' })
      });

      expect(res.status).toBe(401);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('preserves SSRF validation under authorized user (rejects localhost)', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${merchantDeveloperToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: 'http://localhost:4000/api/webhooks/test-listener' })
      });

      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('VALIDATION_ERROR');
    });

    it('preserves SSRF validation under authorized user (rejects private IP 127.0.0.1)', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${merchantDeveloperToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: 'https://127.0.0.1/webhook' })
      });

      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('3. GET /api/webhooks/deliveries Authorization', () => {
    it('allows merchant_developer (possesses webhook:read)', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/deliveries`, {
        headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { deliveries: Array<{ id: number; eventType: string }> };
      expect(data.deliveries.length).toBeGreaterThanOrEqual(1);
      expect(data.deliveries[0]?.eventType).toBe('payment.succeeded');
    });

    it('allows merchant_admin (possesses webhook:read)', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/deliveries`, {
        headers: { Authorization: `Bearer ${merchantAdminToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { deliveries: Array<{ id: number }> };
      expect(data.deliveries.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects merchant_operator with 403 AUTH_FORBIDDEN (lacks webhook:read)', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/deliveries`, {
        headers: { Authorization: `Bearer ${merchantOperatorToken}` }
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string; message: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
      expect(err.error.message).toContain('webhook:read');
    });

    it('rejects finance_analyst with 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/deliveries`, {
        headers: { Authorization: `Bearer ${financeAnalystToken}` }
      });

      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_FORBIDDEN');
    });

    it('rejects unauthenticated request with 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/deliveries`);

      expect(res.status).toBe(401);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('AUTH_TOKEN_MISSING');
    });
  });

  describe('4. Tenant Isolation Enforcement', () => {
    it('merchant 2 developer cannot view merchant 1 endpoints', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${m2DeveloperToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { endpoints: Array<{ id: number; url: string }> };
      const endpointIds = data.endpoints.map((ep) => ep.id);
      expect(endpointIds).toContain(m2EndpointId);
      expect(endpointIds).not.toContain(m1EndpointId);
    });

    it('merchant 2 developer cannot view merchant 1 deliveries', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/deliveries`, {
        headers: { Authorization: `Bearer ${m2DeveloperToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { deliveries: Array<{ id: number; endpointId: number; eventType: string }> };
      const deliveryEndpointIds = data.deliveries.map((d) => d.endpointId);
      expect(deliveryEndpointIds).toContain(m2EndpointId);
      expect(deliveryEndpointIds).not.toContain(m1EndpointId);

      const eventTypes = data.deliveries.map((d) => d.eventType);
      expect(eventTypes).toContain('payment.failed');
      expect(eventTypes).not.toContain('payment.succeeded');
    });
  });

  describe('5. Secret Access Specifically Requires webhook:secret:read', () => {
    it('redacts secret to masked string when caller possesses webhook:read but lacks webhook:secret:read', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${readOnlySecretMaskedToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { endpoints: Array<{ id: number; secret: string }> };
      expect(data.endpoints.length).toBeGreaterThanOrEqual(1);
      const ep = data.endpoints.find((e) => e.id === m1EndpointId);
      expect(ep).toBeDefined();
      expect(ep?.secret).toBe('whsec_••••••••••••••••••••••••');
    });

    it('returns unmasked secret when caller possesses webhook:secret:read', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { endpoints: Array<{ id: number; secret: string }> };
      const ep = data.endpoints.find((e) => e.id === m1EndpointId);
      expect(ep).toBeDefined();
      expect(ep?.secret).toBe(m1Secret);
    });

    it('redacts secret on POST /api/webhooks/endpoints when caller has webhook:manage but lacks webhook:secret:read', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerNoSecretToken}`
        },
        body: JSON.stringify({ url: 'https://api.merchant1.example.com/webhooks/no-secret' })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { id: number; url: string; secret: string };
      expect(data.secret).toBe('whsec_••••••••••••••••••••••••');
    });

    it('returns unmasked secret on POST /api/webhooks/endpoints when caller has webhook:secret:read', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${merchantDeveloperToken}`
        },
        body: JSON.stringify({ url: 'https://api.merchant1.example.com/webhooks/with-secret' })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { id: number; url: string; secret: string };
      expect(data.secret).not.toBe('whsec_••••••••••••••••••••••••');
      expect(data.secret.startsWith('whsec_')).toBe(true);
    });
  });
});
