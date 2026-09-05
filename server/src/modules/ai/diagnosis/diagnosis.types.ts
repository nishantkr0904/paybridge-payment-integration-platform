import { z } from 'zod';
import type { AssembledRecoveryContext } from '../redaction.types.js';

/* ------------------------------------------------------------------ */
/*  Canonical Failure Categories (§4.4 / SIG-003 / AI-002)           */
/* ------------------------------------------------------------------ */

export const FailureCategorySchema = z.enum([
  'INSUFFICIENT_FUNDS',
  'AUTHENTICATION_FAILED',
  'ISSUER_DOWN',
  'NETWORK_TIMEOUT',
  'CARD_EXPIRED',
  'FRAUD_BLOCK',
  'TECHNICAL_TRANSIENT',
  'ISSUER_SOFT_DECLINE',
  'ISSUER_HARD_DECLINE',
  'VELOCITY_LIMIT',
  'CURRENCY_MISMATCH',
  'INVALID_ACCOUNT',
  'CUSTOMER_ABANDONED',
  'UNKNOWN'
]);

export type FailureCategory = z.infer<typeof FailureCategorySchema>;

/* ------------------------------------------------------------------ */
/*  Recommended Strategies (§4.4 / AI-002 / AI-004)                   */
/* ------------------------------------------------------------------ */

export const RecommendedStrategySchema = z.enum([
  'IMMEDIATE_RETRY',
  'DELAYED_RETRY',
  'ALTERNATE_PAYMENT_METHOD',
  'CUSTOMER_OUTREACH',
  'MERCHANT_INTERVENTION',
  'ESCALATE',
  'ABANDON'
]);

export type RecommendedStrategy = z.infer<typeof RecommendedStrategySchema>;

/* ------------------------------------------------------------------ */
/*  Raw Model Output Schema (AI-003 Structured Validation)            */
/* ------------------------------------------------------------------ */

export const DiagnosisRawOutputSchema = z.object({
  category: FailureCategorySchema,
  reasonCode: z.string().min(1).max(64),
  rootCause: z.string().min(1).max(256),
  contributingFactors: z.array(z.string().min(1).max(256)).max(10),
  recoverable: z.boolean(),
  recommendedStrategy: RecommendedStrategySchema,
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1).max(1000),
  evidence: z.array(z.string().min(1).max(128)).max(10)
});

export type DiagnosisRawOutput = z.infer<typeof DiagnosisRawOutputSchema>;

/* ------------------------------------------------------------------ */
/*  Diagnosis Provenance & Final Result Schema (AI-002 / AI-008)      */
/* ------------------------------------------------------------------ */

export const DiagnosisProvenanceSchema = z.object({
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
  rulesVersion: z.string().nullable(),
  repairAttempted: z.boolean(),
  fallbackReason: z.string().nullable()
});

export type DiagnosisProvenance = z.infer<typeof DiagnosisProvenanceSchema>;

export const DiagnosisResultSchema = DiagnosisRawOutputSchema.extend({
  provenance: DiagnosisProvenanceSchema
});

export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;

export interface DiagnoseCaseInput {
  context: AssembledRecoveryContext;
  correlationId?: string;
  promptVersion?: string;
  forceFallback?: boolean;
}
