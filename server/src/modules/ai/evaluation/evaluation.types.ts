import { z } from 'zod';
import {
  FailureCategorySchema,
  RecommendedStrategySchema
} from '../diagnosis/diagnosis.types.js';
import { AssembledRecoveryContextSchema } from '../redaction.types.js';

/* ------------------------------------------------------------------ */
/*  Canonical Golden Test Case Schema (AI-011 / TEST-006)             */
/* ------------------------------------------------------------------ */

export const GoldenTestCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  signalType: z.enum(['payment_failed', 'abandonment', 'gateway_timeout', 'webhook_event']),
  context: AssembledRecoveryContextSchema,
  expectedCategory: FailureCategorySchema,
  expectedRecoverable: z.boolean(),
  acceptableStrategies: z.array(RecommendedStrategySchema).min(1),
  expectedPrimaryTool: z.string().optional(),
  labeller: z.string(),
  labelledAt: z.string(),
  consensusFlag: z.boolean().default(true),
  labellingRationale: z.string(),
  isHeldOut: z.boolean().default(false)
});

export type GoldenTestCase = z.infer<typeof GoldenTestCaseSchema>;

/* ------------------------------------------------------------------ */
/*  Calibration & Bucket Telemetry Types                              */
/* ------------------------------------------------------------------ */

export interface CalibrationBucket {
  binRange: [number, number];
  count: number;
  meanConfidence: number;
  accuracy: number;
  calibrationGap: number;
}

export interface CategoryMetric {
  category: string;
  total: number;
  correct: number;
  accuracy: number;
  meanConfidence: number;
}

/* ------------------------------------------------------------------ */
/*  Aggregate Evaluation Metrics (AI-011 Requirements 4, 5, 7)        */
/* ------------------------------------------------------------------ */

export interface EvaluationMetrics {
  totalCases: number;
  developmentCases: number;
  heldOutCases: number;
  categoryAccuracy: number;
  recoverabilityAccuracy: number;
  strategyOverlap: number;
  meanConfidence: number;
  expectedCalibrationError: number;
  heldOutAccuracy: number;
  perCategory: Record<string, CategoryMetric>;
  calibrationBuckets: CalibrationBucket[];
  durationMs: number;
}

/* ------------------------------------------------------------------ */
/*  Quality Gate Thresholds & Verification Report                     */
/* ------------------------------------------------------------------ */

export interface QualityGateThresholds {
  minCategoryAccuracy?: number; // default: 0.90 (90%)
  maxCalibrationError?: number; // default: 0.10 (ECE < 0.1)
  minHeldOutAccuracy?: number;  // default: 0.90 (90%)
  minStrategyOverlap?: number;  // default: 0.85 (85%)
  maxRegressionDrop?: number;   // default: 0.02 (2 points)
}

export interface CaseEvaluationDetail {
  caseId: string;
  isHeldOut: boolean;
  expectedCategory: string;
  predictedCategory: string;
  categoryMatched: boolean;
  expectedRecoverable: boolean;
  predictedRecoverable: boolean;
  recoverableMatched: boolean;
  acceptableStrategies: string[];
  predictedStrategy: string;
  strategyMatched: boolean;
  confidence: number;
  provenanceSource: 'model' | 'rules';
  rationale: string;
}

export interface EvaluationReport {
  timestamp: string;
  promptId: string;
  promptVersion: string;
  modelId: string;
  metrics: EvaluationMetrics;
  gatePassed: boolean;
  gateViolations: string[];
  caseDetails: CaseEvaluationDetail[];
}
