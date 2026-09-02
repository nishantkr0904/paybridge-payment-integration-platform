import { z } from 'zod';

/* ------------------------------------------------------------------ */
/*  Canonical Agent Reasoning Trace Types (AI-007 / AUD-002)          */
/* ------------------------------------------------------------------ */

export const AgentTypeSchema = z.enum(['diagnosis', 'decision', 'multi_agent']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const TraceStatusSchema = z.enum(['success', 'failed', 'aborted', 'vetoed']);
export type TraceStatus = z.infer<typeof TraceStatusSchema>;

export const StepTypeSchema = z.enum([
  'prompt_render',
  'model_completion',
  'schema_validation',
  'repair_attempt',
  'policy_evaluation',
  'fallback_rules'
]);
export type StepType = z.infer<typeof StepTypeSchema>;

export const StepValidationStatusSchema = z.enum(['passed', 'failed', 'repaired', 'fallback']);
export type StepValidationStatus = z.infer<typeof StepValidationStatusSchema>;

/* ------------------------------------------------------------------ */
/*  Trace Step Schema                                                 */
/* ------------------------------------------------------------------ */

export const AgentTraceStepSchema = z.object({
  id: z.number().int().positive().optional(),
  traceId: z.number().int().positive().optional(),
  stepNumber: z.number().int().positive(),
  stepType: StepTypeSchema,
  promptId: z.string().nullable().optional(),
  promptVersion: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  userPrompt: z.string().nullable().optional(),
  rawResponse: z.string().nullable().optional(),
  parsedOutput: z.record(z.unknown()).nullable().optional(),
  validationStatus: StepValidationStatusSchema.default('passed'),
  validationErrors: z.unknown().nullable().optional(),
  toolInvoked: z.string().nullable().optional(),
  toolArguments: z.record(z.unknown()).nullable().optional(),
  toolResult: z.record(z.unknown()).nullable().optional(),
  durationMs: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  createdAt: z.date().optional()
});

export type AgentTraceStep = z.infer<typeof AgentTraceStepSchema>;

/* ------------------------------------------------------------------ */
/*  Agent Trace Aggregate Schema                                      */
/* ------------------------------------------------------------------ */

export const AgentTraceSchema = z.object({
  id: z.number().int().positive(),
  merchantId: z.number().int().positive(),
  caseId: z.number().int().positive(),
  traceRef: z.string(),
  agentType: AgentTypeSchema,
  status: TraceStatusSchema,
  terminationReason: z.string().nullable(),
  totalDurationMs: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  correlationId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  steps: z.array(AgentTraceStepSchema).default([])
});

export type AgentTrace = z.infer<typeof AgentTraceSchema>;

export interface CreateTraceStepInput {
  stepNumber: number;
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
}

export interface CreateTraceInput {
  merchantId: number;
  caseId: number;
  traceRef?: string;
  agentType: AgentType;
  status: TraceStatus;
  terminationReason?: string | null;
  totalDurationMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  correlationId: string;
  steps: CreateTraceStepInput[];
}

/* ------------------------------------------------------------------ */
/*  Merchant Safe Summary Schema (AI-007 Requirement 11)             */
/* ------------------------------------------------------------------ */

export const MerchantTraceSummarySchema = z.object({
  caseId: z.number().int().positive(),
  traceRef: z.string(),
  agentType: AgentTypeSchema,
  status: TraceStatusSchema,
  rationaleSummary: z.string(),
  recommendedAction: z.string().nullable(),
  isAutonomous: z.boolean(),
  evaluatedTier: z.string(),
  completedAt: z.date(),
  correlationId: z.string()
});

export type MerchantTraceSummary = z.infer<typeof MerchantTraceSummarySchema>;

export interface TraceReplayResult {
  traceRef: string;
  isDeterministic: boolean;
  originalStatus: TraceStatus;
  replayedStatus: TraceStatus;
  originalOutput: unknown;
  replayedOutput: unknown;
  matchScore: number;
}
