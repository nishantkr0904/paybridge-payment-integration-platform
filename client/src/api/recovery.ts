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
