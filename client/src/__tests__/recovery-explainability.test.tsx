import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExplainabilitySection } from '../pages/RecoveryPage';
import type { UnifiedExplainabilityPayload } from '../api/recovery';

describe('Case Detail Explainability Drawer Section (Task 4 / BT-C4)', () => {
  const mockFullPayload: UnifiedExplainabilityPayload = {
    case: {
      id: 26,
      caseRef: 'CASE_DEMO_OP_AWAITING_001',
      merchantId: 10,
      orderId: 101,
      transactionId: 501,
      status: 'awaiting_approval',
      recoverableAmountMinorUnits: 45000,
      currency: 'INR',
      originatingSignal: 'PAYMENT_FAILED',
      failureCategory: 'INSUFFICIENT_FUNDS',
      correlationId: 'corr-demo-op-001',
      createdAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:05:00.000Z'
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
      contributingFactors: ['Month-end salary credit cycle', 'Customer recurring billings spike'],
      recoverable: true,
      recommendedStrategy: 'DELAYED_RETRY',
      confidence: 0.92,
      explanation: 'Customer account balance frequently refreshes around the 1st and 15th of the month.',
      evidence: ['Gateway response code: 51', 'Issuer message: Insufficient funds'],
      provenance: {
        source: 'model',
        promptId: 'prompt_diag_v1',
        promptVersion: '1.0.0',
        modelId: 'gemini-1.5-pro',
        tokens: { inputTokens: 250, outputTokens: 80, totalTokens: 330 },
        latencyMs: 380,
        contextVersion: '1.0',
        rulesVersion: null,
        repairAttempted: false,
        fallbackReason: null
      }
    },
    decision: {
      planRationale: 'Delay retry by 24h to align with probable payroll credit and offer 5% recovery discount.',
      actions: [
        {
          actionType: 'PAYMENT_LINK',
          toolName: 'send_recovery_link',
          scheduledDelaySeconds: 86400,
          costMinorUnits: 0,
          incentivePercent: 5,
          rationale: 'Send customer SMS payment link with 5% discount after 24h delay.',
          parameters: { channel: 'sms', template: 'recovery_incentive_v1' }
        }
      ],
      primaryAction: {
        actionType: 'PAYMENT_LINK',
        toolName: 'send_recovery_link',
        scheduledDelaySeconds: 86400,
        costMinorUnits: 0,
        incentivePercent: 5,
        rationale: 'Send customer SMS payment link with 5% discount after 24h delay.',
        parameters: { channel: 'sms', template: 'recovery_incentive_v1' }
      },
      costOrderingRespect: true,
      provenance: {
        source: 'model',
        promptId: 'prompt_dec_v1',
        promptVersion: '1.0.0',
        modelId: 'gemini-1.5-pro',
        tokens: { inputTokens: 310, outputTokens: 110, totalTokens: 420 },
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
        reasonCode: 'TIER_T2_HUMAN_REVIEW',
        ruleId: 'RULE_T2_ASSISTIVE',
        message: 'Tier T2 Assistive autonomy requires operator authorization before executing customer outreach.',
        policyId: 1,
        policyVersion: 1,
        evaluatedTier: 'T2',
        evaluatedAt: '2026-09-11T10:02:00.000Z',
        proposedAction: {
          actionType: 'PAYMENT_LINK',
          costMinorUnits: 0,
          incentivePercent: 5
        },
        correlationId: 'corr-demo-op-001'
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
      primaryTraceRef: 'TRACE_DEMO_001',
      summary: {
        caseId: 26,
        traceRef: 'TRACE_DEMO_001',
        agentType: 'diagnosis',
        status: 'success',
        rationaleSummary: 'Identified transient insufficient funds',
        recommendedAction: 'PAYMENT_LINK',
        isAutonomous: false,
        evaluatedTier: 'T2',
        completedAt: '2026-09-11T10:01:00.000Z',
        correlationId: 'corr-demo-op-001'
      },
      traces: [
        {
          traceRef: 'TRACE_DEMO_001',
          agentType: 'diagnosis',
          status: 'success',
          durationMs: 380,
          inputTokens: 250,
          outputTokens: 80,
          createdAt: '2026-09-11T10:00:30.000Z'
        }
      ]
    }
  };

  describe('1. Full Explainability Payload Rendering', () => {
    it('renders the complete unified explainability section with all 4 sub-cards', () => {
      const html = renderToStaticMarkup(
        <ExplainabilitySection payload={mockFullPayload} isLoading={false} isError={false} />
      );

      // Section heading & Case Ref
      expect(html).toContain('Unified Recovery Explainability');
      expect(html).toContain('Ref: CASE_DEMO_OP_AWAITING_001');

      // 1. Failure Context
      expect(html).toContain('1. Failure Context');
      expect(html).toContain('PAYMENT_FAILED');
      expect(html).toContain('INSUFFICIENT_FUNDS');
      expect(html).toContain('#101');
      expect(html).toContain('Tx #501');
      expect(html).toContain('Active (awaiting_approval)');

      // 2. Diagnostic Conclusion
      expect(html).toContain('2. Agent Diagnostic Conclusion');
      expect(html).toContain('92% confidence');
      expect(html).toContain('Account balance inadequate at time of presentation');
      expect(html).toContain('Customer account balance frequently refreshes around the 1st and 15th of the month.');
      expect(html).toContain('INSUFFICIENT_FUNDS (SOFT_DECLINE_BALANCE)');
      expect(html).toContain('Recoverable');
      expect(html).toContain('DELAYED_RETRY');
      expect(html).toContain('Month-end salary credit cycle');
      expect(html).toContain('Gateway response code: 51');
      expect(html).toContain('Source: model');
      expect(html).toContain('Model: gemini-1.5-pro');

      // 3. Proposed Action & Plan
      expect(html).toContain('3. Proposed Recovery Action');
      expect(html).toContain('PAYMENT_LINK');
      expect(html).toContain('Tool: send_recovery_link');
      expect(html).toContain('Delay: 86400s');
      expect(html).toContain('5% discount');
      expect(html).toContain('Send customer SMS payment link with 5% discount after 24h delay.');
      expect(html).toContain('Delay retry by 24h to align with probable payroll credit and offer 5% recovery discount.');

      // 4. Governing Policy & Evaluation
      expect(html).toContain('4. Governing Policy &amp; Autonomy Evaluation');
      expect(html).toContain('Requires Human Review');
      expect(html).toContain('Rule: RULE_T2_ASSISTIVE');
      expect(html).toContain('Tier T2 Assistive autonomy requires operator authorization before executing customer outreach.');
      expect(html).toContain('Reason Code:');
      expect(html).toContain('TIER_T2_HUMAN_REVIEW');
      expect(html).toContain('Active Policy Bounds (Tier T2)');
      expect(html).toContain('Max Retries');
      expect(html).toContain('Max Incentive');
      expect(html).toContain('10%');
      expect(html).toContain('22:00 - 08:00');
    });

    it('renders terminal outcome reason correctly when case is terminal', () => {
      const terminalPayload: UnifiedExplainabilityPayload = {
        ...mockFullPayload,
        case: {
          ...mockFullPayload.case,
          status: 'recovered'
        },
        recoveryOutcome: {
          status: 'recovered',
          isTerminal: true,
          recoveredAmountMinorUnits: 45000,
          terminalReason: 'Payment captured successfully via customer SMS link',
          completedAt: '2026-09-11T12:00:00.000Z'
        }
      };

      const html = renderToStaticMarkup(<ExplainabilitySection payload={terminalPayload} />);
      expect(html).toContain('Payment captured successfully via customer SMS link');
    });
  });

  describe('2. Policy Decision Variations', () => {
    it('renders Autonomously Approved badge for APPROVED decisions', () => {
      const approvedPayload: UnifiedExplainabilityPayload = {
        ...mockFullPayload,
        policy: {
          ...mockFullPayload.policy!,
          evaluation: {
            ...mockFullPayload.policy!.evaluation!,
            decision: 'APPROVED',
            message: 'Action within Tier T3 autonomous spend bounds.'
          }
        }
      };

      const html = renderToStaticMarkup(<ExplainabilitySection payload={approvedPayload} />);
      expect(html).toContain('Autonomously Approved');
      expect(html).toContain('Action within Tier T3 autonomous spend bounds.');
    });

    it('renders Policy Rejected badge for REJECTED decisions', () => {
      const rejectedPayload: UnifiedExplainabilityPayload = {
        ...mockFullPayload,
        policy: {
          ...mockFullPayload.policy!,
          evaluation: {
            ...mockFullPayload.policy!.evaluation!,
            decision: 'REJECTED',
            message: 'Incentive exceeds merchant configured threshold.'
          }
        }
      };

      const html = renderToStaticMarkup(<ExplainabilitySection payload={rejectedPayload} />);
      expect(html).toContain('Policy Rejected');
      expect(html).toContain('Incentive exceeds merchant configured threshold.');
    });
  });

  describe('3. Null / Partial Explainability Handling (Requirement 5)', () => {
    it('renders explicit neutral "not available" state when diagnosis is null', () => {
      const nullDiagPayload: UnifiedExplainabilityPayload = {
        ...mockFullPayload,
        diagnosis: null
      };

      const html = renderToStaticMarkup(<ExplainabilitySection payload={nullDiagPayload} />);
      expect(html).toContain('data-testid="diagnosis-not-available"');
      expect(html).toContain('Diagnosis data not available for this case.');
    });

    it('renders explicit neutral "not available" state when decision is null', () => {
      const nullDecisionPayload: UnifiedExplainabilityPayload = {
        ...mockFullPayload,
        decision: null
      };

      const html = renderToStaticMarkup(<ExplainabilitySection payload={nullDecisionPayload} />);
      expect(html).toContain('data-testid="decision-not-available"');
      expect(html).toContain('Decision plan not available for this case.');
    });

    it('renders explicit neutral "not available" state when policy is null', () => {
      const nullPolicyPayload: UnifiedExplainabilityPayload = {
        ...mockFullPayload,
        policy: null
      };

      const html = renderToStaticMarkup(<ExplainabilitySection payload={nullPolicyPayload} />);
      expect(html).toContain('data-testid="policy-not-available"');
      expect(html).toContain('Policy evaluation not available for this case.');
    });

    it('renders empty fallback when entire payload is null or undefined', () => {
      const html = renderToStaticMarkup(<ExplainabilitySection payload={null} />);
      expect(html).toContain('data-testid="explainability-empty"');
      expect(html).toContain('No explainability data available for this case.');
    });
  });

  describe('4. Loading & Error States (Requirement 10)', () => {
    it('renders loading skeleton when isLoading is true', () => {
      const html = renderToStaticMarkup(
        <ExplainabilitySection isLoading={true} isError={false} payload={null} />
      );

      expect(html).toContain('data-testid="explainability-loading"');
      expect(html).toContain('animate-pulse');
      expect(html).not.toContain('Unified Recovery Explainability');
    });

    it('renders error banner with retry button when isError is true', () => {
      const handleRetry = vi.fn();
      const html = renderToStaticMarkup(
        <ExplainabilitySection isLoading={false} isError={true} onRetry={handleRetry} />
      );

      expect(html).toContain('data-testid="explainability-error"');
      expect(html).toContain('Failed to load explainability intelligence for this case.');
      expect(html).toContain('Retry');
    });
  });

  describe('5. Stale Data Prevention Logic (Requirement 11)', () => {
    it('verifies case identity matching prevents rendering data from another case', () => {
      const selectedCaseId = 42;
      const cachedExplainability = mockFullPayload; // case.id is 26

      // Guard logic identical to RecoveryPage:
      const isStale = cachedExplainability.case.id !== selectedCaseId;
      const currentPayload = isStale ? null : cachedExplainability;

      const html = renderToStaticMarkup(
        <ExplainabilitySection payload={currentPayload} isLoading={isStale} />
      );

      // Must show loading state and NOT render Case 26's data
      expect(html).toContain('data-testid="explainability-loading"');
      expect(html).not.toContain('CASE_DEMO_OP_AWAITING_001');
    });
  });
});
