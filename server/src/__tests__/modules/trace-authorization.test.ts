import type { Server } from 'node:http';
import type { ResultSetHeader } from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { signAccessToken } from '../../utils/token.js';
import {
  executeDiagnosisWithTrace,
  buildRecoveryContext
} from '../../modules/ai/index.js';
import { MockLLMProvider } from '../../infrastructure/llm/mock-provider.js';
import { ingestPaymentFailure } from '../../modules/recovery/case.service.js';
import type { PaymentFailedEvent } from '../../modules/recovery/case.types.js';
import { ROLE_PERMISSIONS } from '../../types/auth.js';
import { hasPermission } from '../../middleware/authorize.js';

describe('Phase B-1: Operator Trace Route-Level Authorization (/api/v1/ops/agent-traces)', () => {
  let server: Server;
  let baseUrl: string;
  let traceRef: string;
  let correlationId: string;
  let caseId: number;
  let merchantId: number;

  // Role tokens
  let platformOperatorToken: string;
  let merchantOperatorToken: string;
  let merchantDeveloperToken: string;
  let financeAnalystToken: string;
  let riskComplianceReviewerToken: string;
  let merchantAdminToken: string;
  let legacyMerchantToken: string;

  beforeAll(async () => {
    // 1. Seed merchant, order, transaction, recovery case, and agent trace
    correlationId = `01CORRAUTH${Date.now()}`;
    const merchantEmail = `trace_auth_m_${Date.now()}@example.com`;
    const [mResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (email, password_hash, merchant_name) VALUES (?, 'hash', 'Trace Auth Merchant')`,
      [merchantEmail]
    );
    merchantId = mResult.insertId;

    const [oResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 50000, 'INR', 'pending')`,
      [merchantId, `ORD_AUTH_${Date.now()}`]
    );
    const orderId = oResult.insertId;

    const txnRef = `TXN_AUTH_${Date.now()}`;
    const [tResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO transactions (order_id, txn_ref, amount, payment_method, status) VALUES (?, ?, 500.00, 'card', 'failed')`,
      [orderId, txnRef]
    );
    const txnId = tResult.insertId;

    const failureEvent: PaymentFailedEvent = {
      eventType: 'payment.failed',
      merchantId,
      orderId,
      transactionId: txnId,
      amount: 50000,
      currency: 'INR',
      failureCategory: 'TECHNICAL_TRANSIENT',
      failureReason: 'Upstream gateway timeout during auth',
      correlationId
    };

    const { case: recoveryCase } = await ingestPaymentFailure(failureEvent);
    caseId = recoveryCase.id;

    // Create a real persisted diagnosis trace
    const mockProvider = new MockLLMProvider();
    const context = await buildRecoveryContext({ caseId, merchantId });
    const { trace } = await executeDiagnosisWithTrace(
      { context, correlationId },
      mockProvider,
      merchantId,
      caseId
    );
    traceRef = trace.traceRef;

    // 2. Generate signed access tokens for all roles
    platformOperatorToken = signAccessToken({
      id: 88801,
      email: 'platform_operator@paybridge.internal',
      merchantName: 'PayBridge Platform Operations',
      roles: ['platform_operator']
    });

    merchantOperatorToken = signAccessToken({
      id: 88802,
      email: 'merchant_operator@example.com',
      merchantName: 'Test Merchant',
      roles: ['merchant_operator']
    });

    merchantDeveloperToken = signAccessToken({
      id: 88803,
      email: 'merchant_developer@example.com',
      merchantName: 'Test Merchant',
      roles: ['merchant_developer']
    });

    financeAnalystToken = signAccessToken({
      id: 88804,
      email: 'finance_analyst@example.com',
      merchantName: 'Test Merchant',
      roles: ['finance_analyst']
    });

    riskComplianceReviewerToken = signAccessToken({
      id: 88805,
      email: 'risk_compliance@example.com',
      merchantName: 'Test Merchant',
      roles: ['risk_compliance_reviewer']
    });

    merchantAdminToken = signAccessToken({
      id: 88806,
      email: 'merchant_admin@example.com',
      merchantName: 'Test Merchant',
      roles: ['merchant_admin']
    });

    legacyMerchantToken = signAccessToken({
      id: 88807,
      email: 'legacy_merchant@example.com',
      merchantName: 'Test Merchant',
      roles: ['merchant']
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
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Role/Permission Mapping Verification                              */
  /* ------------------------------------------------------------------ */

  describe('RBAC Canonical Mapping Verification for Operator Traces', () => {
    it('verifies that only platform_operator possesses ops:trace:read and ops:trace:replay', () => {
      expect(ROLE_PERMISSIONS.platform_operator).toContain('ops:trace:read');
      expect(ROLE_PERMISSIONS.platform_operator).toContain('ops:trace:replay');

      // Verify no other role has ops:trace:read
      expect(ROLE_PERMISSIONS.merchant).not.toContain('ops:trace:read');
      expect(ROLE_PERMISSIONS.merchant_admin).not.toContain('ops:trace:read');
      expect(ROLE_PERMISSIONS.merchant_operator).not.toContain('ops:trace:read');
      expect(ROLE_PERMISSIONS.merchant_developer).not.toContain('ops:trace:read');
      expect(ROLE_PERMISSIONS.finance_analyst).not.toContain('ops:trace:read');
      expect(ROLE_PERMISSIONS.risk_compliance_reviewer).not.toContain('ops:trace:read');

      // Verify no other role has ops:trace:replay
      expect(ROLE_PERMISSIONS.merchant).not.toContain('ops:trace:replay');
      expect(ROLE_PERMISSIONS.merchant_admin).not.toContain('ops:trace:replay');
      expect(ROLE_PERMISSIONS.merchant_operator).not.toContain('ops:trace:replay');
      expect(ROLE_PERMISSIONS.merchant_developer).not.toContain('ops:trace:replay');
      expect(ROLE_PERMISSIONS.finance_analyst).not.toContain('ops:trace:replay');
      expect(ROLE_PERMISSIONS.risk_compliance_reviewer).not.toContain('ops:trace:replay');
    });

    it('verifies ops:trace:read and ops:trace:replay are distinct permissions', () => {
      // Synthetic check ensuring read does not imply replay
      expect(hasPermission(['platform_operator'], 'ops:trace:read')).toBe(true);
      expect(hasPermission(['platform_operator'], 'ops:trace:replay')).toBe(true);
      expect(hasPermission(['merchant_operator'], 'ops:trace:read')).toBe(false);
      expect(hasPermission(['merchant_operator'], 'ops:trace:replay')).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  GET /api/v1/ops/agent-traces/:traceRef (Trace Read)               */
  /* ------------------------------------------------------------------ */

  describe('GET /api/v1/ops/agent-traces/:traceRef Authorization', () => {
    it('1. unauthenticated trace read -> 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`);
      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('2. platform_operator trace read -> 200 OK with full trace details', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { traceRef: string; steps: unknown[] };
      expect(data.traceRef).toBe(traceRef);
      expect(Array.isArray(data.steps)).toBe(true);
      expect(data.steps.length).toBeGreaterThanOrEqual(1);
    });

    it('3. merchant_operator trace read -> 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${merchantOperatorToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
      expect(data.error.message).toContain('Missing required permission(s): ops:trace:read');
    });

    it('4. merchant_developer trace read -> 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
      expect(data.error.message).toContain('Missing required permission(s): ops:trace:read');
    });

    it('5. finance_analyst trace read -> 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${financeAnalystToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
      expect(data.error.message).toContain('Missing required permission(s): ops:trace:read');
    });

    it('6. risk_compliance_reviewer trace read -> 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
      expect(data.error.message).toContain('Missing required permission(s): ops:trace:read');
    });

    it('6b. merchant_admin and legacy merchant trace read -> 403 AUTH_FORBIDDEN', async () => {
      const adminRes = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${merchantAdminToken}` }
      });
      expect(adminRes.status).toBe(403);

      const legacyRes = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${legacyMerchantToken}` }
      });
      expect(legacyRes.status).toBe(403);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  POST /api/v1/ops/agent-traces/:traceRef/replay (Trace Replay)     */
  /* ------------------------------------------------------------------ */

  describe('POST /api/v1/ops/agent-traces/:traceRef/replay Authorization', () => {
    it('7. platform_operator replay -> 200 OK with deterministic replay execution', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}/replay`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { isDeterministic: boolean; matchScore: number };
      expect(data.isDeterministic).toBe(true);
      expect(data.matchScore).toBe(1.0);
    });

    it('8. authenticated non-platform roles replay -> 403 AUTH_FORBIDDEN', async () => {
      const nonPlatformTokens = [
        { role: 'merchant_operator', token: merchantOperatorToken },
        { role: 'merchant_developer', token: merchantDeveloperToken },
        { role: 'finance_analyst', token: financeAnalystToken },
        { role: 'risk_compliance_reviewer', token: riskComplianceReviewerToken },
        { role: 'merchant_admin', token: merchantAdminToken },
        { role: 'merchant', token: legacyMerchantToken }
      ];

      for (const { role, token } of nonPlatformTokens) {
        const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}/replay`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        });
        expect(res.status, `Expected 403 for role ${role}`).toBe(403);
        const data = (await res.json()) as { error: { code: string; message: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
        expect(data.error.message).toContain('Missing required permission(s): ops:trace:replay');
      }
    });

    it('8b. unauthenticated trace replay -> 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/${traceRef}/replay`, {
        method: 'POST'
      });
      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe('AUTH_TOKEN_MISSING');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  GET /api/v1/ops/agent-traces/by-case/:caseId                      */
  /* ------------------------------------------------------------------ */

  describe('GET /api/v1/ops/agent-traces/by-case/:caseId Authorization', () => {
    it('9a. unauthenticated by-case read -> 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/by-case/${caseId}`);
      expect(res.status).toBe(401);
    });

    it('9b. platform_operator by-case read -> 200 OK', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/by-case/${caseId}`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as unknown[];
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('9c. non-platform roles by-case read -> 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/by-case/${caseId}`, {
        headers: { Authorization: `Bearer ${merchantOperatorToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  GET /api/v1/ops/agent-traces/by-correlation/:correlationId        */
  /* ------------------------------------------------------------------ */

  describe('GET /api/v1/ops/agent-traces/by-correlation/:correlationId Authorization', () => {
    it('10a. unauthenticated by-correlation read -> 401 AUTH_TOKEN_MISSING', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/by-correlation/${correlationId}`);
      expect(res.status).toBe(401);
    });

    it('10b. platform_operator by-correlation read -> 200 OK', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/by-correlation/${correlationId}`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as unknown[];
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('10c. non-platform roles by-correlation read -> 403 AUTH_FORBIDDEN', async () => {
      const res = await fetch(`${baseUrl}/api/v1/ops/agent-traces/by-correlation/${correlationId}`, {
        headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Duplicate Route Removal Verification (/api/ai/traces)             */
  /* ------------------------------------------------------------------ */

  describe('11. Duplicate Route /api/ai/traces Exposure Removal', () => {
    it('asserts that GET /api/ai/traces/:traceRef is no longer mounted (404)', async () => {
      const res = await fetch(`${baseUrl}/api/ai/traces/${traceRef}`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(404);
    });

    it('asserts that POST /api/ai/traces/:traceRef/replay is no longer mounted (404)', async () => {
      const res = await fetch(`${baseUrl}/api/ai/traces/${traceRef}/replay`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(404);
    });

    it('asserts that GET /api/ai/traces/by-case/:caseId is no longer mounted (404)', async () => {
      const res = await fetch(`${baseUrl}/api/ai/traces/by-case/${caseId}`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(404);
    });

    it('asserts that GET /api/ai/traces/by-correlation/:correlationId is no longer mounted (404)', async () => {
      const res = await fetch(`${baseUrl}/api/ai/traces/by-correlation/${correlationId}`, {
        headers: { Authorization: `Bearer ${platformOperatorToken}` }
      });
      expect(res.status).toBe(404);
    });
  });
});
