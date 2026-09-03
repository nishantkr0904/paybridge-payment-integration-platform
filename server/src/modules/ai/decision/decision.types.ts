import { z } from 'zod';
import type { AssembledRecoveryContext } from '../redaction.types.js';
import type { DiagnosisResult } from '../diagnosis/diagnosis.types.js';

/* ------------------------------------------------------------------ */
/*  Canonical Recovery Action Tools (§4.5 Bounded Registry)           */
/* ------------------------------------------------------------------ */

export const RecoveryToolNameSchema = z.enum([
  'schedule_payment_retry',
  'request_alternate_instrument',
  'send_recovery_link',
  'notify_customer',
  'request_customer_authentication',
  'apply_recovery_incentive',
  'escalate_to_merchant',
  'escalate_to_human_operator',
  'suppress_case',
  'schedule_followup'
]);

export type RecoveryToolName = z.infer<typeof RecoveryToolNameSchema>;

export const CanonicalActionTypeSchema = z.enum([
  'RETRY_PAYMENT',
  'CUSTOMER_OUTREACH',
  'OFFER_INCENTIVE',
  'REQUEST_PAYMENT_METHOD',
  'ESCALATE_TO_SUPPORT',
  'CLOSE_CASE'
]);

/* ------------------------------------------------------------------ */
/*  Proposed Action Plan Item Schema (AI-005 / AI-006)                */
/* ------------------------------------------------------------------ */

export const ProposedActionPlanItemSchema = z.object({
  actionType: CanonicalActionTypeSchema,
  toolName: RecoveryToolNameSchema,
  scheduledDelaySeconds: z.number().int().min(0).max(604800), // up to 7 days
  costMinorUnits: z.number().int().min(0).default(0),
  incentivePercent: z.number().min(0).max(100).default(0),
  rationale: z.string().min(1).max(500),
  parameters: z.record(z.unknown()).default({})
});

export type ProposedActionPlanItem = z.infer<typeof ProposedActionPlanItemSchema>;

/* ------------------------------------------------------------------ */
/*  Raw Model Decision Plan Schema (AI-003 / AI-006)                  */
/* ------------------------------------------------------------------ */

export const DecisionRawOutputSchema = z.object({
  planRationale: z.string().min(1).max(1000),
  actions: z.array(ProposedActionPlanItemSchema).max(3),
  costOrderingRespect: z.boolean().default(true)
});

export type DecisionRawOutput = z.infer<typeof DecisionRawOutputSchema>;

/* ------------------------------------------------------------------ */
/*  Final Decision Plan & Provenance Schema                           */
/* ------------------------------------------------------------------ */

export const DecisionProvenanceSchema = z.object({
  source: z.enum(['model', 'rules']),
  promptId: z.string(),
  promptVersion: z.string(),
  modelId: z.string(),
  tokens: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative()
  }),
  latencyMs: z.number().nonnegative(),
  contextVersion: z.string(),
  diagnosisCategory: z.string(),
  rulesVersion: z.string().nullable(),
  repairAttempted: z.boolean(),
  fallbackReason: z.string().nullable()
});

export type DecisionProvenance = z.infer<typeof DecisionProvenanceSchema>;

export const DecisionPlanSchema = z.object({
  planRationale: z.string(),
  actions: z.array(ProposedActionPlanItemSchema),
  primaryAction: ProposedActionPlanItemSchema.nullable(),
  costOrderingRespect: z.boolean(),
  provenance: DecisionProvenanceSchema
});

export type DecisionPlan = z.infer<typeof DecisionPlanSchema>;

export interface PlanDecisionInput {
  context: AssembledRecoveryContext;
  diagnosis: DiagnosisResult;
  correlationId?: string;
  promptVersion?: string;
  forceFallback?: boolean;
}
