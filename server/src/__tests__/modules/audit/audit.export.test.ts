import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import { createApp } from '../../../app.js';
import { pool } from '../../../config/database.js';
import { connectRedis, disconnectRedis } from '../../../infrastructure/redis.js';
import { signAccessToken } from '../../../utils/token.js';
import { generateUlid } from '../../../utils/ulid.js';
import { createAgentTrace } from '../../../modules/ai/tracing/trace.repository.js';
import { transitionCaseStatus } from '../../../modules/recovery/case.repository.js';
import { computeAuditSignature } from '../../../modules/audit/audit.service.js';

describe('TASK-502: Audit Trail Export Endpoint & Service (AUD-006 / RDB-002)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;

  let m1CaseId: number;
  let m1CaseRef: string;
  let m2CaseId: number;
  let m1TraceRef: string;

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      const email1 = `audit_m1_${Date.now()}@example.com`;
      const email2 = `audit_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Audit Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (res1 as unknown as { insertId: number }).insertId;

      const [res2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Audit Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (res2 as unknown as { insertId: number }).insertId;

      token1 = signAccessToken({ id: merchant1Id, email: email1, merchantName: 'Audit Merchant 1', roles: ['merchant'] });
      token2 = signAccessToken({ id: merchant2Id, email: email2, merchantName: 'Audit Merchant 2', roles: ['merchant'] });

      const ord1Ref = generateUlid();
      const ord2Ref = generateUlid();

      // Seed order for Merchant 1
      const [ord1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 75000, 'INR', 'failed')`,
        [merchant1Id, ord1Ref]
      );
      const ord1Id = (ord1 as unknown as { insertId: number }).insertId;

      // Seed order for Merchant 2
      const [ord2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 120000, 'INR', 'failed')`,
        [merchant2Id, ord2Ref]
      );
      const ord2Id = (ord2 as unknown as { insertId: number }).insertId;

      m1CaseRef = generateUlid();
      const m2CaseRef = generateUlid();

      // Case 1 (Merchant 1): starts detected
      const [c1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'detected', 75000, 'INR', 'payment_failed', 'insufficient_funds', '01AUD_CORR_1')`,
        [merchant1Id, m1CaseRef, ord1Id]
      );
      m1CaseId = (c1 as unknown as { insertId: number }).insertId;

      await conn.query(
        `INSERT INTO case_events (case_id, merchant_id, from_status, to_status, actor_type, actor_id, reason, payload, correlation_id)
         VALUES (?, ?, NULL, 'detected', 'system', 'payment-worker', 'Initial payment failure detection', '{"code":"51"}', '01AUD_CORR_1')`,
        [m1CaseId, merchant1Id]
      );

      // Advance Case 1: detected -> diagnosing -> deciding -> awaiting_approval -> executing
      await transitionCaseStatus(m1CaseId, merchant1Id, {
        toStatus: 'diagnosing',
        actorType: 'system',
        reason: 'Starting diagnosis',
        correlationId: '01AUD_CORR_2'
      });

      await transitionCaseStatus(m1CaseId, merchant1Id, {
        toStatus: 'deciding',
        actorType: 'agent',
        actorId: 'diagnosis-agent',
        reason: 'Diagnosis completed with 0.85 confidence',
        correlationId: '01AUD_CORR_3'
      });

      await transitionCaseStatus(m1CaseId, merchant1Id, {
        toStatus: 'awaiting_approval',
        actorType: 'agent',
        actorId: 'decision-agent',
        reason: 'Proposed retry requires human authorization under Tier T2',
        payload: { proposedAction: 'RETRY_WITH_INCENTIVE', discountPercent: 5 },
        correlationId: '01AUD_CORR_4'
      });

      await transitionCaseStatus(m1CaseId, merchant1Id, {
        toStatus: 'executing',
        actorType: 'operator',
        actorId: email1,
        reason: 'Authorized discount retry with customer phone confirmation',
        payload: { approvedBy: email1 },
        correlationId: '01AUD_CORR_5'
      });

      // Record agent trace for Merchant 1's case
      m1TraceRef = generateUlid();
      await createAgentTrace({
        traceRef: m1TraceRef,
        merchantId: merchant1Id,
        caseId: m1CaseId,
        agentType: 'diagnosis',
        status: 'success',
        totalDurationMs: 320,
        totalInputTokens: 250,
        totalOutputTokens: 80,
        correlationId: '01AUD_TRACE_CORR',
        steps: [
          {
            stepNumber: 1,
            stepType: 'model_completion',
            promptId: 'prompt_v1',
            modelId: 'gemini-1.5-pro',
            userPrompt: 'Customer email [REDACTED_EMAIL] reported failure code 51',
            rawResponse: '{"diagnosis": "INSUFFICIENT_FUNDS", "confidence": 0.85}',
            parsedOutput: { diagnosis: 'INSUFFICIENT_FUNDS', confidence: 0.85 },
            validationStatus: 'passed',
            durationMs: 320,
            inputTokens: 250,
            outputTokens: 80
          }
        ]
      });

      // Case 2 (Merchant 2)
      const [c2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id)
         VALUES (?, ?, ?, 'detected', 120000, 'INR', 'payment_failed', 'expired_card', '01AUD_CORR_M2')`,
        [merchant2Id, m2CaseRef, ord2Id]
      );
      m2CaseId = (c2 as unknown as { insertId: number }).insertId;

      await conn.query(
        `INSERT INTO case_events (case_id, merchant_id, from_status, to_status, actor_type, actor_id, reason, correlation_id)
         VALUES (?, ?, NULL, 'detected', 'system', 'payment-worker', 'Card expired', '01AUD_CORR_M2')`,
        [m2CaseId, merchant2Id]
      );
    } finally {
      conn.release();
    }

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server?.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectRedis();
  });

  describe('1. CSV Compliance Export (AUD-006 / RDB-002)', () => {
    it('exports certified CSV audit trail by numeric case ID', async () => {
      const res = await fetch(`${baseUrl}/api/audit/cases/${m1CaseId}/export?format=csv`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toContain(`audit-case-${m1CaseRef}`);
      expect(res.headers.get('x-audit-signature')).toBeDefined();
      expect(res.headers.get('x-export-id')).toMatch(/^EXP_/);

      const csv = await res.text();
      // Check metadata comments
      expect(csv).toContain('# PayBridge AI — Certified Case Audit Trail Export (AUD-006)');
      expect(csv).toContain(`# Merchant ID: ${merchant1Id}`);
      expect(csv).toContain(`# Case Ref: ${m1CaseRef}`);
      expect(csv).toContain('# Integrity Checksum (SHA-256):');

      // Check CSV column headers
      expect(csv).toContain('event_id,timestamp,case_id,case_ref,actor_type,actor_id,from_status,to_status,reason,payload,correlation_id');

      // Check chronological events in order
      expect(csv).toContain('payment-worker');
      expect(csv).toContain('diagnosis-agent');
      expect(csv).toContain('decision-agent');
      expect(csv).toContain('Authorized discount retry with customer phone confirmation');
    });

    it('exports certified CSV audit trail by string caseRef', async () => {
      const res = await fetch(`${baseUrl}/api/audit/cases/${m1CaseRef}/export`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      const csv = await res.text();
      expect(csv).toContain(m1CaseRef);
      expect(csv).toContain('executing');
    });
  });

  describe('2. JSON Compliance Export & Integrity Signature (AUD-006)', () => {
    it('exports certified JSON audit payload with valid SHA-256 signature', async () => {
      const res = await fetch(`${baseUrl}/api/audit/cases/${m1CaseId}/export?format=json`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const signatureHeader = res.headers.get('x-audit-signature');
      expect(signatureHeader).toBeDefined();

      const data = await res.json();
      expect(data.metadata.exportId).toMatch(/^EXP_/);
      expect(data.metadata.caseRef).toBe(m1CaseRef);
      expect(data.metadata.integritySignature).toBe(signatureHeader);
      expect(data.metadata.eventCount).toBe(5);
      expect(data.metadata.traceCount).toBe(1);

      // Verify case details
      expect(data.case.id).toBe(m1CaseId);
      expect(data.case.status).toBe('executing');
      expect(data.case.recoverableAmount).toBe(75000);

      // Verify events array
      expect(data.events.length).toBe(5);
      expect(data.events[0].toStatus).toBe('detected');
      expect(data.events[3].toStatus).toBe('awaiting_approval');
      expect(data.events[4].toStatus).toBe('executing');
      expect(data.events[4].actorType).toBe('operator');

      // Verify agent traces
      expect(data.traces.length).toBe(1);
      expect(data.traces[0].agentType).toBe('diagnosis');
      expect(data.traces[0].steps[0].userPrompt).toContain('[REDACTED_EMAIL]');

      // Verify cryptographic signature matches programmatic calculation
      const calculatedSignature = computeAuditSignature(
        data.case,
        data.events,
        data.traces,
        data.metadata.generatedAt
      );
      expect(data.metadata.integritySignature).toBe(calculatedSignature);
    });
  });

  describe('3. Tenant Isolation & Security (Invariants I5, I9)', () => {
    it('rejects cross-tenant export requests with 404 (Merchant 2 attempting Merchant 1 case)', async () => {
      const res = await fetch(`${baseUrl}/api/audit/cases/${m1CaseId}/export?format=csv`, {
        headers: { Authorization: `Bearer ${token2}` }
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('CASE_NOT_FOUND');
    });

    it('rejects unauthenticated export requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/audit/cases/${m1CaseId}/export`);
      expect(res.status).toBe(401);
    });

    it('rejects invalid export format query with 400', async () => {
      const res = await fetch(`${baseUrl}/api/audit/cases/${m1CaseId}/export?format=xml`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 for non-existent case identifier', async () => {
      const res = await fetch(`${baseUrl}/api/audit/cases/999999/export`, {
        headers: { Authorization: `Bearer ${token1}` }
      });
      expect(res.status).toBe(404);
    });
  });
});
