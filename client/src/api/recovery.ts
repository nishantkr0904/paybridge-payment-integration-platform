import { api } from './client';

export type CaseStatus =
  | 'detected'
  | 'diagnosing'
  | 'scoring'
  | 'deciding'
  | 'awaiting_approval'
  | 'executing'
  | 'awaiting_outcome'
  | 'recovered'
  | 'unrecovered'
  | 'suppressed'
  | 'expired'
  | 'failed';

export type RecoveryCase = {
  id: number;
  merchantId: number;
  caseRef: string;
  orderId: number;
  transactionId?: number | null;
  status: CaseStatus;
  recoverableAmount: number;
  currency: string;
  originatingSignal: string;
  failureCategory: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
};

export type CaseEvent = {
  id: number;
  caseId: number;
  merchantId: number;
  fromStatus: CaseStatus | null;
  toStatus: CaseStatus;
  actorType: 'system' | 'agent' | 'operator' | 'customer' | 'policy_engine';
  actorId: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  correlationId: string;
  createdAt: string;
};

export type AgentTraceStep = {
  id?: number;
  traceId?: number;
  stepNumber: number;
  stepType: string;
  promptId?: string | null;
  promptVersion?: string | null;
  modelId?: string | null;
  systemPrompt?: string | null;
  userPrompt?: string | null;
  rawResponse?: string | null;
  parsedOutput?: Record<string, unknown> | null;
  validationStatus: string;
  validationErrors?: unknown | null;
  toolInvoked?: string | null;
  toolArguments?: Record<string, unknown> | null;
  toolResult?: Record<string, unknown> | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt?: string;
};

export type AgentTrace = {
  id: number;
  merchantId: number;
  caseId: number;
  traceRef: string;
  agentType: string;
  status: string;
  terminationReason?: string | null;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  correlationId: string;
  createdAt: string;
  steps: AgentTraceStep[];
};

export type PrioritizedCase = {
  case: RecoveryCase;
  priorityScore: number;
  breakdown: {
    baseValueScore: number;
    urgencyScore: number;
    propensityBonus: number;
    tierWeight: number;
  };
  rankReason: string;
};

export type OperatorActionType = 'APPROVE' | 'REJECT' | 'CLOSE';

export type CaseListResponse = {
  cases: RecoveryCase[];
  total: number;
  limit: number;
  offset: number;
};

export async function listRecoveryCases(params?: {
  status?: CaseStatus;
  limit?: number;
  offset?: number;
}): Promise<CaseListResponse> {
  const response = await api.get<CaseListResponse>('/recovery/cases', { params });
  return response.data;
}

export async function getPrioritizedQueue(params?: {
  limit?: number;
  maxPerMerchant?: number;
}): Promise<{ queue: PrioritizedCase[]; total: number }> {
  const response = await api.get<{ queue: PrioritizedCase[]; total: number }>('/recovery/queue', { params });
  return response.data;
}

export async function getRecoveryCase(idOrRef: string | number): Promise<{ case: RecoveryCase }> {
  const response = await api.get<{ case: RecoveryCase }>(`/recovery/cases/${idOrRef}`);
  return response.data;
}

export async function getCaseTimeline(caseId: number): Promise<{ timeline: CaseEvent[] }> {
  const response = await api.get<{ timeline: CaseEvent[] }>(`/recovery/cases/${caseId}/timeline`);
  return response.data;
}

export async function getCaseTraces(caseId: number): Promise<{ traces: AgentTrace[] }> {
  const response = await api.get<{ traces: AgentTrace[] }>(`/recovery/cases/${caseId}/traces`);
  return response.data;
}

export async function executeOperatorAction(
  caseId: number,
  action: OperatorActionType,
  reason: string,
  payload?: Record<string, unknown>
): Promise<{ case: RecoveryCase }> {
  const response = await api.post<{ case: RecoveryCase }>(`/recovery/cases/${caseId}/actions`, {
    action,
    reason,
    payload
  });
  return response.data;
}

export async function exportCaseAuditTrail(
  idOrRef: string | number,
  format: 'csv' | 'json' = 'csv'
): Promise<{ content: string; contentType: string; filename?: string; signature?: string }> {
  const response = await api.get<string>(`/audit/cases/${idOrRef}/export`, {
    params: { format },
    responseType: 'text'
  });

  const disposition = String(response.headers['content-disposition'] || '');
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : `audit-case-${idOrRef}.${format}`;
  const signature = response.headers['x-audit-signature'] ? String(response.headers['x-audit-signature']) : undefined;

  return {
    content: response.data,
    contentType: response.headers['content-type'] ? String(response.headers['content-type']) : (format === 'csv' ? 'text/csv' : 'application/json'),
    filename,
    signature
  };
}

/* ------------------------------------------------------------------ */
/*  Recovery Analytics Types & API                                    */
/* ------------------------------------------------------------------ */

export type RecoveryLatencyMetrics = {
  sampleSize: number;
  avgDurationSeconds: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  p50DurationSeconds: number;
  p90DurationSeconds: number;
  p99DurationSeconds: number;
};

export type StrategyPerformance = {
  strategy: string;
  attempts: number;
  successfulRecoveries: number;
  recoveryRate: number;
  recoveredRevenueMinorUnits: number;
};

export type CategoryBreakdown = {
  failureCategory: string;
  isAddressable: boolean;
  caseCount: number;
  detectedMinorUnits: number;
  recoveredMinorUnits: number;
  suppressedMinorUnits: number;
  unrecoveredMinorUnits: number;
  inFlightMinorUnits: number;
};

export type RecoveryRates = {
  recoveryRate: number;
  revenueRecoveryRate: number;
  attemptRecoveryRate: number;
  overallCaseRecoveryRate: number;
};

export type RecoveryAnalytics = {
  merchantId: number | null;
  currency: string;
  period: {
    startDate?: string;
    endDate?: string;
  };
  counts: {
    totalCases: number;
    eligibleCases: number;
    ineligibleCases: number;
    totalAttempts: number;
    successfulRecoveries: number;
    unrecoveredCases: number;
    suppressedCases: number;
    inFlightCases: number;
  };
  revenue: {
    totalDetectedMinorUnits: number;
    addressableMinorUnits: number;
    nonAddressableMinorUnits: number;
    recoveredRevenueMinorUnits: number;
    unrecoveredRevenueMinorUnits: number;
    suppressedRevenueMinorUnits: number;
    inFlightRevenueMinorUnits: number;
  };
  rates: RecoveryRates;
  latency: RecoveryLatencyMetrics;
  strategyPerformance: StrategyPerformance[];
  categoryPerformance: CategoryBreakdown[];
  reconciliation: {
    isReconciled: boolean;
    varianceMinorUnits: number;
  };
};

export async function getRecoveryAnalytics(params?: {
  startDate?: string;
  endDate?: string;
  currency?: string;
}): Promise<RecoveryAnalytics> {
  const response = await api.get<RecoveryAnalytics>('/recovery/analytics', { params });
  return response.data;
}

/* ------------------------------------------------------------------ */
/*  Unified Explainability Types & API (BT-C4 / BC-7.5 / BEX-003)    */
/* ------------------------------------------------------------------ */

export type CaseIdentitySummary = {
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
};

export type RecoveryOutcomeSummary = {
  status: CaseStatus;
  isTerminal: boolean;
  recoveredAmountMinorUnits: number | null;
  terminalReason: string | null;
  completedAt: string | null;
};

export type DiagnosisProvenance = {
  source: 'model' | 'rules';
  promptId: string;
  promptVersion: string;
  modelId: string;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  contextVersion: string;
  rulesVersion: string | null;
  repairAttempted: boolean;
  fallbackReason: string | null;
};

export type DiagnosisResultSummary = {
  category: string;
  reasonCode: string;
  rootCause: string;
  contributingFactors: string[];
  recoverable: boolean;
  recommendedStrategy: string;
  confidence: number;
  explanation: string;
  evidence: string[];
  provenance: DiagnosisProvenance;
};

export type ProposedActionPlanItemSummary = {
  actionType: string;
  toolName: string;
  scheduledDelaySeconds: number;
  costMinorUnits: number;
  incentivePercent: number;
  rationale: string;
  parameters: Record<string, unknown>;
};

export type DecisionProvenance = {
  source: 'model' | 'rules';
  promptId: string;
  promptVersion: string;
  modelId: string;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  contextVersion: string;
  diagnosisCategory: string;
  rulesVersion: string | null;
  repairAttempted: boolean;
  fallbackReason: string | null;
};

export type DecisionPlanSummary = {
  planRationale: string;
  actions: ProposedActionPlanItemSummary[];
  primaryAction: ProposedActionPlanItemSummary | null;
  costOrderingRespect: boolean;
  provenance: DecisionProvenance;
};

export type PolicyEvaluationSummary = {
  decision: 'APPROVED' | 'REJECTED' | 'REQUIRES_HUMAN';
  reasonCode: string;
  ruleId: string;
  message: string;
  policyId?: number;
  policyVersion?: number;
  evaluatedTier: 'T0' | 'T1' | 'T2' | 'T3' | 'T4';
  evaluatedAt: string;
  proposedAction?: {
    actionType: string;
    caseRef?: string;
    orderRef?: string;
    costMinorUnits?: number;
    incentivePercent?: number;
    scheduledAt?: string;
    metadata?: Record<string, unknown>;
  };
  correlationId?: string;
};

export type GoverningPolicySummary = {
  id: number;
  version: number;
  autonomyTier: 'T0' | 'T1' | 'T2' | 'T3' | 'T4';
  isActive: boolean;
  maxRetries: number;
  maxContactsPerCustomerPerWeek: number;
  dailyBudgetMinorUnits: number;
  maxIncentivePercent: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
};

export type PolicyExplanation = {
  evaluation: PolicyEvaluationSummary | null;
  governingPolicy: GoverningPolicySummary | null;
};

export type MerchantTraceSummary = {
  caseId: number;
  traceRef: string;
  agentType: string;
  status: string;
  rationaleSummary: string;
  recommendedAction: string | null;
  isAutonomous: boolean;
  evaluatedTier: string;
  completedAt: string;
  correlationId: string;
};

export type TraceItemSummary = {
  traceRef: string;
  agentType: string;
  status: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
};

export type TraceExplanation = {
  primaryTraceRef: string | null;
  summary: MerchantTraceSummary | null;
  traces: TraceItemSummary[];
};

export type UnifiedExplainabilityPayload = {
  case: CaseIdentitySummary;
  recoveryOutcome: RecoveryOutcomeSummary;
  diagnosis: DiagnosisResultSummary | null;
  decision: DecisionPlanSummary | null;
  policy: PolicyExplanation | null;
  trace: TraceExplanation | null;
};

export async function getCaseExplainability(
  idOrRef: string | number
): Promise<UnifiedExplainabilityPayload> {
  const response = await api.get<UnifiedExplainabilityPayload>(
    `/recovery/cases/${idOrRef}/explainability`
  );
  return response.data;
}

