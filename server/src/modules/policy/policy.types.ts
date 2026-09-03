export type AutonomyTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';

export interface Policy {
  id: number;
  merchantId: number;
  autonomyTier: AutonomyTier;
  maxRetries: number;
  maxContactsPerCustomerPerWeek: number;
  dailyBudgetMinorUnits: number;
  maxIncentivePercent: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePolicyInput {
  autonomyTier?: AutonomyTier;
  maxRetries?: number;
  maxContactsPerCustomerPerWeek?: number;
  dailyBudgetMinorUnits?: number;
  maxIncentivePercent?: number;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string;
  isActive?: boolean;
}

export interface UpdatePolicyInput {
  autonomyTier?: AutonomyTier;
  maxRetries?: number;
  maxContactsPerCustomerPerWeek?: number;
  dailyBudgetMinorUnits?: number;
  maxIncentivePercent?: number;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string;
  isActive?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Policy Engine & Evaluation Types (POL-002 / AT-POL-001)           */
/* ------------------------------------------------------------------ */

export type ActionType =
  | 'RETRY_PAYMENT'
  | 'CUSTOMER_OUTREACH'
  | 'OFFER_INCENTIVE'
  | 'REQUEST_PAYMENT_METHOD'
  | 'ESCALATE_TO_SUPPORT'
  | 'CLOSE_CASE';

export interface ProposedAction {
  actionType: ActionType;
  caseRef?: string;
  orderRef?: string;
  costMinorUnits?: number;
  incentivePercent?: number;
  scheduledAt?: Date | string;
  metadata?: Record<string, unknown>;
}

export interface EvaluationContext {
  evaluationTime?: Date;
  globalAutonomyTier?: AutonomyTier;
  currentRetryCount?: number;
  contactsThisWeek?: number;
  dailySpentMinorUnits?: number;
  isTerminalFailure?: boolean;
  failureCategory?: string;
  requiresHumanReview?: boolean;
  correlationId?: string;
}

export type PolicyDecisionState = 'APPROVED' | 'REJECTED' | 'REQUIRES_HUMAN';

export interface PolicyEvaluationResult {
  decision: PolicyDecisionState;
  reasonCode: string;
  ruleId: string;
  message: string;
  policyId?: number;
  policyVersion?: number;
  evaluatedTier: AutonomyTier;
  evaluatedAt: Date;
  proposedAction: ProposedAction;
  correlationId?: string;
}
