import { z } from 'zod';

/* ------------------------------------------------------------------ */
/*  PII Categories & Redaction Types (AI-009 / TASK-302)              */
/* ------------------------------------------------------------------ */

export type PIICategory =
  | 'EMAIL'
  | 'PHONE'
  | 'CARD_PAN'
  | 'CARD_EXPIRY'
  | 'CARD_CVV'
  | 'BANK_ACCOUNT_IFSC'
  | 'GOVERNMENT_ID'
  | 'NAME'
  | 'POSTAL_ADDRESS'
  | 'IP_ADDRESS'
  | 'MERCHANT_METADATA';

export interface DetectedPII {
  category: PIICategory;
  matchedText: string;
  field?: string;
}

export class PIIDetectedInPromptError extends Error {
  constructor(
    message: string,
    public readonly detectedCategories: PIICategory[],
    public readonly field?: string
  ) {
    super(message);
    this.name = 'PIIDetectedInPromptError';
  }
}

/* ------------------------------------------------------------------ */
/*  Assembled Recovery Context Schema (Allowlist Enforced)           */
/* ------------------------------------------------------------------ */

export const AttemptSummarySchema = z.object({
  txnRef: z.string(),
  paymentMethod: z.string(),
  status: z.string(),
  declineReason: z.string().nullable(),
  createdAt: z.string()
});

export const AssembledRecoveryContextSchema = z.object({
  schemaVersion: z.literal('v1.0.0'),
  assembledAt: z.string(),
  case: z.object({
    caseRef: z.string(),
    recoverableAmountMinorUnits: z.number().int().nonnegative(),
    currency: z.string(),
    originatingSignal: z.string(),
    failureCategory: z.string().nullable(),
    caseStatus: z.string(),
    caseAgeSeconds: z.number().int().nonnegative()
  }),
  transaction: z.object({
    txnRef: z.string(),
    paymentMethod: z.string(),
    declineReason: z.string().nullable(),
    failureReason: z.string().nullable(),
    gatewayCode: z.string().nullable(),
    attemptNumber: z.number().int().positive()
  }),
  customer: z.object({
    customerReference: z.string().regex(/^customer_ref_[0-9a-f]{8}$/),
    hasPriorSuccess: z.boolean(),
    priorSuccessCount: z.number().int().nonnegative(),
    priorFailureCount: z.number().int().nonnegative(),
    knownPaymentMethods: z.array(z.string())
  }),
  merchant: z.object({
    merchantReference: z.string().regex(/^merchant_ref_[0-9a-f]{8}$/),
    autonomyTier: z.string()
  }),
  history: z.object({
    totalPriorAttempts: z.number().int().nonnegative(),
    recentAttempts: z.array(AttemptSummarySchema),
    isTruncated: z.boolean()
  }),
  observability: z.object({
    correlationId: z.string(),
    assemblyDurationMs: z.number().nonnegative()
  })
});

export type AttemptSummary = z.infer<typeof AttemptSummarySchema>;
export type AssembledRecoveryContext = z.infer<typeof AssembledRecoveryContextSchema>;

export interface BuildContextInput {
  merchantId: number;
  caseId: number;
  correlationId?: string;
  maxHistoryRecords?: number;
}
