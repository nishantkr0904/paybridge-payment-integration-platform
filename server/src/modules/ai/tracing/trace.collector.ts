import { assertZeroPII, redactString } from '../redaction.service.js';
import { createAgentTrace } from './trace.repository.js';
import type {
  AgentTrace,
  AgentType,
  CreateTraceInput,
  CreateTraceStepInput,
  StepType,
  StepValidationStatus,
  TraceStatus
} from './trace.types.js';

/* ------------------------------------------------------------------ */
/*  Agent Reasoning Trace Collector (AI-007 / AUD-002)                */
/* ------------------------------------------------------------------ */

export class TraceCollector {
  private steps: CreateTraceStepInput[] = [];
  private totalDurationMs = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  /**
   * Adds a pre-redacted execution step to the current agent trace.
   * Enforces that all text content is redacted before being queued for persistence.
   */
  public addStep(step: {
    stepType: StepType;
    promptId?: string | null;
    promptVersion?: string | null;
    modelId?: string | null;
    systemPrompt?: string | null;
    userPrompt?: string | null;
    rawResponse?: string | null;
    parsedOutput?: Record<string, unknown> | null;
    validationStatus?: StepValidationStatus;
    validationErrors?: unknown | null;
    toolInvoked?: string | null;
    toolArguments?: Record<string, unknown> | null;
    toolResult?: Record<string, unknown> | null;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    const stepNumber = this.steps.length + 1;

    // Apply strict pre-persistence PII redaction (AI-007 Requirement 3)
    const cleanSystemPrompt = step.systemPrompt ? redactString(step.systemPrompt) : null;
    const cleanUserPrompt = step.userPrompt ? redactString(step.userPrompt) : null;
    const cleanRawResponse = step.rawResponse ? redactString(step.rawResponse) : null;

    // Assert zero PII remains in stored prompt/response payloads
    if (cleanSystemPrompt) assertZeroPII(cleanSystemPrompt, `trace.step[${stepNumber}].systemPrompt`);
    if (cleanUserPrompt) assertZeroPII(cleanUserPrompt, `trace.step[${stepNumber}].userPrompt`);

    const duration = step.durationMs || 0;
    const inTokens = step.inputTokens || 0;
    const outTokens = step.outputTokens || 0;

    this.totalDurationMs += duration;
    this.totalInputTokens += inTokens;
    this.totalOutputTokens += outTokens;

    this.steps.push({
      stepNumber,
      stepType: step.stepType,
      promptId: step.promptId || null,
      promptVersion: step.promptVersion || null,
      modelId: step.modelId || null,
      systemPrompt: cleanSystemPrompt,
      userPrompt: cleanUserPrompt,
      rawResponse: cleanRawResponse,
      parsedOutput: step.parsedOutput || null,
      validationStatus: step.validationStatus || 'passed',
      validationErrors: step.validationErrors || null,
      toolInvoked: step.toolInvoked || null,
      toolArguments: step.toolArguments || null,
      toolResult: step.toolResult || null,
      durationMs: duration,
      inputTokens: inTokens,
      outputTokens: outTokens
    });
  }

  /**
   * Persists the collected trace and its child steps to the database atomically.
   */
  public async flush(options: {
    merchantId: number;
    caseId: number;
    agentType: AgentType;
    status: TraceStatus;
    correlationId: string;
    terminationReason?: string | null;
  }): Promise<AgentTrace> {
    const input: CreateTraceInput = {
      merchantId: options.merchantId,
      caseId: options.caseId,
      agentType: options.agentType,
      status: options.status,
      terminationReason: options.terminationReason || null,
      totalDurationMs: this.totalDurationMs,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      correlationId: options.correlationId,
      steps: this.steps
    };

    return createAgentTrace(input);
  }

  public getStepsCount(): number {
    return this.steps.length;
  }
}
