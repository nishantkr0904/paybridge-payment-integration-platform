import type { CaseStatus } from './case.types.js';
import type { DiagnosisResult } from '../ai/diagnosis/diagnosis.types.js';
import type { DecisionPlan } from '../ai/decision/decision.types.js';
import type { AutonomyTier, PolicyEvaluationResult } from '../policy/policy.types.js';
import type { AgentType, MerchantTraceSummary, TraceStatus } from '../ai/tracing/trace.types.js';

/* ------------------------------------------------------------------ */
/*  Unified Explainability Types (BT-C4 / BC-7.5 / BEX-003)           */
/* ------------------------------------------------------------------ */

export interface CaseIdentitySummary {
  id: number;
  caseRef: string;
  merchantId: number;
  orderId: number;
  transactionId: number | null;
  status: CaseStatus;
  recoverableAmountMinorUnits: number;
  currency: string;
  originatingSignal: string;
  failureCategory: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryOutcomeSummary {
  status: CaseStatus;
  isTerminal: boolean;
  recoveredAmountMinorUnits: number | null;
  terminalReason: string | null;
  completedAt: string | null;
}

export interface GoverningPolicySummary {
  id: number;
  version: number;
  autonomyTier: AutonomyTier;
  isActive: boolean;
  maxRetries: number;
  maxContactsPerCustomerPerWeek: number;
  dailyBudgetMinorUnits: number;
  maxIncentivePercent: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
}

export interface PolicyExplanation {
  evaluation: PolicyEvaluationResult | null;
  governingPolicy: GoverningPolicySummary | null;
}

export interface TraceItemSummary {
  traceRef: string;
  agentType: AgentType;
  status: TraceStatus;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface TraceExplanation {
  primaryTraceRef: string | null;
  summary: MerchantTraceSummary | null;
  traces: TraceItemSummary[];
}

export interface UnifiedExplainabilityPayload {
  case: CaseIdentitySummary;
  recoveryOutcome: RecoveryOutcomeSummary;
  diagnosis: DiagnosisResult | null;
  decision: DecisionPlan | null;
  policy: PolicyExplanation | null;
  trace: TraceExplanation | null;
}
