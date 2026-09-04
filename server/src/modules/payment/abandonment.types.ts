import { z } from 'zod';

/* ------------------------------------------------------------------ */
/*  Checkout Abandonment Enums & Stages (SIG-002 / BT-D1)             */
/* ------------------------------------------------------------------ */

export const CHECKOUT_ABANDONMENT_STAGES = [
  'arrived_only',
  'method_selected',
  'details_entered',
  'submit_attempted_failed_validation',
  'submit_blocked'
] as const;

export type CheckoutAbandonmentStage = (typeof CHECKOUT_ABANDONMENT_STAGES)[number];

export const ABANDONMENT_SOURCES = [
  'client_beacon',
  'timeout_detector',
  'merchant_api',
  'webhook',
  'test'
] as const;

export type AbandonmentSource = (typeof ABANDONMENT_SOURCES)[number];

export const PAYMENT_METHODS = ['card', 'upi', 'netbanking', 'wallet'] as const;
export type AbandonmentPaymentMethod = (typeof PAYMENT_METHODS)[number];

/* ------------------------------------------------------------------ */
/*  Checkout Abandonment Ingestion Request Schema                     */
/* ------------------------------------------------------------------ */

export const CheckoutAbandonmentInputSchema = z.object({
  sessionId: z.string().min(1).max(255).optional(),
  stage: z.enum(CHECKOUT_ABANDONMENT_STAGES, {
    errorMap: () => ({
      message: `stage must be one of: ${CHECKOUT_ABANDONMENT_STAGES.join(', ')}`
    })
  }),
  selectedPaymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  dwellTimeSeconds: z.number().min(0, 'dwellTimeSeconds must be greater than or equal to 0').default(0),
  validationFailureCount: z.number().int().min(0, 'validationFailureCount must be a non-negative integer').default(0),
  customerEmail: z.string().email('customerEmail must be a valid email address').max(255).nullable().optional(),
  customerPhone: z.string().max(50).nullable().optional(),
  hasConsentedChannel: z.boolean().default(false),
  lastActiveAt: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), { message: 'lastActiveAt must be a valid ISO 8601 timestamp string.' })
    .optional(),
  abandonedAt: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), { message: 'abandonedAt must be a valid ISO 8601 timestamp string.' })
    .optional(),
  source: z.enum(ABANDONMENT_SOURCES).default('merchant_api'),
  metadata: z.record(z.unknown()).optional()
});

export type CheckoutAbandonmentInput = z.input<typeof CheckoutAbandonmentInputSchema>;
export type CheckoutAbandonmentData = z.output<typeof CheckoutAbandonmentInputSchema>;

/* ------------------------------------------------------------------ */
/*  Canonical Checkout Abandoned Event Schema (§8 / SIG-002 / BT-D1)  */
/* ------------------------------------------------------------------ */

export const CheckoutAbandonedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal('checkout.abandoned'),
  merchantId: z.number().int().positive('merchantId must be a positive integer'),
  orderId: z.number().int().positive('orderId must be a positive integer'),
  orderRef: z.string().min(1, 'orderRef is required'),
  sessionId: z.string().nullable().optional(),
  stage: z.enum(CHECKOUT_ABANDONMENT_STAGES),
  selectedPaymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  dwellTimeSeconds: z.number().min(0),
  validationFailureCount: z.number().int().min(0),
  amountMinorUnits: z.number().int().positive('amountMinorUnits must be a positive integer in minor units'),
  currency: z.string().length(3).transform((s) => s.toUpperCase()),
  customerEmail: z.string().email().nullable().optional(),
  customerPhone: z.string().nullable().optional(),
  hasConsentedChannel: z.boolean().default(false),
  lastActiveAt: z.string().refine((val) => !isNaN(Date.parse(val))),
  abandonedAt: z.string().refine((val) => !isNaN(Date.parse(val))),
  source: z.enum(ABANDONMENT_SOURCES),
  correlationId: z.string().min(1, 'correlationId is required'),
  traceId: z.string().min(1, 'traceId is required'),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export type CheckoutAbandonedEvent = z.infer<typeof CheckoutAbandonedEventSchema>;

/* ------------------------------------------------------------------ */
/*  Ingestion Result & History Types                                  */
/* ------------------------------------------------------------------ */

export interface AbandonmentIngestionResult {
  success: boolean;
  eventId: string;
  orderRef: string;
  merchantId: number;
  stage: CheckoutAbandonmentStage;
  amountMinorUnits: number;
  currency: string;
  isDuplicate: boolean;
  routingKey: string;
  correlationId: string;
  timestamp: string;
}

export interface OrderAbandonmentRecord {
  isDuplicate: boolean;
  totalAbandonmentCount: number;
  recordedAt: string;
}
