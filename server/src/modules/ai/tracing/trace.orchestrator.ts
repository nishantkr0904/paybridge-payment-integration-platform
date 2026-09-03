import type { LLMProvider } from '../../../infrastructure/llm/llm.types.js';
import { generateUlid } from '../../../utils/ulid.js';
import type { PlanDecisionInput, DecisionPlan } from '../decision/decision.types.js';
import { planRecoveryDecision } from '../decision/decision.agent.js';
import type { DiagnoseCaseInput, DiagnosisResult } from '../diagnosis/diagnosis.types.js';
import { diagnosePaymentFailure } from '../diagnosis/diagnosis.agent.js';
import { TraceCollector } from './trace.collector.js';
import type { AgentTrace } from './trace.types.js';

/* ------------------------------------------------------------------ */
/*  Agent Execution Tracing Orchestrator (AI-007 / Invariant I2)      */
/* ------------------------------------------------------------------ */

export interface TracedDiagnosisResult {
  diagnosis: DiagnosisResult;
  trace: AgentTrace;
}

export interface TracedDecisionResult {
  decision: DecisionPlan;
  trace: AgentTrace;
}

/**
 * Executes Diagnosis Agent with complete reasoning capture.
 * Captures prompt render, model completion, schema validation, and fallback steps.
 * (AI-007 / AUD-002 / Invariant I2)
 */
export async function executeDiagnosisWithTrace(
  input: DiagnoseCaseInput,
  customProvider?: LLMProvider,
  merchantId = 1,
  caseId = 1
): Promise<TracedDiagnosisResult> {
  const correlationId = input.correlationId || input.context.observability.correlationId || generateUlid();
  const collector = new TraceCollector();
  const startTime = Date.now();

  try {
    const diagnosis = await diagnosePaymentFailure(input, customProvider);
    const durationMs = Date.now() - startTime;

    // Step 1: Record prompt render & completion step
    collector.addStep({
      stepType: diagnosis.provenance.source === 'model' ? 'model_completion' : 'fallback_rules',
      promptId: diagnosis.provenance.promptId,
      promptVersion: diagnosis.provenance.promptVersion,
      modelId: diagnosis.provenance.modelId,
      userPrompt: `<<<BEGIN_UNTRUSTED_CONTEXT_PAYLOAD>>>\n${JSON.stringify(input.context, null, 2)}\n<<<END_UNTRUSTED_CONTEXT_PAYLOAD>>>`,
      parsedOutput: diagnosis as unknown as Record<string, unknown>,
      validationStatus: diagnosis.provenance.repairAttempted
        ? 'repaired'
        : diagnosis.provenance.source === 'rules'
          ? 'fallback'
          : 'passed',
      durationMs,
      inputTokens: diagnosis.provenance.tokens.inputTokens,
      outputTokens: diagnosis.provenance.tokens.outputTokens
    });

    const status = diagnosis.provenance.source === 'model' ? 'success' : 'success';
    const trace = await collector.flush({
      merchantId,
      caseId,
      agentType: 'diagnosis',
      status,
      correlationId,
      terminationReason: diagnosis.provenance.fallbackReason
    });

    return { diagnosis, trace };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : 'Unknown diagnosis error';

    collector.addStep({
      stepType: 'fallback_rules',
      validationStatus: 'failed',
      validationErrors: { error: errorMsg },
      durationMs
    });

    const trace = await collector.flush({
      merchantId,
      caseId,
      agentType: 'diagnosis',
      status: 'failed',
      correlationId,
      terminationReason: errorMsg
    });

    throw Object.assign(err instanceof Error ? err : new Error(errorMsg), { trace });
  }
}

/**
 * Executes Decision Agent with complete reasoning capture.
 * Captures context synthesis, action proposal, and policy gating.
 * (AI-007 / AUD-002 / Invariant I2)
 */
export async function executeDecisionWithTrace(
  input: PlanDecisionInput,
  customProvider?: LLMProvider,
  merchantId = 1,
  caseId = 1
): Promise<TracedDecisionResult> {
  const correlationId = input.correlationId || input.context.observability.correlationId || generateUlid();
  const collector = new TraceCollector();
  const startTime = Date.now();

  try {
    const decision = await planRecoveryDecision(input, customProvider);
    const durationMs = Date.now() - startTime;

    // Step 1: Record decision reasoning step
    collector.addStep({
      stepType: decision.provenance.source === 'model' ? 'model_completion' : 'fallback_rules',
      promptId: decision.provenance.promptId,
      promptVersion: decision.provenance.promptVersion,
      modelId: decision.provenance.modelId,
      userPrompt: `<<<BEGIN_UNTRUSTED_CONTEXT_PAYLOAD>>>\n${JSON.stringify(input.context, null, 2)}\n<<<END_UNTRUSTED_CONTEXT_PAYLOAD>>>\n\n<<<BEGIN_DIAGNOSIS_PAYLOAD>>>\n${JSON.stringify(input.diagnosis, null, 2)}\n<<<END_DIAGNOSIS_PAYLOAD>>>`,
      parsedOutput: decision as unknown as Record<string, unknown>,
      toolInvoked: decision.primaryAction?.toolName || null,
      toolArguments: (decision.primaryAction?.parameters as Record<string, unknown>) || null,
      validationStatus: decision.provenance.repairAttempted
        ? 'repaired'
        : decision.provenance.source === 'rules'
          ? 'fallback'
          : 'passed',
      durationMs,
      inputTokens: decision.provenance.tokens.inputTokens,
      outputTokens: decision.provenance.tokens.outputTokens
    });

    const status = decision.provenance.source === 'model' ? 'success' : 'success';
    const trace = await collector.flush({
      merchantId,
      caseId,
      agentType: 'decision',
      status,
      correlationId,
      terminationReason: decision.provenance.fallbackReason
    });

    return { decision, trace };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : 'Unknown decision error';

    collector.addStep({
      stepType: 'fallback_rules',
      validationStatus: 'failed',
      validationErrors: { error: errorMsg },
      durationMs
    });

    const trace = await collector.flush({
      merchantId,
      caseId,
      agentType: 'decision',
      status: 'failed',
      correlationId,
      terminationReason: errorMsg
    });

    throw Object.assign(err instanceof Error ? err : new Error(errorMsg), { trace });
  }
}
