import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { signAccessToken } from '../../utils/token.js';
import {
  createPolicy,
  findActivePolicyByMerchantId,
  findPolicyById,
  findPoliciesByMerchantId,
  activatePolicy,
  deactivatePolicy
} from '../../modules/policy/policy.repository.js';
import { getActivePolicy, getPolicyById } from '../../modules/policy/policy.service.js';
import { HttpError } from '../../utils/http-error.js';

describe('TASK-201: Merchant Configuration CRUD (Phase 2 Milestone 2.1)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      const email1 = `policy_m1_${Date.now()}@example.com`;
      const email2 = `policy_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Policy Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Policy Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (res2 as unknown as { insertId: number }).insertId;
    } finally {
      conn.release();
    }

    token1 = signAccessToken({
      id: merchant1Id,
      email: 'm1@example.com',
      merchantName: 'Policy Merchant 1',
      roles: ['merchant']
    });

    token2 = signAccessToken({
      id: merchant2Id,
      email: 'm2@example.com',
      merchantName: 'Policy Merchant 2',
      roles: ['merchant']
    });

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    const conn = await pool.getConnection();
    try {
      if (merchant1Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant1Id]);
      if (merchant2Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant2Id]);
    } finally {
      conn.release();
    }

    await disconnectRedis();
  });

  describe('1. Repository-Level Policy CRUD & Tenant Scoping', () => {
    it('creates and reads merchant policy with explicit tenant scoping in SQL', async () => {
      const policy1 = await createPolicy(merchant1Id, {
        autonomyTier: 'T2',
        maxRetries: 4,
        maxContactsPerCustomerPerWeek: 5,
        dailyBudgetMinorUnits: 250000,
        maxIncentivePercent: 12.5,
        quietHoursStart: '22:00:00',
        quietHoursEnd: '08:00:00',
        timezone: 'Asia/Kolkata',
        isActive: true
      });

      expect(policy1.id).toBeDefined();
      expect(policy1.merchantId).toBe(merchant1Id);
      expect(policy1.autonomyTier).toBe('T2');
      expect(policy1.version).toBe(1);
      expect(policy1.dailyBudgetMinorUnits).toBe(250000);
      expect(policy1.isActive).toBe(true);

      // Same merchant lookup succeeds
      const ownPolicy = await findPolicyById(policy1.id, merchant1Id);
      expect(ownPolicy).not.toBeNull();
      expect(ownPolicy?.id).toBe(policy1.id);

      // Cross-merchant lookup returns NULL at SQL query boundary
      const foreignPolicy = await findPolicyById(policy1.id, merchant2Id);
      expect(foreignPolicy).toBeNull();
    });

    it('enforces single active policy invariant per merchant upon new version creation', async () => {
      // Create version 2 as active
      const v2 = await createPolicy(merchant1Id, {
        autonomyTier: 'T3',
        maxRetries: 2,
        isActive: true
      });

      expect(v2.version).toBe(2);
      expect(v2.isActive).toBe(true);

      // Verify version 1 was atomically deactivated
      const policies = await findPoliciesByMerchantId(merchant1Id);
      const activePolicies = policies.filter((p) => p.isActive);
      expect(activePolicies.length).toBe(1);
      expect(activePolicies[0].version).toBe(2);
    });

    it('activates and deactivates policies atomically scoped to merchant', async () => {
      const policies = await findPoliciesByMerchantId(merchant1Id);
      const v1 = policies.find((p) => p.version === 1);
      const v2 = policies.find((p) => p.version === 2);
      expect(v1).toBeDefined();
      expect(v2).toBeDefined();

      // Cross-merchant activation returns null (0 rows affected)
      const crossActivate = await activatePolicy(v1!.id, merchant2Id);
      expect(crossActivate).toBeNull();

      // Same-merchant activation succeeds and deactivates v2
      const activatedV1 = await activatePolicy(v1!.id, merchant1Id);
      expect(activatedV1).not.toBeNull();
      expect(activatedV1?.version).toBe(1);
      expect(activatedV1?.isActive).toBe(true);

      const activeNow = await findActivePolicyByMerchantId(merchant1Id);
      expect(activeNow?.version).toBe(1);

      // Deactivate v1
      const deactivated = await deactivatePolicy(v1!.id, merchant1Id);
      expect(deactivated).toBe(true);

      const activeAfterDeactivate = await findActivePolicyByMerchantId(merchant1Id);
      expect(activeAfterDeactivate).toBeNull();
    });
  });

  describe('2. Service-Level Policy Rules & Error Handling', () => {
    it('creates default baseline policy if none exists when getActivePolicy is called', async () => {
      const active = await getActivePolicy(merchant2Id);
      expect(active).toBeDefined();
      expect(active.merchantId).toBe(merchant2Id);
      expect(active.autonomyTier).toBe('T1');
      expect(active.version).toBe(1);
      expect(active.isActive).toBe(true);
    });

    it('throws 404 POLICY_NOT_FOUND when requesting foreign merchant policy by ID', async () => {
      const m2Policies = await findPoliciesByMerchantId(merchant2Id);
      const m2PolicyId = m2Policies[0].id;

      await expect(getPolicyById(m2PolicyId, merchant1Id)).rejects.toThrow(HttpError);
      try {
        await getPolicyById(m2PolicyId, merchant1Id);
      } catch (err) {
        expect((err as HttpError).statusCode).toBe(404);
        expect((err as HttpError).code).toBe('POLICY_NOT_FOUND');
      }
    });
  });

  describe('3. API Endpoints & Input Validation (/api/merchants/policies)', () => {
    it('GET /api/merchants/policies/active returns authenticated merchant active policy', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/policies/active`, {
        headers: { Authorization: `Bearer ${token2}` }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.merchantId).toBe(merchant2Id);
      expect(data.autonomyTier).toBe('T1');
      expect(data.isActive).toBe(true);
    });

    it('POST /api/merchants/policies creates a new valid policy', async () => {
      const payload = {
        autonomyTier: 'T3',
        maxRetries: 5,
        maxContactsPerCustomerPerWeek: 4,
        dailyBudgetMinorUnits: 100000,
        maxIncentivePercent: 15.0,
        quietHoursStart: '23:00:00',
        quietHoursEnd: '06:00:00',
        timezone: 'America/New_York',
        isActive: true
      };

      const res = await fetch(`${baseUrl}/api/merchants/policies`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.version).toBe(2);
      expect(data.autonomyTier).toBe('T3');
      expect(data.dailyBudgetMinorUnits).toBe(100000);
      expect(data.maxIncentivePercent).toBe(15.0);
      expect(data.timezone).toBe('America/New_York');
    });

    it('PUT /api/merchants/policies updates active configuration by creating next version', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/policies`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          autonomyTier: 'T4',
          maxIncentivePercent: 20.0
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.version).toBe(3);
      expect(data.autonomyTier).toBe('T4');
      expect(data.maxIncentivePercent).toBe(20.0);
      expect(data.isActive).toBe(true);
    });

    it('rejects invalid autonomy tiers with HTTP 400', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/policies`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ autonomyTier: 'T5' })
      });

      expect(res.status).toBe(400);
    });

    it('rejects invalid numeric bounds and time formats with HTTP 400', async () => {
      // Negative retries
      const res1 = await fetch(`${baseUrl}/api/merchants/policies`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ maxRetries: -1 })
      });
      expect(res1.status).toBe(400);

      // Incentive > 100%
      const res2 = await fetch(`${baseUrl}/api/merchants/policies`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ maxIncentivePercent: 150 })
      });
      expect(res2.status).toBe(400);

      // Invalid time format
      const res3 = await fetch(`${baseUrl}/api/merchants/policies`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ quietHoursStart: '28:99:99' })
      });
      expect(res3.status).toBe(400);
    });

    it('prevents cross-tenant access via API (returns 404 for foreign policy ID)', async () => {
      // Fetch Merchant 2's active policy
      const m2Active = await findActivePolicyByMerchantId(merchant2Id);
      expect(m2Active).not.toBeNull();

      // Merchant 1 attempts to fetch Merchant 2's policy by ID
      const getRes = await fetch(`${baseUrl}/api/merchants/policies/${m2Active!.id}`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(getRes.status).toBe(404);

      // Merchant 1 attempts to activate Merchant 2's policy
      const patchRes = await fetch(
        `${baseUrl}/api/merchants/policies/${m2Active!.id}/activate`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token1}` }
        }
      );
      expect(patchRes.status).toBe(404);

      // Merchant 1 attempts to deactivate Merchant 2's policy
      const deactRes = await fetch(
        `${baseUrl}/api/merchants/policies/${m2Active!.id}/deactivate`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token1}` }
        }
      );
      expect(deactRes.status).toBe(404);
    });
  });
});
