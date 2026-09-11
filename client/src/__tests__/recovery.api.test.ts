import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listRecoveryCases,
  getPrioritizedQueue,
  getRecoveryCase,
  getCaseTimeline,
  getCaseTraces,
  executeOperatorAction,
  exportCaseAuditTrail,
  getRecoveryAnalytics,
  getCaseExplainability,
  type RecoveryCase,
  type CaseEvent,
  type AgentTrace,
  type RecoveryAnalytics,
  type UnifiedExplainabilityPayload
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

  describe('8. getRecoveryAnalytics', () => {
    it('calls GET /recovery/analytics with query parameters and returns typed RecoveryAnalytics', async () => {
      const mockAnalytics: RecoveryAnalytics = {
        merchantId: 10,
        currency: 'INR',
        period: {
          startDate: '2026-09-01T00:00:00Z',
          endDate: '2026-09-11T23:59:59Z'
        },
        counts: {
          totalCases: 10,
          eligibleCases: 8,
          ineligibleCases: 2,
          totalAttempts: 12,
          successfulRecoveries: 6,
          unrecoveredCases: 2,
          suppressedCases: 1,
          inFlightCases: 1
        },
        revenue: {
          totalDetectedMinorUnits: 500000,
          addressableMinorUnits: 400000,
          nonAddressableMinorUnits: 100000,
          recoveredRevenueMinorUnits: 300000,
          unrecoveredRevenueMinorUnits: 70000,
          suppressedRevenueMinorUnits: 20000,
          inFlightRevenueMinorUnits: 10000
        },
        rates: {
          recoveryRate: 0.75,
          revenueRecoveryRate: 0.75,
          attemptRecoveryRate: 0.5,
          overallCaseRecoveryRate: 0.6
        },
        latency: {
          sampleSize: 6,
          avgDurationSeconds: 120,
          minDurationSeconds: 30,
          maxDurationSeconds: 300,
          p50DurationSeconds: 110,
          p90DurationSeconds: 250,
          p99DurationSeconds: 290
        },
        strategyPerformance: [
          {
            strategy: 'RETRY_PAYMENT',
            attempts: 8,
            successfulRecoveries: 5,
            recoveryRate: 0.625,
            recoveredRevenueMinorUnits: 250000
          }
        ],
        categoryPerformance: [
          {
            failureCategory: 'INSUFFICIENT_FUNDS',
            isAddressable: true,
            caseCount: 5,
            detectedMinorUnits: 250000,
            recoveredMinorUnits: 180000,
            suppressedMinorUnits: 0,
            unrecoveredMinorUnits: 50000,
            inFlightMinorUnits: 20000
          }
        ],
        reconciliation: {
          isReconciled: true,
          varianceMinorUnits: 0
        }
      };

      mockedApi.get.mockResolvedValueOnce({ data: mockAnalytics });

      const params = {
        startDate: '2026-09-01T00:00:00Z',
        endDate: '2026-09-11T23:59:59Z',
        currency: 'INR'
      };
      const result = await getRecoveryAnalytics(params);

      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/analytics', { params });
      expect(result.merchantId).toBe(10);
      expect(result.currency).toBe('INR');
      expect(result.counts.totalCases).toBe(10);
      expect(result.revenue.recoveredRevenueMinorUnits).toBe(300000);
      expect(result.rates.recoveryRate).toBe(0.75);
      expect(result.categoryPerformance[0].failureCategory).toBe('INSUFFICIENT_FUNDS');
      expect(result.strategyPerformance[0].strategy).toBe('RETRY_PAYMENT');
      expect(result.reconciliation.isReconciled).toBe(true);
    });

    it('calls GET /recovery/analytics without params when omitted', async () => {
      const mockAnalytics: RecoveryAnalytics = {
        merchantId: null,
        currency: 'INR',
        period: {},
        counts: {
          totalCases: 0,
          eligibleCases: 0,
          ineligibleCases: 0,
          totalAttempts: 0,
          successfulRecoveries: 0,
          unrecoveredCases: 0,
          suppressedCases: 0,
          inFlightCases: 0
        },
        revenue: {
          totalDetectedMinorUnits: 0,
          addressableMinorUnits: 0,
          nonAddressableMinorUnits: 0,
          recoveredRevenueMinorUnits: 0,
          unrecoveredRevenueMinorUnits: 0,
          suppressedRevenueMinorUnits: 0,
          inFlightRevenueMinorUnits: 0
        },
        rates: {
          recoveryRate: 0,
          revenueRecoveryRate: 0,
          attemptRecoveryRate: 0,
          overallCaseRecoveryRate: 0
        },
        latency: {
          sampleSize: 0,
          avgDurationSeconds: 0,
          minDurationSeconds: 0,
          maxDurationSeconds: 0,
          p50DurationSeconds: 0,
          p90DurationSeconds: 0,
          p99DurationSeconds: 0
        },
        strategyPerformance: [],
        categoryPerformance: [],
        reconciliation: {
          isReconciled: true,
          varianceMinorUnits: 0
        }
      };

      mockedApi.get.mockResolvedValueOnce({ data: mockAnalytics });

      const result = await getRecoveryAnalytics();
      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/analytics', { params: undefined });
      expect(result.counts.totalCases).toBe(0);
      expect(result.strategyPerformance).toEqual([]);
    });
  });

  describe('9. getCaseExplainability', () => {
    it('calls GET /recovery/cases/:idOrRef/explainability for numeric case ID', async () => {
      const mockPayload: UnifiedExplainabilityPayload = {
        case: {
          id: 42,
          caseRef: 'CASE_01XYZ42',
          merchantId: 10,
          orderId: 500,
          transactionId: 1000,
          status: 'awaiting_approval',
          recoverableAmountMinorUnits: 85000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILED',
          failureCategory: 'INSUFFICIENT_FUNDS',
          correlationId: '01CORR42',
          createdAt: '2026-09-03T12:00:00Z',
          updatedAt: '2026-09-03T12:05:00Z'
        },
        recoveryOutcome: {
          status: 'awaiting_approval',
          isTerminal: false,
          recoveredAmountMinorUnits: null,
          terminalReason: null,
          completedAt: null
        },
        diagnosis: {
          category: 'INSUFFICIENT_FUNDS',
          reasonCode: 'SOFT_DECLINE_BALANCE',
          rootCause: 'Account balance inadequate at time of presentation',
          contributingFactors: ['Month-end cycle', 'High traffic period'],
          recoverable: true,
          recommendedStrategy: 'DELAYED_RETRY',
          confidence: 0.92,
          explanation: 'Customer balance typically refreshes on salary credit cycle',
          evidence: ['Gateway code: 51', 'Issuer message: Insufficient funds'],
          provenance: {
            source: 'model',
            promptId: 'diag_prompt_v1',
            promptVersion: '1.0.0',
            modelId: 'gemini-1.5-pro',
            tokens: { inputTokens: 250, outputTokens: 90, totalTokens: 340 },
            latencyMs: 380,
            contextVersion: '1.0',
            rulesVersion: null,
            repairAttempted: false,
            fallbackReason: null
          }
        },
        decision: {
          planRationale: 'Scheduled delayed retry aligned with payday window',
          actions: [
            {
              actionType: 'RETRY_PAYMENT',
              toolName: 'schedule_payment_retry',
              scheduledDelaySeconds: 86400,
              costMinorUnits: 0,
              incentivePercent: 0,
              rationale: 'Execute retry after 24 hours',
              parameters: { channel: 'UPI' }
            }
          ],
          primaryAction: {
            actionType: 'RETRY_PAYMENT',
            toolName: 'schedule_payment_retry',
            scheduledDelaySeconds: 86400,
            costMinorUnits: 0,
            incentivePercent: 0,
            rationale: 'Execute retry after 24 hours',
            parameters: { channel: 'UPI' }
          },
          costOrderingRespect: true,
          provenance: {
            source: 'model',
            promptId: 'dec_prompt_v1',
            promptVersion: '1.0.0',
            modelId: 'gemini-1.5-pro',
            tokens: { inputTokens: 310, outputTokens: 120, totalTokens: 430 },
            latencyMs: 410,
            contextVersion: '1.0',
            diagnosisCategory: 'INSUFFICIENT_FUNDS',
            rulesVersion: null,
            repairAttempted: false,
            fallbackReason: null
          }
        },
        policy: {
          evaluation: {
            decision: 'REQUIRES_HUMAN',
            reasonCode: 'TIER_T2_ASSISTIVE',
            ruleId: 'AUTONOMY_T2_CHECK',
            message: 'Tier T2 requires operator approval before execution',
            policyId: 1,
            policyVersion: 1,
            evaluatedTier: 'T2',
            evaluatedAt: '2026-09-03T12:01:00Z',
            proposedAction: {
              actionType: 'RETRY_PAYMENT',
              costMinorUnits: 0,
              incentivePercent: 0
            },
            correlationId: '01CORR42'
          },
          governingPolicy: {
            id: 1,
            version: 1,
            autonomyTier: 'T2',
            isActive: true,
            maxRetries: 3,
            maxContactsPerCustomerPerWeek: 2,
            dailyBudgetMinorUnits: 500000,
            maxIncentivePercent: 10,
            quietHoursStart: '22:00',
            quietHoursEnd: '08:00',
            timezone: 'Asia/Kolkata'
          }
        },
        trace: {
          primaryTraceRef: 'TRACE_01XYZ',
          summary: {
            caseId: 42,
            traceRef: 'TRACE_01XYZ',
            agentType: 'diagnosis',
            status: 'success',
            rationaleSummary: 'Identified transient insufficient funds',
            recommendedAction: 'DELAYED_RETRY',
            isAutonomous: false,
            evaluatedTier: 'T2',
            completedAt: '2026-09-03T12:00:45Z',
            correlationId: '01CORR42'
          },
          traces: [
            {
              traceRef: 'TRACE_01XYZ',
              agentType: 'diagnosis',
              status: 'success',
              durationMs: 380,
              inputTokens: 250,
              outputTokens: 90,
              createdAt: '2026-09-03T12:00:30Z'
            }
          ]
        }
      };

      mockedApi.get.mockResolvedValueOnce({ data: mockPayload });

      const result = await getCaseExplainability(42);

      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases/42/explainability');
      expect(result.case.id).toBe(42);
      expect(result.case.recoverableAmountMinorUnits).toBe(85000);
      expect(result.diagnosis?.category).toBe('INSUFFICIENT_FUNDS');
      expect(result.decision?.primaryAction?.actionType).toBe('RETRY_PAYMENT');
      expect(result.policy?.evaluation?.decision).toBe('REQUIRES_HUMAN');
      expect(result.policy?.governingPolicy?.autonomyTier).toBe('T2');
      expect(result.trace?.summary?.isAutonomous).toBe(false);
    });

    it('calls GET /recovery/cases/:idOrRef/explainability for string caseRef with nullable fields', async () => {
      const mockPayload: UnifiedExplainabilityPayload = {
        case: {
          id: 43,
          caseRef: 'CASE_REF_STR_001',
          merchantId: 10,
          orderId: 501,
          transactionId: null,
          status: 'detected',
          recoverableAmountMinorUnits: 12000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILED',
          failureCategory: null,
          correlationId: '01CORR43',
          createdAt: '2026-09-03T12:10:00Z',
          updatedAt: '2026-09-03T12:10:00Z'
        },
        recoveryOutcome: {
          status: 'detected',
          isTerminal: false,
          recoveredAmountMinorUnits: null,
          terminalReason: null,
          completedAt: null
        },
        diagnosis: null,
        decision: null,
        policy: null,
        trace: null
      };

      mockedApi.get.mockResolvedValueOnce({ data: mockPayload });

      const result = await getCaseExplainability('CASE_REF_STR_001');

      expect(mockedApi.get).toHaveBeenCalledWith('/recovery/cases/CASE_REF_STR_001/explainability');
      expect(result.case.caseRef).toBe('CASE_REF_STR_001');
      expect(result.diagnosis).toBeNull();
      expect(result.decision).toBeNull();
      expect(result.policy).toBeNull();
      expect(result.trace).toBeNull();
    });
  });
});

