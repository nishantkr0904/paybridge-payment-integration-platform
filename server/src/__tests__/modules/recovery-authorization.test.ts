import type { Server } from 'node:http';
import type { ResultSetHeader } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { connectRabbitMQ, disconnectRabbitMQ } from '../../infrastructure/rabbitmq.js';
import { ROLE_PERMISSIONS, type Permission, type Role } from '../../types/auth.js';
import { hasPermission } from '../../middleware/authorize.js';
import { signAccessToken } from '../../utils/token.js';
import { generateUlid } from '../../utils/ulid.js';
import { transitionCaseStatus } from '../../modules/recovery/case.repository.js';
import { createAgentTrace } from '../../modules/ai/tracing/trace.repository.js';

describe('Phase B-3: Recovery Surface Route-Level Authorization', () => {
  let server: Server;
  let baseUrl: string;

  let merchant1Id: number;
  let merchant2Id: number;

  // Role tokens for Merchant 1
  let merchantAdminToken: string;
  let legacyMerchantToken: string;
  let merchantOperatorToken: string;
  let merchantDeveloperToken: string;
  let financeAnalystToken: string;
  let riskComplianceReviewerToken: string;

  // Platform Operator Token (global internal operations)
  let platformOperatorToken: string;

  // Test cases & trace data
  let m1Case1Id: number; // in 'awaiting_approval'
  let m1Case1Ref: string;
  let m1Case2Id: number; // in 'detected'
  let m1Case2Ref: string;
  let m2CaseId: number;  // belonging to merchant 2
  let m2CaseRef: string;
  let m1TraceRef: string;

  beforeAll(async () => {
    await connectRedis();
    await connectRabbitMQ();

    const conn = await pool.getConnection();
    try {
      const email1 = `rec_auth_m1_${Date.now()}@example.com`;
      const email2 = `rec_auth_m2_${Date.now()}@example.com`;

      const [m1] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Recovery Auth Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = m1.insertId;

      const [m2] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Recovery Auth Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = m2.insertId;

      // Seed orders
      const ord1Ref = generateUlid();
      const ord2Ref = generateUlid();
      const ordM2Ref = generateUlid();

      const [ord1] = await conn.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 50000, 'INR', 'failed')`,
        [merchant1Id, ord1Ref]
      );
      const [ord2] = await conn.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 25000, 'INR', 'failed')`,
        [merchant1Id, ord2Ref]
      );
      const [ordM2] = await conn.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 75000, 'INR', 'failed')`,
        [merchant2Id, ordM2Ref]
      );

      // Seed cases
      m1Case1Ref = generateUlid();
      m1Case2Ref = generateUlid();
      m2CaseRef = generateUlid();

      const [c1] = await conn.query<ResultSetHeader>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'detected', 50000, 'INR', 'payment_failed', 'insufficient_funds', 'corr-rec-1')`,
        [merchant1Id, m1Case1Ref, ord1.insertId]
      );
      m1Case1Id = c1.insertId;

      const [c2] = await conn.query<ResultSetHeader>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'detected', 25000, 'INR', 'payment_failed', 'gateway_timeout', 'corr-rec-2')`,
        [merchant1Id, m1Case2Ref, ord2.insertId]
      );
      m1Case2Id = c2.insertId;

      const [cM2] = await conn.query<ResultSetHeader>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'detected', 75000, 'INR', 'payment_failed', 'card_declined', 'corr-rec-m2')`,
        [merchant2Id, m2CaseRef, ordM2.insertId]
      );
      m2CaseId = cM2.insertId;

      // Seed case_events for Case 1
      await conn.query(
        `INSERT INTO case_events (case_id, merchant_id, from_status, to_status, actor_type, actor_id, reason, correlation_id)
         VALUES (?, ?, NULL, 'detected', 'system', 'signal_worker', 'Initial failure detection', 'corr-rec-1')`,
        [m1Case1Id, merchant1Id]
      );

      // Advance Case 1: detected -> diagnosing -> deciding -> awaiting_approval
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'diagnosing',
        actorType: 'system',
        actorId: 'test_engine',
        reason: 'Autonomous diagnosis',
        correlationId: 'corr-rec-1'
      });
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'deciding',
        actorType: 'system',
        actorId: 'test_engine',
        reason: 'Formulating decision',
        correlationId: 'corr-rec-1'
      });
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'awaiting_approval',
        actorType: 'system',
        actorId: 'test_engine',
        reason: 'Policy requires human sign-off',
        correlationId: 'corr-rec-1'
      });

      // Seed reasoning trace for Case 1
      m1TraceRef = generateUlid();
      await createAgentTrace({
        merchantId: merchant1Id,
        caseId: m1Case1Id,
        traceRef: m1TraceRef,
        agentType: 'decision',
        status: 'success',
        totalDurationMs: 450,
        totalInputTokens: 300,
        totalOutputTokens: 120,
        correlationId: 'corr-rec-1',
        steps: [
          {
            stepNumber: 1,
            stepType: 'model_completion',
            promptId: 'decision_prompt',
            promptVersion: '1.0',
            modelId: 'gpt-4o',
            systemPrompt: 'You are a recovery decision agent.',
            userPrompt: 'Diagnose case for customer [REDACTED_EMAIL]',
            rawResponse: '{"action": "RETRY_PAYMENT"}',
            parsedOutput: { actionType: 'RETRY_PAYMENT', explanation: 'Recoverable temporary decline' },
            validationStatus: 'passed',
            durationMs: 450,
            inputTokens: 300,
            outputTokens: 120
          }
        ]
      });
    } finally {
      conn.release();
    }

    // Generate tokens
    merchantAdminToken = signAccessToken({
      id: merchant1Id,
      email: 'm_admin@merchant.com',
      merchantName: 'Recovery Auth Merchant 1',
      roles: ['merchant_admin']
    });

    legacyMerchantToken = signAccessToken({
      id: merchant1Id,
      email: 'legacy@merchant.com',
      merchantName: 'Recovery Auth Merchant 1',
      roles: ['merchant']
    });

    merchantOperatorToken = signAccessToken({
      id: merchant1Id,
      email: 'm_op@merchant.com',
      merchantName: 'Recovery Auth Merchant 1',
      roles: ['merchant_operator']
    });

    merchantDeveloperToken = signAccessToken({
      id: merchant1Id,
      email: 'm_dev@merchant.com',
      merchantName: 'Recovery Auth Merchant 1',
      roles: ['merchant_developer']
    });

    financeAnalystToken = signAccessToken({
      id: merchant1Id,
      email: 'finance@merchant.com',
      merchantName: 'Recovery Auth Merchant 1',
      roles: ['finance_analyst']
    });

    riskComplianceReviewerToken = signAccessToken({
      id: merchant1Id,
      email: 'compliance@merchant.com',
      merchantName: 'Recovery Auth Merchant 1',
      roles: ['risk_compliance_reviewer']
    });

    platformOperatorToken = signAccessToken({
      id: 999991,
      email: 'platform_operator@paybridge.internal',
      merchantName: 'PayBridge Platform Operations',
      roles: ['platform_operator']
    });

    // Start HTTP test server
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

  afterEach(() => {
    // Ensure test roles are removed if modified during dynamic role tests
    delete (ROLE_PERMISSIONS as Record<string, unknown>).test_approver;
    delete (ROLE_PERMISSIONS as Record<string, unknown>).test_rejecter;
    delete (ROLE_PERMISSIONS as Record<string, unknown>).test_closer;
  });

  /* ------------------------------------------------------------------ */
  /*  Canonical Role-Permission Mapping Invariants                      */
  /* ------------------------------------------------------------------ */

  describe('RBAC Canonical Mapping Invariants for Recovery', () => {
    it('verifies recovery:read membership across all merchant-facing roles', () => {
      for (const role of [
        'merchant',
        'merchant_admin',
        'merchant_operator',
        'merchant_developer',
        'finance_analyst',
        'risk_compliance_reviewer'
      ] as const) {
        expect(hasPermission([role], 'recovery:read')).toBe(true);
      }
      expect(hasPermission(['platform_operator'], 'recovery:read')).toBe(false);
    });

    it('verifies explainability:read membership (reviewer and operator, NOT dev or finance)', () => {
      expect(hasPermission(['merchant_admin'], 'explainability:read')).toBe(true);
      expect(hasPermission(['merchant_operator'], 'explainability:read')).toBe(true);
      expect(hasPermission(['risk_compliance_reviewer'], 'explainability:read')).toBe(true);
      expect(hasPermission(['merchant_developer'], 'explainability:read')).toBe(false);
      expect(hasPermission(['finance_analyst'], 'explainability:read')).toBe(false);
      expect(hasPermission(['platform_operator'], 'explainability:read')).toBe(false);
    });

    it('verifies ledger:read membership (finance only among sub-roles)', () => {
      expect(hasPermission(['finance_analyst'], 'ledger:read')).toBe(true);
      expect(hasPermission(['merchant_admin'], 'ledger:read')).toBe(true);
      expect(hasPermission(['merchant_operator'], 'ledger:read')).toBe(false);
      expect(hasPermission(['merchant_developer'], 'ledger:read')).toBe(false);
      expect(hasPermission(['risk_compliance_reviewer'], 'ledger:read')).toBe(false);
      expect(hasPermission(['platform_operator'], 'ledger:read')).toBe(false);
    });

    it('verifies ops:shed:execute membership', () => {
      expect(hasPermission(['merchant_operator'], 'ops:shed:execute')).toBe(true);
      expect(hasPermission(['platform_operator'], 'ops:shed:execute')).toBe(true);
      expect(hasPermission(['merchant_developer'], 'ops:shed:execute')).toBe(false);
      expect(hasPermission(['finance_analyst'], 'ops:shed:execute')).toBe(false);
      expect(hasPermission(['risk_compliance_reviewer'], 'ops:shed:execute')).toBe(false);
    });

    it('verifies audit:export membership', () => {
      expect(hasPermission(['risk_compliance_reviewer'], 'audit:export')).toBe(true);
      expect(hasPermission(['merchant_admin'], 'audit:export')).toBe(true);
      expect(hasPermission(['merchant_operator'], 'audit:export')).toBe(false);
      expect(hasPermission(['merchant_developer'], 'audit:export')).toBe(false);
      expect(hasPermission(['finance_analyst'], 'audit:export')).toBe(false);
      expect(hasPermission(['platform_operator'], 'audit:export')).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Unauthenticated Boundary (401 AUTH_TOKEN_MISSING)                 */
  /* ------------------------------------------------------------------ */

  describe('Unauthenticated Boundary across Recovery Surface (401)', () => {
    const paths = [
      { method: 'GET', path: '/api/recovery/cases' },
      { method: 'GET', path: `/api/recovery/cases/1` },
      { method: 'GET', path: `/api/recovery/cases/1/timeline` },
      { method: 'GET', path: '/api/recovery/queue' },
      { method: 'GET', path: '/api/recovery/analytics' },
      { method: 'GET', path: `/api/recovery/cases/1/traces` },
      { method: 'GET', path: `/api/recovery/cases/1/explainability` },
      { method: 'POST', path: `/api/recovery/cases/1/actions`, body: { action: 'APPROVE', reason: 'Test' } },
      { method: 'GET', path: '/api/merchants/recovery/ledger' },
      { method: 'GET', path: '/api/merchants/recovery/analytics' },
      { method: 'GET', path: '/api/merchants/recovery/queue' },
      { method: 'GET', path: '/api/merchants/recovery/metrics' },
      { method: 'POST', path: '/api/merchants/recovery/shed', body: { capacityLimit: 10 } },
      { method: 'GET', path: `/api/merchants/recovery/cases/1/trace` },
      { method: 'POST', path: '/api/merchants/policies/evaluate', body: { action: { actionType: 'CLOSE_CASE' } } },
      { method: 'GET', path: `/api/audit/cases/1/export` }
    ];

    for (const { method, path, body } of paths) {
      it(`rejects unauthenticated ${method} ${path} with 401`, async () => {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        });
        expect(res.status).toBe(401);
        const data = (await res.json()) as { error: { code: string } };
        expect(data.error.code).toBe('AUTH_TOKEN_MISSING');
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Core /api/recovery Route Authorization Tests                      */
  /* ------------------------------------------------------------------ */

  describe('Core /api/recovery Authorization', () => {
    /* 1. GET /api/recovery/cases */
    describe('GET /api/recovery/cases (recovery:read)', () => {
      it('allows merchant_developer to list cases (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases`, {
          headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { cases: unknown[]; total: number };
        expect(Array.isArray(data.cases)).toBe(true);
      });

      it('allows legacy merchant role with wildcard permissions to list cases (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases`, {
          headers: { Authorization: `Bearer ${legacyMerchantToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { cases: unknown[]; total: number };
        expect(Array.isArray(data.cases)).toBe(true);
      });

      it('denies platform_operator from listing cases (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as { error: { code: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
      });
    });

    /* 2. GET /api/recovery/cases/:idOrRef */
    describe('GET /api/recovery/cases/:idOrRef (recovery:read)', () => {
      it('allows finance_analyst to retrieve case detail (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}`, {
          headers: { Authorization: `Bearer ${financeAnalystToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { case: { id: number } };
        expect(data.case.id).toBe(m1Case1Id);
      });

      it('allows retrieval by ULID reference', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Ref}`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { case: { caseRef: string } };
        expect(data.case.caseRef).toBe(m1Case1Ref);
      });

      it('denies platform_operator from reading case (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });

      it('preserves tenant isolation: returns 404 for another merchant case', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m2CaseId}`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(404);
      });
    });

    /* 3. GET /api/recovery/cases/:caseId/timeline */
    describe('GET /api/recovery/cases/:caseId/timeline (recovery:read)', () => {
      it('allows risk_compliance_reviewer to retrieve timeline (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/timeline`, {
          headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { timeline: unknown[] };
        expect(data.timeline.length).toBeGreaterThanOrEqual(1);
      });

      it('denies platform_operator on timeline (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/timeline`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 4. GET /api/recovery/queue */
    describe('GET /api/recovery/queue (recovery:read)', () => {
      it('allows merchant_operator to get prioritized queue (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/queue`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { queue: unknown[] };
        expect(Array.isArray(data.queue)).toBe(true);
      });

      it('denies platform_operator on queue (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/queue`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 5. GET /api/recovery/analytics */
    describe('GET /api/recovery/analytics (recovery:read)', () => {
      it('allows merchant_developer to get analytics (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
          headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { counts: unknown };
        expect(data.counts).toBeDefined();
      });

      it('denies platform_operator on analytics (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/analytics`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 6. GET /api/recovery/cases/:caseId/traces */
    describe('GET /api/recovery/cases/:caseId/traces (explainability:read)', () => {
      it('allows risk_compliance_reviewer to inspect reasoning traces (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/traces`, {
          headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { traces: { traceRef: string }[] };
        expect(data.traces.length).toBeGreaterThanOrEqual(1);
        expect(data.traces[0].traceRef).toBe(m1TraceRef);
      });

      it('allows merchant_operator to inspect traces (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/traces`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(200);
      });

      it('denies merchant_developer lacking explainability:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/traces`, {
          headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as { error: { code: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
      });

      it('denies finance_analyst lacking explainability:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/traces`, {
          headers: { Authorization: `Bearer ${financeAnalystToken}` }
        });
        expect(res.status).toBe(403);
      });

      it('denies platform_operator lacking explainability:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/traces`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 7. GET /api/recovery/cases/:idOrRef/explainability */
    describe('GET /api/recovery/cases/:idOrRef/explainability (explainability:read)', () => {
      it('allows risk_compliance_reviewer on unified explainability (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, {
          headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { case: { caseRef: string } };
        expect(data.case.caseRef).toBe(m1Case1Ref);
      });

      it('denies merchant_developer lacking explainability:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, {
          headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
        });
        expect(res.status).toBe(403);
      });

      it('denies finance_analyst lacking explainability:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/explainability`, {
          headers: { Authorization: `Bearer ${financeAnalystToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 8. POST /api/recovery/cases/:caseId/actions */
    describe('POST /api/recovery/cases/:caseId/actions (Action-specific authorization)', () => {
      it('allows merchant_operator with recovery:approve to APPROVE (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/actions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${merchantOperatorToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'APPROVE',
            reason: 'Operator approved recovery execution'
          })
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { case: { status: string } };
        expect(data.case.status).toBe('executing');
      });

      it('denies roles lacking all action permissions before parsing action (403 AUTH_FORBIDDEN)', async () => {
        for (const { name, token } of [
          { name: 'merchant_developer', token: merchantDeveloperToken },
          { name: 'finance_analyst', token: financeAnalystToken },
          { name: 'risk_compliance_reviewer', token: riskComplianceReviewerToken },
          { name: 'platform_operator', token: platformOperatorToken }
        ]) {
          const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/actions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'APPROVE',
              reason: 'Unauthorized test'
            })
          });
          expect(res.status, `Expected 403 for ${name}`).toBe(403);
          const data = (await res.json()) as { error: { code: string } };
          expect(data.error.code).toBe('AUTH_FORBIDDEN');
        }
      });

      it('retains 400 validation error for invalid action enum value', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/actions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${merchantOperatorToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'UNKNOWN_ACTION',
            reason: 'Invalid action payload'
          })
        });
        expect(res.status).toBe(400);
      });

      it('retains 400 validation error for missing reason', async () => {
        const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/actions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${merchantOperatorToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'CLOSE',
            reason: '   '
          })
        });
        expect(res.status).toBe(400);
      });

      it('disallows a role with recovery:approve from executing REJECT or CLOSE', async () => {
        // Create custom dynamic role with ONLY recovery:approve
        (ROLE_PERMISSIONS as Record<string, readonly Permission[]>).test_approver = ['recovery:approve'];
        const approverOnlyToken = signAccessToken({
          id: merchant1Id,
          email: 'approver_only@merchant.com',
          merchantName: 'Recovery Auth Merchant 1',
          roles: ['test_approver' as Role]
        });

        // REJECT should be denied with 403
        const rejectRes = await fetch(`${baseUrl}/api/recovery/cases/${m1Case2Id}/actions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${approverOnlyToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'REJECT',
            reason: 'Approver trying to reject'
          })
        });
        expect(rejectRes.status).toBe(403);
        const rejectData = (await rejectRes.json()) as { error: { message: string } };
        expect(rejectData.error.message).toContain('recovery:reject');

        // CLOSE should be denied with 403
        const closeRes = await fetch(`${baseUrl}/api/recovery/cases/${m1Case2Id}/actions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${approverOnlyToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'CLOSE',
            reason: 'Approver trying to close'
          })
        });
        expect(closeRes.status).toBe(403);
        const closeData = (await closeRes.json()) as { error: { message: string } };
        expect(closeData.error.message).toContain('recovery:close');
      });

      it('disallows a role with recovery:reject from executing APPROVE or CLOSE', async () => {
        // Create custom dynamic role with ONLY recovery:reject
        (ROLE_PERMISSIONS as Record<string, readonly Permission[]>).test_rejecter = ['recovery:reject'];
        const rejecterOnlyToken = signAccessToken({
          id: merchant1Id,
          email: 'rejecter_only@merchant.com',
          merchantName: 'Recovery Auth Merchant 1',
          roles: ['test_rejecter' as Role]
        });

        const approveRes = await fetch(`${baseUrl}/api/recovery/cases/${m1Case2Id}/actions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${rejecterOnlyToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'APPROVE',
            reason: 'Rejecter trying to approve'
          })
        });
        expect(approveRes.status).toBe(403);
        const approveData = (await approveRes.json()) as { error: { message: string } };
        expect(approveData.error.message).toContain('recovery:approve');
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Merchant-Mounted Recovery Routes Authorization (/api/merchants)   */
  /* ------------------------------------------------------------------ */

  describe('Merchant-Mounted Recovery Endpoints Authorization (/api/merchants)', () => {
    /* 9. GET /api/merchants/recovery/ledger (ledger:read) */
    describe('GET /api/merchants/recovery/ledger (ledger:read)', () => {
      it('allows finance_analyst on ledger (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
          headers: { Authorization: `Bearer ${financeAnalystToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { merchantId: number; totals: unknown };
        expect(data.merchantId).toBe(merchant1Id);
        expect(data.totals).toBeDefined();
      });

      it('allows merchant_admin on ledger (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
          headers: { Authorization: `Bearer ${merchantAdminToken}` }
        });
        expect(res.status).toBe(200);
      });

      it('denies merchant_operator lacking ledger:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as { error: { code: string; message: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
        expect(data.error.message).toContain('ledger:read');
      });

      it('denies merchant_developer and risk_compliance_reviewer lacking ledger:read (403)', async () => {
        const resDev = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
          headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
        });
        expect(resDev.status).toBe(403);

        const resComp = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
          headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
        });
        expect(resComp.status).toBe(403);
      });
    });

    /* 10. GET /api/merchants/recovery/analytics (recovery:read alias) */
    describe('GET /api/merchants/recovery/analytics (recovery:read alias)', () => {
      it('allows merchant_operator on merchant-mounted analytics (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/analytics`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { counts: unknown };
        expect(data.counts).toBeDefined();
      });

      it('denies platform_operator lacking recovery:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/analytics`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 11. GET /api/merchants/recovery/queue (recovery:read alias) */
    describe('GET /api/merchants/recovery/queue (recovery:read alias)', () => {
      it('allows merchant_operator on merchant-mounted queue (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/queue`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as unknown[];
        expect(Array.isArray(data)).toBe(true);
      });

      it('denies platform_operator lacking recovery:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/queue`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 12. GET /api/merchants/recovery/metrics (recovery:read) */
    describe('GET /api/merchants/recovery/metrics (recovery:read)', () => {
      it('allows finance_analyst on recovery metrics (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/metrics`, {
          headers: { Authorization: `Bearer ${financeAnalystToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { queueDepth: number };
        expect(typeof data.queueDepth).toBe('number');
      });

      it('denies platform_operator lacking recovery:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/metrics`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 13. POST /api/merchants/recovery/shed (ops:shed:execute) */
    describe('POST /api/merchants/recovery/shed (ops:shed:execute)', () => {
      it('allows merchant_operator with ops:shed:execute (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/shed`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${merchantOperatorToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ capacityLimit: 50 })
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { shedCount: number };
        expect(typeof data.shedCount).toBe('number');
      });

      it('allows platform_operator with ops:shed:execute (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/shed`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${platformOperatorToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ capacityLimit: 100 })
        });
        expect(res.status).toBe(200);
      });

      it('denies merchant_developer lacking ops:shed:execute (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/shed`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${merchantDeveloperToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ capacityLimit: 10 })
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as { error: { code: string; message: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
        expect(data.error.message).toContain('ops:shed:execute');
      });

      it('denies finance_analyst and risk_compliance_reviewer lacking ops:shed:execute (403)', async () => {
        const resFin = await fetch(`${baseUrl}/api/merchants/recovery/shed`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${financeAnalystToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ capacityLimit: 10 })
        });
        expect(resFin.status).toBe(403);

        const resComp = await fetch(`${baseUrl}/api/merchants/recovery/shed`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${riskComplianceReviewerToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ capacityLimit: 10 })
        });
        expect(resComp.status).toBe(403);
      });
    });

    /* 14. GET /api/merchants/recovery/cases/:caseId/trace (explainability:read) */
    describe('GET /api/merchants/recovery/cases/:caseId/trace (explainability:read)', () => {
      it('allows risk_compliance_reviewer on case trace summary (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/cases/${m1Case1Id}/trace`, {
          headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { traceRef: string; caseId: number };
        expect(data.caseId).toBe(m1Case1Id);
        expect(data.traceRef).toBe(m1TraceRef);
      });

      it('denies merchant_developer lacking explainability:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/cases/${m1Case1Id}/trace`, {
          headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as { error: { code: string; message: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
        expect(data.error.message).toContain('explainability:read');
      });

      it('denies platform_operator lacking explainability:read (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/recovery/cases/${m1Case1Id}/trace`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });
    });

    /* 15. POST /api/merchants/policies/evaluate (policy:evaluate) */
    describe('POST /api/merchants/policies/evaluate (policy:evaluate)', () => {
      it('allows merchant_operator with policy:evaluate (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${merchantOperatorToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: {
              actionType: 'CLOSE_CASE',
              caseRef: m1Case1Ref
            }
          })
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { decision: string };
        expect(data.decision).toBeDefined();
      });

      it('denies merchant_developer lacking policy:evaluate (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${merchantDeveloperToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: {
              actionType: 'CLOSE_CASE',
              caseRef: m1Case1Ref
            }
          })
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as { error: { code: string; message: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
        expect(data.error.message).toContain('policy:evaluate');
      });

      it('denies finance_analyst and risk_compliance_reviewer lacking policy:evaluate (403)', async () => {
        const resFin = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${financeAnalystToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: { actionType: 'CLOSE_CASE' }
          })
        });
        expect(resFin.status).toBe(403);

        const resComp = await fetch(`${baseUrl}/api/merchants/policies/evaluate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${riskComplianceReviewerToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: { actionType: 'CLOSE_CASE' }
          })
        });
        expect(resComp.status).toBe(403);
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Audit Export Authorization (/api/audit/cases/:idOrRef/export)     */
  /* ------------------------------------------------------------------ */

  describe('Audit Export Authorization (/api/audit/cases/:idOrRef/export)', () => {
    /* 16. GET /api/audit/cases/:idOrRef/export (audit:export) */
    describe('GET /api/audit/cases/:idOrRef/export (audit:export)', () => {
      it('allows risk_compliance_reviewer with audit:export (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/audit/cases/${m1Case1Id}/export?format=json`, {
          headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(res.headers.get('x-audit-signature')).toBeDefined();
      });

      it('allows merchant_admin with audit:export (200 OK)', async () => {
        const res = await fetch(`${baseUrl}/api/audit/cases/${m1Case1Id}/export?format=csv`, {
          headers: { Authorization: `Bearer ${merchantAdminToken}` }
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
      });

      it('denies merchant_operator lacking audit:export (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/audit/cases/${m1Case1Id}/export`, {
          headers: { Authorization: `Bearer ${merchantOperatorToken}` }
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as { error: { code: string; message: string } };
        expect(data.error.code).toBe('AUTH_FORBIDDEN');
        expect(data.error.message).toContain('audit:export');
      });

      it('denies merchant_developer lacking audit:export (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/audit/cases/${m1Case1Id}/export`, {
          headers: { Authorization: `Bearer ${merchantDeveloperToken}` }
        });
        expect(res.status).toBe(403);
      });

      it('denies finance_analyst lacking audit:export (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/audit/cases/${m1Case1Id}/export`, {
          headers: { Authorization: `Bearer ${financeAnalystToken}` }
        });
        expect(res.status).toBe(403);
      });

      it('denies platform_operator lacking audit:export (403 AUTH_FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/audit/cases/${m1Case1Id}/export`, {
          headers: { Authorization: `Bearer ${platformOperatorToken}` }
        });
        expect(res.status).toBe(403);
      });

      it('preserves tenant isolation: returns 404 for another merchant case', async () => {
        const res = await fetch(`${baseUrl}/api/audit/cases/${m2CaseId}/export`, {
          headers: { Authorization: `Bearer ${riskComplianceReviewerToken}` }
        });
        expect(res.status).toBe(404);
      });
    });
  });
});
