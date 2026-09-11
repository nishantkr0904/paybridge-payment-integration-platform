import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { closePool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { seedDeveloperDemo } from '../../demo/seed-developer-demo.js';

describe('Task 1 Verification: Seed Developer Demo', () => {
  let server: Server;
  let baseUrl: string;

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
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectRedis();
    await closePool();
  });

  let developerToken = '';

  async function getDeveloperToken(): Promise<string> {
    if (developerToken) return developerToken;
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'developer@paybridge.test',
        password: 'Developer123!'
      })
    });
    if (!loginRes.ok) {
      const errText = await loginRes.text();
      throw new Error(`Login failed with ${loginRes.status}: ${errText}`);
    }
    const body = (await loginRes.json()) as { accessToken: string };
    developerToken = body.accessToken;
    return developerToken;
  }

  it('1. seeds demo developer, endpoint, and deliveries idempotently', async () => {
    const run1 = await seedDeveloperDemo();
    expect(run1.email).toBe('developer@paybridge.test');
    expect(run1.role).toBe('merchant_developer');
    expect(run1.endpointUrl).toBe('https://api.merchant.example.com/webhooks/paybridge');
    expect(run1.deliveries).toHaveLength(3);

    const run2 = await seedDeveloperDemo();
    expect(run2.merchantId).toBe(run1.merchantId);
    expect(run2.endpointId).toBe(run1.endpointId);
    expect(run2.deliveries.map((d) => d.id)).toEqual(run1.deliveries.map((d) => d.id));
  });

  it('2. authenticates via POST /api/auth/login and receives merchant_developer role', async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'developer@paybridge.test',
        password: 'Developer123!'
      })
    });

    expect(loginRes.status).toBe(200);
    const body = (await loginRes.json()) as {
      user: { id: number; email: string; roles: string[]; merchantName: string };
      accessToken: string;
    };

    expect(body.user.email).toBe('developer@paybridge.test');
    expect(body.user.roles).toContain('merchant_developer');
    expect(body.user.merchantName).toBe("Arjun's Developer Store");
    expect(body.accessToken).toBeTruthy();
    developerToken = body.accessToken;
  });

  it('3. accesses GET /api/webhooks/endpoints and finds the seeded endpoint', async () => {
    const token = await getDeveloperToken();
    const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      endpoints: Array<{ id: number; url: string; isActive: number | boolean }>;
    };

    expect(body.endpoints.length).toBeGreaterThanOrEqual(1);
    const endpoint = body.endpoints.find((ep) => ep.url === 'https://api.merchant.example.com/webhooks/paybridge');
    expect(endpoint).toBeDefined();
    expect(Boolean(endpoint?.isActive)).toBe(true);
  });

  it('4. accesses GET /api/webhooks/deliveries and retrieves all 3 seeded deliveries with payloads intact', async () => {
    const token = await getDeveloperToken();
    const res = await fetch(`${baseUrl}/api/webhooks/deliveries`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliveries: Array<{
        id: number;
        endpointId: number;
        eventType: string;
        payload: { id?: string; type?: string; data?: Record<string, unknown> };
        status: string;
        responseStatus: number;
      }>;
    };

    expect(body.deliveries.length).toBeGreaterThanOrEqual(3);
    const eventTypes = body.deliveries.map((d) => d.eventType);
    expect(eventTypes).toContain('payment.succeeded');
    expect(eventTypes).toContain('payment.failed');
    expect(eventTypes).toContain('recovery.started');

    const paymentSucc = body.deliveries.find((d) => d.eventType === 'payment.succeeded');
    expect(paymentSucc?.status).toBe('success');
    expect(paymentSucc?.responseStatus).toBe(200);
    expect(paymentSucc?.payload.id).toBe('evt_demo_pay_succ_001');

    const paymentFail = body.deliveries.find((d) => d.eventType === 'payment.failed');
    expect(paymentFail?.status).toBe('failed');
    expect(paymentFail?.responseStatus).toBe(500);
    expect(paymentFail?.payload.id).toBe('evt_demo_pay_fail_002');

    const recStart = body.deliveries.find((d) => d.eventType === 'recovery.started');
    expect(recStart?.status).toBe('success');
    expect(recStart?.responseStatus).toBe(200);
    expect(recStart?.payload.id).toBe('evt_demo_rec_start_003');
  });

  it('5. rejects invalid localhost / SSRF endpoints with VALIDATION_ERROR', async () => {
    const token = await getDeveloperToken();
    const res = await fetch(`${baseUrl}/api/webhooks/endpoints`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: 'http://localhost:4000/api/webhooks/test-listener' })
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: { url?: string[] } };
      };
    };

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.fieldErrors?.url?.[0]).toContain('must use HTTPS');
  });
});
