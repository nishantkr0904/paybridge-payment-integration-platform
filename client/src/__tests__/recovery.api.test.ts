import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listRecoveryCases,
  getPrioritizedQueue,
  getRecoveryCase,
  getCaseTimeline,
  getCaseTraces,
  executeOperatorAction,
  exportCaseAuditTrail,
  type RecoveryCase,
  type CaseEvent,
  type AgentTrace
} from '../api/recovery';
import { api } from '../api/client';

vi.mock('../api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}));

const mockedApi = vi.mocked(api);

describe('Recovery API Client (TASK-501 Frontend Scope)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. listRecoveryCases', () => {
    it('calls GET /recovery/cases with status and pagination parameters', async () => {
      const mockResponse = {
        data: {
          cases: [
            {
              id: 1,
              merchantId: 10,
              caseRef: 'CASE_01ABC',
              orderId: 100,
              status: 'awaiting_approval' as const,
              recoverableAmount: 50000,
              currency: 'INR',
              originatingSignal: 'PAYMENT_FAILED',
              failureCategory: 'CARD_DECLINED',
              correlationId: '01CORR123',
              createdAt: '2026-09-03T10:00:00Z',
              updatedAt: '2026-09-03T10:05:00Z'
            }
          ] as RecoveryCase[],
          total: 1,
          limit: 20,
          offset: 0
        }
      };

      mockedApi.get.mockResolvedValueOnce(mockResponse);

      const result = await listRecoveryCases({ status: 'awaiting_approval', limit: 20, offset: 0 });

      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases', {
        params: { status: 'awaiting_approval', limit: 20, offset: 0 }
      });
      expect(result.cases.length).toBe(1);
      expect(result.cases[0].status).toBe('awaiting_approval');
      expect(result.total).toBe(1);
    });

    it('calls GET /recovery/cases without params when omitted', async () => {
      mockedApi.get.mockResolvedValueOnce({
        data: { cases: [], total: 0, limit: 20, offset: 0 }
      });

      const result = await listRecoveryCases();
      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases', { params: undefined });
      expect(result.cases).toEqual([]);
    });
  });

  describe('2. getPrioritizedQueue', () => {
    it('calls GET /recovery/queue with queue limit and returns prioritized items', async () => {
      const mockQueueResponse = {
        data: {
          queue: [
            {
              case: {
                id: 5,
                merchantId: 10,
                caseRef: 'CASE_PRIORITY_1',
                orderId: 200,
                status: 'awaiting_approval' as const,
                recoverableAmount: 150000,
                currency: 'INR',
                originatingSignal: 'PAYMENT_FAILED',
                failureCategory: 'INSUFFICIENT_FUNDS',
                correlationId: '01CORR999',
                createdAt: '2026-09-03T11:00:00Z',
                updatedAt: '2026-09-03T11:02:00Z'
              },
              priorityScore: 92.5,
              breakdown: {
                baseValueScore: 75.0,
                urgencyScore: 10.0,
                propensityBonus: 5.0,
                tierWeight: 2.5
              },
              rankReason: 'High value recovery ($1500.00) with recent customer activity'
            }
          ],
          total: 1
        }
      };

      mockedApi.get.mockResolvedValueOnce(mockQueueResponse);

      const result = await getPrioritizedQueue({ limit: 50, maxPerMerchant: 10 });

      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/queue', {
        params: { limit: 50, maxPerMerchant: 10 }
      });
      expect(result.queue.length).toBe(1);
      expect(result.queue[0].priorityScore).toBe(92.5);
      expect(result.queue[0].case.caseRef).toBe('CASE_PRIORITY_1');
    });
  });

  describe('3. getRecoveryCase', () => {
    it('calls GET /recovery/cases/:idOrRef for numeric case ID', async () => {
      const mockCase: RecoveryCase = {
        id: 42,
        merchantId: 10,
        caseRef: 'CASE_42_REF',
        orderId: 500,
        status: 'executing',
        recoverableAmount: 85000,
        currency: 'INR',
        originatingSignal: 'PAYMENT_FAILED',
        failureCategory: 'NETWORK_TIMEOUT',
        correlationId: '01CORR42',
        createdAt: '2026-09-03T12:00:00Z',
        updatedAt: '2026-09-03T12:05:00Z'
      };

      mockedApi.get.mockResolvedValueOnce({ data: { case: mockCase } });

      const result = await getRecoveryCase(42);
      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases/42');
      expect(result.case.id).toBe(42);
      expect(result.case.status).toBe('executing');
    });

    it('calls GET /recovery/cases/:idOrRef for string caseRef', async () => {
      mockedApi.get.mockResolvedValueOnce({
        data: { case: { id: 42, caseRef: '01J6ABCXYZ12345' } }
      });

      const result = await getRecoveryCase('01J6ABCXYZ12345');
      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases/01J6ABCXYZ12345');
      expect(result.case.caseRef).toBe('01J6ABCXYZ12345');
    });
  });

  describe('4. getCaseTimeline (RDB-002)', () => {
    it('calls GET /recovery/cases/:caseId/timeline and returns chronological events', async () => {
      const mockTimeline: CaseEvent[] = [
        {
          id: 1,
          caseId: 42,
          merchantId: 10,
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'payment-worker',
          reason: 'Initial failure detected',
          payload: { gatewayCode: '504' },
          correlationId: '01CORR42',
          createdAt: '2026-09-03T12:00:00Z'
        },
        {
          id: 2,
          caseId: 42,
          merchantId: 10,
          fromStatus: 'detected',
          toStatus: 'awaiting_approval',
          actorType: 'agent',
          actorId: 'decision-agent',
          reason: 'Proposed retry exceeds autonomous spend tier limit',
          payload: { proposedAction: 'RETRY_WITH_INCENTIVE' },
          correlationId: '01CORR42',
          createdAt: '2026-09-03T12:01:00Z'
        }
      ];

      mockedApi.get.mockResolvedValueOnce({ data: { timeline: mockTimeline } });

      const result = await getCaseTimeline(42);
      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases/42/timeline');
      expect(result.timeline.length).toBe(2);
      expect(result.timeline[0].toStatus).toBe('detected');
      expect(result.timeline[1].toStatus).toBe('awaiting_approval');
      expect(result.timeline[1].actorType).toBe('agent');
    });
  });

  describe('5. getCaseTraces (AI-007 / RDB-003)', () => {
    it('calls GET /recovery/cases/:caseId/traces and returns reasoning traces with masked PII placeholders', async () => {
      const mockTraces: AgentTrace[] = [
        {
          id: 101,
          merchantId: 10,
          caseId: 42,
          traceRef: 'TRACE_01XYZ',
          agentType: 'diagnosis_agent',
          status: 'success',
          terminationReason: 'COMPLETED',
          totalDurationMs: 450,
          totalInputTokens: 320,
          totalOutputTokens: 110,
          correlationId: '01CORR42',
          createdAt: '2026-09-03T12:00:30Z',
          steps: [
            {
              stepNumber: 1,
              stepType: 'diagnose_failure',
              promptId: 'prompt_v1',
              modelId: 'gemini-1.5-pro',
              userPrompt: 'Customer email [REDACTED_EMAIL] reported failure code 504',
              parsedOutput: { diagnosis: 'TRANSIENT_GATEWAY_TIMEOUT', confidence: 0.95 },
              validationStatus: 'VALID',
              durationMs: 450,
              inputTokens: 320,
              outputTokens: 110
            }
          ]
        }
      ];

      mockedApi.get.mockResolvedValueOnce({ data: { traces: mockTraces } });

      const result = await getCaseTraces(42);
      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases/42/traces');
      expect(result.traces.length).toBe(1);
      expect(result.traces[0].agentType).toBe('diagnosis_agent');
      expect(result.traces[0].steps[0].userPrompt).toContain('[REDACTED_EMAIL]');
    });
  });

  describe('6. executeOperatorAction (RCV-004)', () => {
    it('calls POST /recovery/cases/:caseId/actions with APPROVE action and mandatory reason', async () => {
      const mockUpdatedCase: RecoveryCase = {
        id: 42,
        merchantId: 10,
        caseRef: 'CASE_42_REF',
        orderId: 500,
        status: 'executing',
        recoverableAmount: 85000,
        currency: 'INR',
        originatingSignal: 'PAYMENT_FAILED',
        failureCategory: 'NETWORK_TIMEOUT',
        correlationId: '01CORR42',
        createdAt: '2026-09-03T12:00:00Z',
        updatedAt: '2026-09-03T12:06:00Z'
      };

      mockedApi.post.mockResolvedValueOnce({ data: { case: mockUpdatedCase } });

      const result = await executeOperatorAction(
        42,
        'APPROVE',
        'Verified customer identity and approved manual retry'
      );

      expect(mockedApi.post).toHaveBeenCalledWith('/recovery/cases/42/actions', {
        action: 'APPROVE',
        reason: 'Verified customer identity and approved manual retry',
        payload: undefined
      });
      expect(result.case.status).toBe('executing');
    });

    it('calls POST /recovery/cases/:caseId/actions with REJECT action and mandatory reason', async () => {
      const mockSuppressedCase: RecoveryCase = {
        id: 42,
        merchantId: 10,
        caseRef: 'CASE_42_REF',
        orderId: 500,
        status: 'suppressed',
        recoverableAmount: 85000,
        currency: 'INR',
        originatingSignal: 'PAYMENT_FAILED',
        failureCategory: 'NETWORK_TIMEOUT',
        correlationId: '01CORR42',
        createdAt: '2026-09-03T12:00:00Z',
        updatedAt: '2026-09-03T12:07:00Z'
      };

      mockedApi.post.mockResolvedValueOnce({ data: { case: mockSuppressedCase } });

      const result = await executeOperatorAction(
        42,
        'REJECT',
        'Suspected fraudulent retry pattern - suppressing case'
      );

      expect(mockedApi.post).toHaveBeenCalledWith('/recovery/cases/42/actions', {
        action: 'REJECT',
        reason: 'Suspected fraudulent retry pattern - suppressing case',
        payload: undefined
      });
      expect(result.case.status).toBe('suppressed');
    });

    it('calls POST /recovery/cases/:caseId/actions with CLOSE action for administrative termination', async () => {
      const mockClosedCase: RecoveryCase = {
        id: 42,
        merchantId: 10,
        caseRef: 'CASE_42_REF',
        orderId: 500,
        status: 'suppressed',
        recoverableAmount: 85000,
        currency: 'INR',
        originatingSignal: 'PAYMENT_FAILED',
        failureCategory: 'NETWORK_TIMEOUT',
        correlationId: '01CORR42',
        createdAt: '2026-09-03T12:00:00Z',
        updatedAt: '2026-09-03T12:08:00Z'
      };

      mockedApi.post.mockResolvedValueOnce({ data: { case: mockClosedCase } });

      const result = await executeOperatorAction(
        42,
        'CLOSE',
        'Customer settled directly with offline bank transfer'
      );

      expect(mockedApi.post).toHaveBeenCalledWith('/recovery/cases/42/actions', {
        action: 'CLOSE',
        reason: 'Customer settled directly with offline bank transfer',
        payload: undefined
      });
      expect(result.case.status).toBe('suppressed');
    });
  });

  describe('7. exportCaseAuditTrail (TASK-502 / AUD-006)', () => {
    it('calls GET /audit/cases/:idOrRef/export with format=csv', async () => {
      const mockCsvContent = '# PayBridge AI — Certified Case Audit Trail Export\nevent_id,timestamp,case_id';
      mockedApi.get.mockResolvedValueOnce({
        data: mockCsvContent,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="audit-case-01J6ABC.csv"',
          'x-audit-signature': 'abc123def456'
        }
      });

      const result = await exportCaseAuditTrail('01J6ABC', 'csv');

      expect(mockedApi.get).toHaveBeenCalledWith('/audit/cases/01J6ABC/export', {
        params: { format: 'csv' },
        responseType: 'text'
      });
      expect(result.content).toBe(mockCsvContent);
      expect(result.contentType).toContain('text/csv');
      expect(result.filename).toBe('audit-case-01J6ABC.csv');
      expect(result.signature).toBe('abc123def456');
    });

    it('calls GET /audit/cases/:idOrRef/export with format=json', async () => {
      const mockJsonContent = JSON.stringify({ metadata: { exportId: 'EXP_123' } });
      mockedApi.get.mockResolvedValueOnce({
        data: mockJsonContent,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="audit-case-42.json"',
          'x-audit-signature': 'sig789'
        }
      });

      const result = await exportCaseAuditTrail(42, 'json');

      expect(mockedApi.get).toHaveBeenCalledWith('/audit/cases/42/export', {
        params: { format: 'json' },
        responseType: 'text'
      });
      expect(result.content).toBe(mockJsonContent);
      expect(result.contentType).toContain('application/json');
      expect(result.filename).toBe('audit-case-42.json');
      expect(result.signature).toBe('sig789');
    });
  });
});
