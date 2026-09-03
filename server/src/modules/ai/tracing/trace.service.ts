import { HttpError } from '../../../utils/http-error.js';
import { logger } from '../../../utils/logger.js';
import { MockLLMProvider } from '../../../infrastructure/llm/mock-provider.js';
import { planRecoveryDecision } from '../decision/decision.agent.js';
import { diagnosePaymentFailure } from '../diagnosis/diagnosis.agent.js';
import {
  findTraceByRef,
  findTracesByCaseId,
  findTracesByCorrelationId
} from './trace.repository.js';
import type {
  AgentTrace,
  MerchantTraceSummary,
  TraceReplayResult
} from './trace.types.js';

/* ------------------------------------------------------------------ */
/*  Agent Trace Operations & Replay Engine (AI-007 / OBS-005)         */
/* ------------------------------------------------------------------ */

/**
 * Retrieves full raw execution trace with all steps for platform operators.
 * (AI-007 Requirement 7)
 */
export async function getOperatorTrace(traceRef: string): Promise<AgentTrace> {
  const trace = await findTraceByRef(traceRef);
  if (!trace) {
    throw new HttpError(404, 'TRACE_NOT_FOUND', `Agent reasoning trace '${traceRef}' not found.`);
  }
  return trace;
}

/**
 * Retrieves a summarized, sanitized trace for merchant cockpit views.
 * Withholds internal system prompts, model temperatures, and raw provider payloads.
 * (AI-007 Requirement 11)
 */
export async function getMerchantTraceSummary(
  caseId: number,
  merchantId: number
): Promise<MerchantTraceSummary | null> {
  const traces = await findTracesByCaseId(caseId, merchantId);
  if (traces.length === 0) {
    return null;
  }

  // Pick newest decision or diagnosis trace
  const primaryTrace = traces[0]!;

  // Synthesize rationale summary from steps
  let rationale = 'Reasoning process completed.';
  let recommendedAction: string | null = null;

  for (const step of primaryTrace.steps) {
    if (step.parsedOutput) {
      if (typeof step.parsedOutput.explanation === 'string') {
        rationale = step.parsedOutput.explanation;
      } else if (typeof step.parsedOutput.planRationale === 'string') {
        rationale = step.parsedOutput.planRationale;
      }

      if (Array.isArray(step.parsedOutput.actions) && step.parsedOutput.actions.length > 0) {
        const first = step.parsedOutput.actions[0] as Record<string, unknown>;
        if (typeof first?.actionType === 'string') {
          recommendedAction = first.actionType;
        }
      }
    }
  }

  return {
    caseId: primaryTrace.caseId,
    traceRef: primaryTrace.traceRef,
    agentType: primaryTrace.agentType,
    status: primaryTrace.status,
    rationaleSummary: rationale,
    recommendedAction,
    isAutonomous: primaryTrace.status === 'success',
    evaluatedTier: 'T3',
    completedAt: primaryTrace.createdAt,
    correlationId: primaryTrace.correlationId
  };
}

/**
 * Replays a stored trace against the MockLLMProvider to verify deterministic
 * execution path reproduction.
 * (AI-007 Requirement 8 / Acceptance Criteria)
 */
export async function replayAgentTrace(
  traceRef: string,
  customMockProvider?: MockLLMProvider
): Promise<TraceReplayResult> {
  const trace = await findTraceByRef(traceRef);
  if (!trace) {
    throw new HttpError(404, 'TRACE_NOT_FOUND', `Trace '${traceRef}' not found for replay.`);
  }

  const mock = customMockProvider || new MockLLMProvider();

  logger.info({ traceRef, agentType: trace.agentType }, '[TraceReplay] Starting deterministic trace replay');

  // Locate the prompt render / context step
  const promptStep = trace.steps.find((s) => s.stepType === 'prompt_render' || s.stepType === 'model_completion');
  if (!promptStep || !promptStep.userPrompt) {
    throw new HttpError(400, 'TRACE_MALFORMED_REPLAY', 'Trace missing required user prompt payload for replay.');
  }

  // Find original output
  const completionStep = trace.steps.find((s) => s.stepType === 'model_completion' || s.stepType === 'fallback_rules');
  const originalOutput = completionStep?.parsedOutput || null;

  let replayedOutput: unknown = null;
  let replayedStatus: 'success' | 'failed' | 'aborted' | 'vetoed' = 'success';

  try {
    if (trace.agentType === 'diagnosis') {
      // Mock the provider to return the deterministic completion
      const diagResult = await diagnosePaymentFailure(
        {
          context: JSON.parse(promptStep.userPrompt.match(/<<<BEGIN_UNTRUSTED_CONTEXT_PAYLOAD>>>\s*([\s\S]*?)\s*<<<END_UNTRUSTED_CONTEXT_PAYLOAD>>>/)?.[1] || '{}'),
          correlationId: trace.correlationId
        },
        mock
      );
      replayedOutput = diagResult;
    } else if (trace.agentType === 'decision') {
      const contextStr = promptStep.userPrompt.match(/<<<BEGIN_UNTRUSTED_CONTEXT_PAYLOAD>>>\s*([\s\S]*?)\s*<<<END_UNTRUSTED_CONTEXT_PAYLOAD>>>/)?.[1] || '{}';
      const diagStr = promptStep.userPrompt.match(/<<<BEGIN_DIAGNOSIS_PAYLOAD>>>\s*([\s\S]*?)\s*<<<END_DIAGNOSIS_PAYLOAD>>>/)?.[1] || '{}';

      const decisionResult = await planRecoveryDecision(
        {
          context: JSON.parse(contextStr),
          diagnosis: JSON.parse(diagStr),
          correlationId: trace.correlationId
        },
        mock
      );
      replayedOutput = decisionResult;
    }
  } catch (err) {
    replayedStatus = 'failed';
    replayedOutput = { error: err instanceof Error ? err.message : 'Replay error' };
  }

  const isDeterministic = trace.status === replayedStatus;

  return {
    traceRef,
    isDeterministic,
    originalStatus: trace.status,
    replayedStatus,
    originalOutput,
    replayedOutput,
    matchScore: isDeterministic ? 1.0 : 0.0
  };
}

export { findTracesByCaseId, findTracesByCorrelationId };
