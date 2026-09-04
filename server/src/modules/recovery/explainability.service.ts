import { HttpError } from '../../utils/http-error.js';
import { assertZeroPII, redactString } from '../ai/redaction.service.js';
import { getMerchantTraceSummary } from '../ai/tracing/trace.service.js';
import { findTracesByCaseId } from '../ai/tracing/trace.repository.js';
import { findActivePolicyByMerchantId } from '../policy/policy.repository.js';
import { evaluatePolicy } from '../policy/policy.engine.js';
import { findCaseById, findCaseByRef, findCaseEventsByCaseId } from './case.repository.js';
import { TERMINAL_STATES } from './case.state-machine.js';
import type { CaseEvent } from './case.types.js';
import type { AgentTrace } from '../ai/tracing/trace.types.js';
import type { DiagnosisResult } from '../ai/diagnosis/diagnosis.types.js';
import type { DecisionPlan } from '../ai/decision/decision.types.js';
import type { PolicyEvaluationResult } from '../policy/policy.types.js';
import type {
  CaseIdentitySummary,
  GoverningPolicySummary,
  PolicyExplanation,
  RecoveryOutcomeSummary,
  TraceExplanation,
  TraceItemSummary,
  UnifiedExplainabilityPayload
} from './explainability.types.js';

/* ------------------------------------------------------------------ */
/*  Deep PII Redactor Helper (SEC-002 / AI-009)                       */
/* ------------------------------------------------------------------ */

function deepRedact<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return (redactString(value) as unknown) as T;
  }
  if (Array.isArray(value)) {
    return (value.map((item) => deepRedact(item)) as unknown) as T;
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return value;
    }
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      copy[k] = deepRedact(v);
    }
    return copy as T;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/*  Component Extraction Helpers                                      */
/* ------------------------------------------------------------------ */

function extractDiagnosis(
  traces: AgentTrace[],
  events: CaseEvent[]
): DiagnosisResult | null {
  // 1. Prioritize agent reasoning traces
  const diagTrace = traces.find(
    (t) => t.agentType === 'diagnosis' || t.agentType === 'multi_agent'
  );
  if (diagTrace) {
    for (const step of diagTrace.steps) {
      if (
        step.parsedOutput &&
        typeof step.parsedOutput === 'object' &&
        'category' in step.parsedOutput &&
        ('rootCause' in step.parsedOutput || 'explanation' in step.parsedOutput)
      ) {
        return step.parsedOutput as unknown as DiagnosisResult;
      }
    }
  }

  // 2. Check case events for recorded diagnosis payload
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload;
    if (payload && typeof payload.diagnosis === 'object' && payload.diagnosis !== null) {
      return payload.diagnosis as unknown as DiagnosisResult;
    }
  }

  return null;
}

function extractDecision(
  traces: AgentTrace[],
  events: CaseEvent[]
): DecisionPlan | null {
  // 1. Prioritize agent reasoning traces
  const decisionTrace = traces.find(
    (t) => t.agentType === 'decision' || t.agentType === 'multi_agent'
  );
  if (decisionTrace) {
    for (const step of decisionTrace.steps) {
      if (
        step.parsedOutput &&
        typeof step.parsedOutput === 'object' &&
        ('planRationale' in step.parsedOutput || 'actions' in step.parsedOutput)
      ) {
        return step.parsedOutput as unknown as DecisionPlan;
      }
    }
  }

  // 2. Check case events for recorded decision payload
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload;
    if (payload) {
      if (typeof payload.decision === 'object' && payload.decision !== null) {
        return payload.decision as unknown as DecisionPlan;
      }
      if (typeof payload.actionPlan === 'object' && payload.actionPlan !== null) {
        return payload.actionPlan as unknown as DecisionPlan;
      }
    }
  }

  return null;
}

function extractRecordedPolicyEvaluation(
  traces: AgentTrace[],
  events: CaseEvent[]
): PolicyEvaluationResult | null {
  // 1. Check case events for recorded policy evaluation
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload;
    if (payload) {
      if (typeof payload.policyEvaluation === 'object' && payload.policyEvaluation !== null) {
        return payload.policyEvaluation as unknown as PolicyEvaluationResult;
      }
      if (
        typeof payload.policy === 'object' &&
        payload.policy !== null &&
        'decision' in payload.policy &&
        'ruleId' in payload.policy
      ) {
        return payload.policy as unknown as PolicyEvaluationResult;
      }
    }
  }

  // 2. Check trace steps for policy evaluation step
  for (const trace of traces) {
    for (const step of trace.steps) {
      if (step.stepType === 'policy_evaluation' || step.toolInvoked === 'evaluate_policy') {
        const out = step.parsedOutput || step.toolResult;
        if (out && typeof out === 'object' && 'decision' in out && 'ruleId' in out) {
          return out as unknown as PolicyEvaluationResult;
        }
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Unified Explainability Service (BT-C4 / BC-7.5 / BEX-003)         */
/* ------------------------------------------------------------------ */

/**
 * Assembles a comprehensive, single unified explainability payload for a recovery case.
 * Combines:
 * - Case identity and correlation context
 * - Recovery outcome and terminal disposition
 * - Diagnosis explanation and root cause
 * - Decision plan and action rationale
 * - Deterministic policy evaluation and governing merchant rules
 * - Agent reasoning traces and execution summaries
 *
 * Guarantees:
 * - Strict tenant isolation at repository boundary
 * - Deep PII redaction and validation with assertZeroPII
 * - Read-only execution with zero LLM/network calls or database mutations
 * - Integer minor-units money invariants
 */
export async function getCaseExplainability(
  idOrRef: string | number,
  merchantId: number
): Promise<UnifiedExplainabilityPayload> {
  const numericId = Number(idOrRef);
  const recoveryCase =
    !isNaN(numericId) && numericId > 0 && String(numericId) === String(idOrRef)
      ? await findCaseById(numericId, merchantId)
      : await findCaseByRef(String(idOrRef), merchantId);

  if (!recoveryCase) {
    throw new HttpError(404, 'CASE_NOT_FOUND', 'Recovery case does not exist.');
  }

  // Retrieve case timeline events and traces scoped strictly to this merchant
  const [events, traces, activePolicy] = await Promise.all([
    findCaseEventsByCaseId(recoveryCase.id, merchantId),
    findTracesByCaseId(recoveryCase.id, merchantId),
    findActivePolicyByMerchantId(merchantId)
  ]);

  // 1. Case Identity & Correlation
  const caseIdentity: CaseIdentitySummary = {
    id: recoveryCase.id,
    caseRef: recoveryCase.caseRef,
    merchantId: recoveryCase.merchantId,
    orderId: recoveryCase.orderId,
    transactionId: recoveryCase.transactionId,
    status: recoveryCase.status,
    recoverableAmountMinorUnits: Number(recoveryCase.recoverableAmount),
    currency: recoveryCase.currency,
    originatingSignal: recoveryCase.originatingSignal,
    failureCategory: recoveryCase.failureCategory,
    correlationId: recoveryCase.correlationId,
    createdAt: recoveryCase.createdAt instanceof Date ? recoveryCase.createdAt.toISOString() : new Date(recoveryCase.createdAt).toISOString(),
    updatedAt: recoveryCase.updatedAt instanceof Date ? recoveryCase.updatedAt.toISOString() : new Date(recoveryCase.updatedAt).toISOString()
  };

  // 2. Recovery Outcome
  const isTerminal = TERMINAL_STATES.has(recoveryCase.status);
  const terminalEvent = events.slice().reverse().find((e) => TERMINAL_STATES.has(e.toStatus));

  const recoveryOutcome: RecoveryOutcomeSummary = {
    status: recoveryCase.status,
    isTerminal,
    recoveredAmountMinorUnits: recoveryCase.status === 'recovered' ? Number(recoveryCase.recoverableAmount) : null,
    terminalReason: terminalEvent?.reason || (isTerminal ? `Case reached terminal status '${recoveryCase.status}'` : null),
    completedAt: terminalEvent
      ? (terminalEvent.createdAt instanceof Date ? terminalEvent.createdAt.toISOString() : new Date(terminalEvent.createdAt).toISOString())
      : (isTerminal ? (recoveryCase.updatedAt instanceof Date ? recoveryCase.updatedAt.toISOString() : new Date(recoveryCase.updatedAt).toISOString()) : null)
  };

  // 3. Diagnosis Explanation
  const diagnosis = extractDiagnosis(traces, events);

  // 4. Decision Plan & Rationale
  const decision = extractDecision(traces, events);

  // 5. Policy Evaluation & Governing Rules
  let policyEvaluation = extractRecordedPolicyEvaluation(traces, events);

  // If no historical evaluation recorded, but a primary proposed action and active policy exist,
  // evaluate deterministically in-memory without side effects
  if (!policyEvaluation && activePolicy && decision?.primaryAction) {
    const evalResult = evaluatePolicy(
      activePolicy,
      {
        actionType: decision.primaryAction.actionType,
        caseRef: recoveryCase.caseRef,
        costMinorUnits: decision.primaryAction.costMinorUnits,
        incentivePercent: decision.primaryAction.incentivePercent,
        scheduledAt: decision.primaryAction.scheduledDelaySeconds > 0
          ? new Date(Date.now() + decision.primaryAction.scheduledDelaySeconds * 1000)
          : undefined,
        metadata: decision.primaryAction.parameters
      },
      {
        failureCategory: recoveryCase.failureCategory || undefined,
        correlationId: recoveryCase.correlationId
      }
    );
    policyEvaluation = evalResult;
  }

  const governingPolicy: GoverningPolicySummary | null = activePolicy
    ? {
        id: activePolicy.id,
        version: activePolicy.version,
        autonomyTier: activePolicy.autonomyTier,
        isActive: activePolicy.isActive,
        maxRetries: activePolicy.maxRetries,
        maxContactsPerCustomerPerWeek: activePolicy.maxContactsPerCustomerPerWeek,
        dailyBudgetMinorUnits: activePolicy.dailyBudgetMinorUnits,
        maxIncentivePercent: activePolicy.maxIncentivePercent,
        quietHoursStart: activePolicy.quietHoursStart,
        quietHoursEnd: activePolicy.quietHoursEnd,
        timezone: activePolicy.timezone
      }
    : null;

  const policy: PolicyExplanation | null =
    policyEvaluation || governingPolicy
      ? {
          evaluation: policyEvaluation,
          governingPolicy
        }
      : null;

  // 6. Agent Traces & Summary
  let trace: TraceExplanation | null = null;

  if (traces.length > 0) {
    const traceSummary = await getMerchantTraceSummary(recoveryCase.id, merchantId);
    const traceList: TraceItemSummary[] = traces.map((t) => ({
      traceRef: t.traceRef,
      agentType: t.agentType,
      status: t.status,
      durationMs: t.totalDurationMs,
      inputTokens: t.totalInputTokens,
      outputTokens: t.totalOutputTokens,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : new Date(t.createdAt).toISOString()
    }));

    trace = {
      primaryTraceRef: traceSummary?.traceRef || traces[0]?.traceRef || null,
      summary: traceSummary,
      traces: traceList
    };
  }

  // 7. Assemble and Apply Deep PII Sanitization
  const rawPayload: UnifiedExplainabilityPayload = {
    case: caseIdentity,
    recoveryOutcome,
    diagnosis,
    decision,
    policy,
    trace
  };

  const sanitizedPayload = deepRedact(rawPayload);

  // Assert zero PII invariant holds over the sanitized payload
  assertZeroPII(sanitizedPayload);

  return sanitizedPayload;
}
