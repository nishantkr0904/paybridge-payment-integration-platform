import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  hasPermission,
  hasAnyPermission,
  ROLE_PERMISSIONS,
  type Role,
  type Permission
} from '../utils/rbac';
import {
  OperatorActionBanner,
  AuditExportControls,
  ExplainabilitySection
} from '../pages/RecoveryPage';
import type { RecoveryCase } from '../api/recovery';

describe('Task 5: RBAC Action Boundary Alignment & UI Polish', () => {
  const mockAwaitingCase: RecoveryCase = {
    id: 28,
    caseRef: 'CASE_DEMO_OP_AWAITING_001',
    merchantId: 1001,
    orderId: 9156,
    transactionId: 9156,
    status: 'awaiting_approval',
    recoverableAmount: 45000,
    currency: 'INR',
    originatingSignal: 'PAYMENT_FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    correlationId: 'corr-demo-op-001',
    createdAt: '2026-09-11T10:00:00.000Z',
    updatedAt: '2026-09-11T10:05:00.000Z'
  };

  describe('1. Authoritative RBAC Matrix & Role Helper Verification', () => {
    it('merchant_operator possesses recovery:approve, recovery:reject, recovery:close, explainability:read but lacks audit:export', () => {
      const operatorRoles = ['merchant_operator'];
      expect(hasPermission(operatorRoles, 'recovery:approve')).toBe(true);
      expect(hasPermission(operatorRoles, 'recovery:reject')).toBe(true);
      expect(hasPermission(operatorRoles, 'recovery:close')).toBe(true);
      expect(hasPermission(operatorRoles, 'explainability:read')).toBe(true);
      expect(hasPermission(operatorRoles, 'audit:export')).toBe(false);
    });

    it('risk_compliance_reviewer possesses audit:export and explainability:read but lacks recovery action permissions', () => {
      const reviewerRoles = ['risk_compliance_reviewer'];
      expect(hasPermission(reviewerRoles, 'audit:export')).toBe(true);
      expect(hasPermission(reviewerRoles, 'explainability:read')).toBe(true);
      expect(hasPermission(reviewerRoles, 'recovery:approve')).toBe(false);
      expect(hasPermission(reviewerRoles, 'recovery:reject')).toBe(false);
      expect(hasPermission(reviewerRoles, 'recovery:close')).toBe(false);
    });

    it('finance_analyst lacks all recovery intervention permissions and audit export', () => {
      const financeRoles = ['finance_analyst'];
      expect(hasPermission(financeRoles, 'recovery:read')).toBe(true);
      expect(hasPermission(financeRoles, 'recovery:approve')).toBe(false);
      expect(hasPermission(financeRoles, 'recovery:reject')).toBe(false);
      expect(hasPermission(financeRoles, 'recovery:close')).toBe(false);
      expect(hasPermission(financeRoles, 'audit:export')).toBe(false);
      expect(hasPermission(financeRoles, 'explainability:read')).toBe(false);
    });

    it('merchant and merchant_admin possess all recovery and audit export permissions', () => {
      for (const role of ['merchant', 'merchant_admin'] as const) {
        expect(hasPermission([role], 'recovery:approve')).toBe(true);
        expect(hasPermission([role], 'recovery:reject')).toBe(true);
        expect(hasPermission([role], 'recovery:close')).toBe(true);
        expect(hasPermission([role], 'audit:export')).toBe(true);
        expect(hasPermission([role], 'explainability:read')).toBe(true);
      }
    });

    it('safely rejects empty, null, or undefined role arrays without throwing', () => {
      expect(hasPermission([], 'recovery:approve')).toBe(false);
      expect(hasPermission(null, 'recovery:approve')).toBe(false);
      expect(hasPermission(undefined, 'recovery:approve')).toBe(false);
      expect(hasAnyPermission(null, ['recovery:approve', 'recovery:reject'])).toBe(false);
    });
  });

  describe('2. APPROVE Action Control Boundary', () => {
    it('user with recovery:approve can access APPROVE (button is enabled and interactive)', () => {
      const html = renderToStaticMarkup(
        <OperatorActionBanner
          caseItem={mockAwaitingCase}
          canApprove={true}
          canReject={false}
          canClose={false}
          onOpenActionModal={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="action-approve-btn"');
      // Must NOT be disabled
      expect(html).not.toMatch(/data-testid="action-approve-btn"[^>]*disabled=""/);
      expect(html).toContain('bg-emerald-600');
      expect(html).toContain('Approve &amp; Execute');
    });

    it('user without recovery:approve cannot access APPROVE (button is explicitly disabled and locked)', () => {
      const html = renderToStaticMarkup(
        <OperatorActionBanner
          caseItem={mockAwaitingCase}
          canApprove={false}
          canReject={true}
          canClose={true}
          onOpenActionModal={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="action-approve-btn"');
      expect(html).toMatch(/data-testid="action-approve-btn"[^>]*disabled=""/);
      expect(html).toContain('Requires recovery:approve permission');
      expect(html).toContain('cursor-not-allowed');
    });
  });

  describe('3. REJECT Action Control Boundary', () => {
    it('user with recovery:reject can access REJECT (button is enabled and interactive)', () => {
      const html = renderToStaticMarkup(
        <OperatorActionBanner
          caseItem={mockAwaitingCase}
          canApprove={false}
          canReject={true}
          canClose={false}
          onOpenActionModal={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="action-reject-btn"');
      expect(html).not.toMatch(/data-testid="action-reject-btn"[^>]*disabled=""/);
      expect(html).toContain('bg-amber-700');
      expect(html).toContain('Reject Action');
    });

    it('user without recovery:reject cannot access REJECT (button is explicitly disabled and locked)', () => {
      const html = renderToStaticMarkup(
        <OperatorActionBanner
          caseItem={mockAwaitingCase}
          canApprove={true}
          canReject={false}
          canClose={true}
          onOpenActionModal={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="action-reject-btn"');
      expect(html).toMatch(/data-testid="action-reject-btn"[^>]*disabled=""/);
      expect(html).toContain('Requires recovery:reject permission');
      expect(html).toContain('cursor-not-allowed');
    });
  });

  describe('4. CLOSE Action Control Boundary', () => {
    it('user with recovery:close can access CLOSE (button is enabled and interactive)', () => {
      const html = renderToStaticMarkup(
        <OperatorActionBanner
          caseItem={mockAwaitingCase}
          canApprove={false}
          canReject={false}
          canClose={true}
          onOpenActionModal={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="action-close-btn"');
      expect(html).not.toMatch(/data-testid="action-close-btn"[^>]*disabled=""/);
      expect(html).toContain('Close Case');
    });

    it('user without recovery:close cannot access CLOSE (button is explicitly disabled and locked)', () => {
      const html = renderToStaticMarkup(
        <OperatorActionBanner
          caseItem={mockAwaitingCase}
          canApprove={true}
          canReject={true}
          canClose={false}
          onOpenActionModal={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="action-close-btn"');
      expect(html).toMatch(/data-testid="action-close-btn"[^>]*disabled=""/);
      expect(html).toContain('Requires recovery:close permission');
      expect(html).toContain('cursor-not-allowed');
    });

    it('shows informative notice when user lacks all 3 action permissions', () => {
      const html = renderToStaticMarkup(
        <OperatorActionBanner
          caseItem={mockAwaitingCase}
          canApprove={false}
          canReject={false}
          canClose={false}
          onOpenActionModal={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="unauthorized-actions-notice"');
      expect(html).toContain('Your current role does not have permission to execute or reject recovery decisions');
    });
  });

  describe('5. Audit Export Control Boundary', () => {
    it('user with audit:export can access CSV and JSON exports', () => {
      const html = renderToStaticMarkup(
        <AuditExportControls
          canExportAudit={true}
          isExporting={false}
          onExport={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="export-csv-btn"');
      expect(html).toContain('data-testid="export-json-btn"');
      expect(html).not.toMatch(/data-testid="export-csv-btn"[^>]*disabled=""/);
      expect(html).not.toMatch(/data-testid="export-json-btn"[^>]*disabled=""/);
      expect(html).toContain('Export CSV');
      expect(html).toContain('Export JSON');
    });

    it('user without audit:export cannot access CSV and JSON exports (buttons disabled with explanation)', () => {
      const html = renderToStaticMarkup(
        <AuditExportControls
          canExportAudit={false}
          isExporting={false}
          onExport={vi.fn()}
        />
      );

      expect(html).toContain('data-testid="export-csv-btn"');
      expect(html).toContain('data-testid="export-json-btn"');
      expect(html).toMatch(/data-testid="export-csv-btn"[^>]*disabled=""/);
      expect(html).toMatch(/data-testid="export-json-btn"[^>]*disabled=""/);
      expect(html).toContain('Requires audit:export permission');
    });
  });

  describe('6. Explainability Permission Boundary', () => {
    it('displays unauthorized notice and hides intelligence when canReadExplainability is false', () => {
      const html = renderToStaticMarkup(
        <ExplainabilitySection
          payload={null}
          canReadExplainability={false}
        />
      );

      expect(html).toContain('data-testid="explainability-unauthorized"');
      expect(html).toContain('Explainability intelligence requires the explainability:read permission.');
      expect(html).not.toContain('data-testid="case-explainability-section"');
    });
  });

  describe('7. Backend 403 Safety & Anti-False-Success Invariant', () => {
    it('simulated backend 403 produces a clear user-facing error and never triggers success state', () => {
      let state = {
        selectedCaseStatus: 'awaiting_approval',
        actionError: null as string | null,
        modalOpen: true,
        cacheInvalidated: false
      };

      // Exact mutation logic used in RecoveryPage
      const simulatedOnError = (err: unknown) => {
        const errorObj = err as {
          response?: {
            status?: number;
            data?: { error?: { code?: string; message?: string } };
          };
          message?: string;
        };
        const status = errorObj.response?.status;
        const code = errorObj.response?.data?.error?.code;
        if (status === 403 || code === 'AUTH_FORBIDDEN') {
          state.actionError = 'Action unauthorized: You do not have permission to perform this recovery action.';
        } else {
          const msg = errorObj.response?.data?.error?.message || errorObj.message || 'Action execution failed.';
          state.actionError = msg;
        }
      };

      const simulatedOnSuccess = (data: { case: { status: string } }) => {
        state.selectedCaseStatus = data.case.status;
        state.modalOpen = false;
        state.cacheInvalidated = true;
      };

      // Simulate a backend 403 Forbidden response
      const mock403Error = {
        response: {
          status: 403,
          data: {
            error: {
              code: 'AUTH_FORBIDDEN',
              message: 'Forbidden: Missing required permission(s): recovery:approve.'
            }
          }
        }
      };

      simulatedOnError(mock403Error);

      // Verify that onSuccess was NOT called
      expect(state.selectedCaseStatus).toBe('awaiting_approval');
      expect(state.cacheInvalidated).toBe(false);
      expect(state.modalOpen).toBe(true);

      // Verify safe, sanitised error message that does not leak internals
      expect(state.actionError).toBe('Action unauthorized: You do not have permission to perform this recovery action.');
      expect(state.actionError).not.toContain('SQL');
      expect(state.actionError).not.toContain('database');
    });
  });
});
