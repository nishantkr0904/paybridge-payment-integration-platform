import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app.js';
import { pool } from '../../../config/database.js';
import { connectRedis, disconnectRedis } from '../../../infrastructure/redis.js';
import { signAccessToken } from '../../../utils/token.js';
import { generateUlid } from '../../../utils/ulid.js';
import { createAgentTrace } from '../../../modules/ai/tracing/trace.repository.js';
import { transitionCaseStatus } from '../../../modules/recovery/case.repository.js';

describe('TASK-501: Case Triage Dashboard Routes & Operator Actions (RDB-001 / RDB-002 / AI-007 / RCV-004)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;

  let m1Case1Id: number; // in 'awaiting_approval'
  let m1Case2Id: number; // in 'detected'
  let m1Case3Id: number; // in 'recovered' (terminal)
  let m2CaseId: number;  // belonging to merchant 2
  let m1TraceRef: string;

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      const email1 = `triage_m1_${Date.now()}@example.com`;
      const email2 = `triage_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Triage Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Triage Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (res2 as unknown as { insertId: number }).insertId;

      const ord1Ref = generateUlid();
      const ord2Ref = generateUlid();
      const ord3Ref = generateUlid();
      const ordM2Ref = generateUlid();

      // Seed orders & transactions for Merchant 1
      const [ord1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 100000, 'INR', 'failed')`,
        [merchant1Id, ord1Ref]
      );
      const ord1Id = (ord1 as unknown as { insertId: number }).insertId;

      const [ord2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 50000, 'INR', 'failed')`,
        [merchant1Id, ord2Ref]
      );
      const ord2Id = (ord2 as unknown as { insertId: number }).insertId;

      const [ord3] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 25000, 'INR', 'failed')`,
        [merchant1Id, ord3Ref]
      );
      const ord3Id = (ord3 as unknown as { insertId: number }).insertId;

      // Seed order for Merchant 2
      const [ordM2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 75000, 'INR', 'failed')`,
        [merchant2Id, ordM2Ref]
      );
      const ordM2Id = (ordM2 as unknown as { insertId: number }).insertId;

      const case1Ref = generateUlid();
      const case2Ref = generateUlid();
      const case3Ref = generateUlid();
      const caseM2Ref = generateUlid();

      // Case 1 (Merchant 1): starts detected -> diagnosing -> deciding -> awaiting_approval
      const [c1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'detected', 100000, 'INR', 'payment_failed', 'insufficient_funds', 'corr-1')`,
        [merchant1Id, case1Ref, ord1Id]
      );
      m1Case1Id = (c1 as unknown as { insertId: number }).insertId;

      await conn.query(
        `INSERT INTO case_events (case_id, merchant_id, from_status, to_status, actor_type, actor_id, reason, correlation_id)
         VALUES (?, ?, NULL, 'detected', 'system', 'signal_worker', 'Initial failure detection', 'corr-1')`,
        [m1Case1Id, merchant1Id]
      );

      // Advance Case 1 to awaiting_approval
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'diagnosing',
        actorType: 'system',
        reason: 'Starting diagnosis',
        correlationId: 'corr-1'
      });
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'deciding',
        actorType: 'agent',
        actorId: 'diagnosis-agent',
        reason: 'Diagnosis completed',
        correlationId: 'corr-1'
      });
      await transitionCaseStatus(m1Case1Id, merchant1Id, {
        toStatus: 'awaiting_approval',
        actorType: 'agent',
        actorId: 'decision-agent',
        reason: 'Tier ceiling requires operator signoff',
        correlationId: 'corr-1'
      });

      // Case 2 (Merchant 1): detected status
      const [c2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'detected', 50000, 'INR', 'payment_failed', 'technical_error', 'corr-2')`,
        [merchant1Id, case2Ref, ord2Id]
      );
      m1Case2Id = (c2 as unknown as { insertId: number }).insertId;

      await conn.query(
        `INSERT INTO case_events (case_id, merchant_id, from_status, to_status, actor_type, actor_id, reason, correlation_id)
         VALUES (?, ?, NULL, 'detected', 'system', 'signal_worker', 'Initial failure detection', 'corr-2')`,
        [m1Case2Id, merchant1Id]
      );

      // Case 3 (Merchant 1): terminal recovered
      const [c3] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'recovered', 25000, 'INR', 'payment_failed', 'insufficient_funds', 'corr-3')`,
        [merchant1Id, case3Ref, ord3Id]
      );
      m1Case3Id = (c3 as unknown as { insertId: number }).insertId;

      // Merchant 2 Case
      const [cM2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'awaiting_approval', 75000, 'INR', 'payment_failed', 'insufficient_funds', 'corr-m2')`,
        [merchant2Id, caseM2Ref, ordM2Id]
      );
      m2CaseId = (cM2 as unknown as { insertId: number }).insertId;

      const traceRef = generateUlid();
      m1TraceRef = traceRef;

      // Seed an Agent Reasoning Trace for m1Case1Id
      await createAgentTrace({
        merchantId: merchant1Id,
        caseId: m1Case1Id,
        traceRef,
        agentType: 'decision',
        status: 'success',
        totalDurationMs: 450,
        totalInputTokens: 300,
        totalOutputTokens: 120,
        correlationId: 'corr-1',
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

    token1 = signAccessToken({
      id: merchant1Id,
      email: 'operator1@merchant1.com',
      merchantName: 'Triage Merchant 1',
      roles: ['merchant']
    });

    token2 = signAccessToken({
      id: merchant2Id,
      email: 'operator2@merchant2.com',
      merchantName: 'Triage Merchant 2',
      roles: ['merchant']
    });

    const app = createApp();
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectRedis();
  });

  describe('1. Case Listing & Filtering (RDB-001)', () => {
    it('enforces tenant isolation: merchant 1 cannot see merchant 2 cases', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.cases).toBeDefined();
      expect(data.cases.length).toBe(3);
      const caseIds = data.cases.map((c: { id: number }) => c.id);
      expect(caseIds).toContain(m1Case1Id);
      expect(caseIds).toContain(m1Case2Id);
      expect(caseIds).toContain(m1Case3Id);
      expect(caseIds).not.toContain(m2CaseId);
    });

    it('filters cases by status (e.g. ?status=awaiting_approval)', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases?status=awaiting_approval`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.cases.length).toBe(1);
      expect(data.cases[0].id).toBe(m1Case1Id);
      expect(data.cases[0].status).toBe('awaiting_approval');
    });

    it('supports pagination parameters (limit and offset)', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases?limit=2&offset=0`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.cases.length).toBe(2);
      expect(data.total).toBe(3);
      expect(data.limit).toBe(2);
      expect(data.offset).toBe(0);
    });

    it('verifies merchant 2 sees only their own case via token2', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases`, {
        headers: { Authorization: `Bearer ${token2}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.cases.length).toBe(1);
      expect(data.cases[0].id).toBe(m2CaseId);
    });
  });

  describe('2. Case Detail & Timeline (RDB-002)', () => {
    it('retrieves case detail by ID for authenticated merchant', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.case.id).toBe(m1Case1Id);
      expect(data.case.recoverableAmount).toBe(100000);
      expect(data.case.currency).toBe('INR');
    });

    it('rejects cross-tenant case detail access with 404', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m2CaseId}`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(404);
    });

    it('retrieves chronological timeline of events for case', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/timeline`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.timeline).toBeDefined();
      expect(data.timeline.length).toBeGreaterThanOrEqual(4);
      // Verify events are in chronological order (ascending IDs)
      for (let i = 1; i < data.timeline.length; i++) {
        expect(data.timeline[i].id).toBeGreaterThan(data.timeline[i - 1].id);
      }
      expect(data.timeline[0].toStatus).toBe('detected');
      expect(data.timeline[data.timeline.length - 1].toStatus).toBe('awaiting_approval');
    });

    it('rejects cross-tenant timeline access with 404', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m2CaseId}/timeline`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(404);
    });
  });

  describe('3. Prioritized Queue & Reasoning Traces (AI-007 / RCV-002)', () => {
    it('retrieves prioritized triage queue for authenticated merchant', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/queue`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.queue).toBeDefined();
      expect(Array.isArray(data.queue)).toBe(true);
    });

    it('retrieves agent reasoning traces linked to the case', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/traces`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.traces).toBeDefined();
      expect(data.traces.length).toBe(1);
      expect(data.traces[0].traceRef).toBe(m1TraceRef);
      expect(data.traces[0].steps[0].userPrompt).toContain('[REDACTED_EMAIL]');
    });

    it('rejects cross-tenant trace retrieval with 404', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m2CaseId}/traces`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(404);
    });
  });

  describe('4. Operator Actions & Human Approvals (RCV-004 / RDB-004)', () => {
    it('successfully APPROVES a case in awaiting_approval status (transitions to executing)', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'APPROVE',
          reason: 'Manual operator authorization after review'
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.case.status).toBe('executing');

      // Verify audit event record created in case_events
      const timelineRes = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/timeline`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      const timelineData = await timelineRes.json();
      const lastEvent = timelineData.timeline[timelineData.timeline.length - 1];
      expect(lastEvent.fromStatus).toBe('awaiting_approval');
      expect(lastEvent.toStatus).toBe('executing');
      expect(lastEvent.actorType).toBe('operator');
      expect(lastEvent.actorId).toBe('operator1@merchant1.com');
      expect(lastEvent.reason).toBe('Manual operator authorization after review');
    });

    it('rejects action with empty reason with 400 validation error', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case2Id}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'CLOSE',
          reason: '   '
        })
      });

      expect(res.status).toBe(400);
    });

    it('rejects illegal transition according to state machine (e.g. APPROVE on detected case)', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case2Id}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'APPROVE',
          reason: 'Premature approval attempt'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_CASE_TRANSITION');
    });

    it('rejects operator action on terminal case status (e.g. recovered) with 400', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case3Id}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'CLOSE',
          reason: 'Attempting to close an already recovered case'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_CASE_TRANSITION');
    });

    it('rejects cross-tenant operator action with 404', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m2CaseId}/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'APPROVE',
          reason: 'Unauthorized cross-tenant approval'
        })
      });

      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await fetch(`${baseUrl}/api/recovery/cases/${m1Case1Id}/actions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'APPROVE',
          reason: 'Unauthenticated attempt'
        })
      });

      expect(res.status).toBe(401);
    });
  });
});
