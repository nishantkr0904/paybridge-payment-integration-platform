import type { LLMProvider } from '../../../infrastructure/llm/llm.types.js';
import { MockLLMProvider } from '../../../infrastructure/llm/mock-provider.js';
import { diagnosePaymentFailure } from '../diagnosis/diagnosis.agent.js';
import { computeExpectedCalibrationError } from './calibration.js';
import { GOLDEN_DATASET } from './golden-dataset.js';
import type {
  CaseEvaluationDetail,
  CategoryMetric,
  EvaluationMetrics,
  EvaluationReport,
  GoldenTestCase,
  QualityGateThresholds
} from './evaluation.types.js';

/* ------------------------------------------------------------------ */
/*  Evaluation Error                                                  */
/* ------------------------------------------------------------------ */

export class EvaluationGateFailedError extends Error {
  constructor(
    public readonly violations: string[],
    public readonly report: EvaluationReport
  ) {
    super(`Evaluation Quality Gate Failed:\n- ${violations.join('\n- ')}`);
    this.name = 'EvaluationGateFailedError';
  }
}

/* ------------------------------------------------------------------ */
/*  Evaluation Options Interface                                      */
/* ------------------------------------------------------------------ */

export interface RunEvaluationOptions {
  dataset?: GoldenTestCase[];
  provider?: LLMProvider;
  promptId?: string;
  promptVersion?: string;
  baselineReport?: EvaluationReport;
  thresholds?: QualityGateThresholds;
}

/* ------------------------------------------------------------------ */
/*  Evaluation Harness Runner (AI-011 / TEST-006)                     */
/* ------------------------------------------------------------------ */

export async function runEvaluation(
  options: RunEvaluationOptions = {}
): Promise<EvaluationReport> {
  const dataset = options.dataset || GOLDEN_DATASET;
  const provider = options.provider || new MockLLMProvider();
  const promptId = options.promptId || 'payment_failure_diagnosis';
  const promptVersion = options.promptVersion || 'v1.0.0';
  const startTime = Date.now();

  const caseDetails: CaseEvaluationDetail[] = [];
  const calibrationSamples: Array<{ confidence: number; isCorrect: boolean }> = [];
  const perCategoryMap = new Map<string, { total: number; correct: number; confSum: number }>();

  let correctCategories = 0;
  let correctRecoverable = 0;
  let correctStrategies = 0;
  let devCases = 0;
  let heldOutCases = 0;
  let correctHeldOut = 0;

  for (const testCase of dataset) {
    if (testCase.isHeldOut) {
      heldOutCases++;
    } else {
      devCases++;
    }

    // Run diagnosis agent against LLM provider
    const diagnosis = await diagnosePaymentFailure(
      {
        context: testCase.context,
        correlationId: `EVAL_${testCase.id}_${Date.now()}`
      },
      provider
    );

    const categoryMatched = diagnosis.category === testCase.expectedCategory;
    const recoverableMatched = diagnosis.recoverable === testCase.expectedRecoverable;
    const strategyMatched = testCase.acceptableStrategies.includes(diagnosis.recommendedStrategy);

    if (categoryMatched) correctCategories++;
    if (recoverableMatched) correctRecoverable++;
    if (strategyMatched) correctStrategies++;

    if (testCase.isHeldOut && categoryMatched) {
      correctHeldOut++;
    }

    calibrationSamples.push({
      confidence: diagnosis.confidence,
      isCorrect: categoryMatched
    });

    // Accumulate per-category statistics
    const catKey = testCase.expectedCategory;
    const existing = perCategoryMap.get(catKey) || { total: 0, correct: 0, confSum: 0 };
    existing.total++;
    if (categoryMatched) existing.correct++;
    existing.confSum += diagnosis.confidence;
    perCategoryMap.set(catKey, existing);

    caseDetails.push({
      caseId: testCase.id,
      isHeldOut: testCase.isHeldOut,
      expectedCategory: testCase.expectedCategory,
      predictedCategory: diagnosis.category,
      categoryMatched,
      expectedRecoverable: testCase.expectedRecoverable,
      predictedRecoverable: diagnosis.recoverable,
      recoverableMatched,
      acceptableStrategies: testCase.acceptableStrategies,
      predictedStrategy: diagnosis.recommendedStrategy,
      strategyMatched,
      confidence: diagnosis.confidence,
      provenanceSource: diagnosis.provenance.source,
      rationale: diagnosis.explanation
    });
  }

  const totalCases = dataset.length;
  const categoryAccuracy = totalCases > 0 ? correctCategories / totalCases : 0;
  const recoverabilityAccuracy = totalCases > 0 ? correctRecoverable / totalCases : 0;
  const strategyOverlap = totalCases > 0 ? correctStrategies / totalCases : 0;
  const heldOutAccuracy = heldOutCases > 0 ? correctHeldOut / heldOutCases : 0;
  const meanConfidence =
    calibrationSamples.reduce((s, c) => s + c.confidence, 0) / (totalCases || 1);

  const { ece, buckets } = computeExpectedCalibrationError(calibrationSamples, 5);

  const perCategory: Record<string, CategoryMetric> = {};
  for (const [cat, data] of perCategoryMap.entries()) {
    perCategory[cat] = {
      category: cat,
      total: data.total,
      correct: data.correct,
      accuracy: data.total > 0 ? Number((data.correct / data.total).toFixed(4)) : 0,
      meanConfidence: data.total > 0 ? Number((data.confSum / data.total).toFixed(4)) : 0
    };
  }

  const metrics: EvaluationMetrics = {
    totalCases,
    developmentCases: devCases,
    heldOutCases,
    categoryAccuracy: Number(categoryAccuracy.toFixed(4)),
    recoverabilityAccuracy: Number(recoverabilityAccuracy.toFixed(4)),
    strategyOverlap: Number(strategyOverlap.toFixed(4)),
    meanConfidence: Number(meanConfidence.toFixed(4)),
    expectedCalibrationError: ece,
    heldOutAccuracy: Number(heldOutAccuracy.toFixed(4)),
    perCategory,
    calibrationBuckets: buckets,
    durationMs: Date.now() - startTime
  };

  // Check Quality Gate
  const thresholds: QualityGateThresholds = {
    minCategoryAccuracy: 0.90,
    maxCalibrationError: 0.10,
    minHeldOutAccuracy: 0.90,
    minStrategyOverlap: 0.85,
    maxRegressionDrop: 0.02,
    ...options.thresholds
  };

  const gateViolations: string[] = [];

  if (metrics.categoryAccuracy < (thresholds.minCategoryAccuracy ?? 0.90)) {
    gateViolations.push(
      `Category accuracy (${(metrics.categoryAccuracy * 100).toFixed(1)}%) is below threshold (${((thresholds.minCategoryAccuracy ?? 0.90) * 100).toFixed(1)}%)`
    );
  }

  if (metrics.expectedCalibrationError > (thresholds.maxCalibrationError ?? 0.10)) {
    gateViolations.push(
      `Expected Calibration Error (${metrics.expectedCalibrationError}) exceeds threshold (${thresholds.maxCalibrationError ?? 0.10})`
    );
  }

  if (metrics.heldOutCases > 0 && metrics.heldOutAccuracy < (thresholds.minHeldOutAccuracy ?? 0.90)) {
    gateViolations.push(
      `Held-out accuracy (${(metrics.heldOutAccuracy * 100).toFixed(1)}%) is below threshold (${((thresholds.minHeldOutAccuracy ?? 0.90) * 100).toFixed(1)}%)`
    );
  }

  if (metrics.strategyOverlap < (thresholds.minStrategyOverlap ?? 0.85)) {
    gateViolations.push(
      `Strategy overlap (${(metrics.strategyOverlap * 100).toFixed(1)}%) is below threshold (${((thresholds.minStrategyOverlap ?? 0.85) * 100).toFixed(1)}%)`
    );
  }

  // Regression check against baseline incumbent
  if (options.baselineReport) {
    const baselineAcc = options.baselineReport.metrics.categoryAccuracy;
    const drop = baselineAcc - metrics.categoryAccuracy;
    const maxDrop = thresholds.maxRegressionDrop ?? 0.02;
    if (drop > maxDrop) {
      gateViolations.push(
        `Accuracy regressed by ${(drop * 100).toFixed(1)}% against incumbent baseline (allowed drop: ${(maxDrop * 100).toFixed(1)}%)`
      );
    }
  }

  const report: EvaluationReport = {
    timestamp: new Date().toISOString(),
    promptId,
    promptVersion,
    modelId: 'mock-llm',
    metrics,
    gatePassed: gateViolations.length === 0,
    gateViolations,
    caseDetails
  };

  return report;
}

/**
 * Asserts that an evaluation report satisfies all Quality Gate criteria.
 * Throws EvaluationGateFailedError on failure.
 */
export function assertQualityGate(
  report: EvaluationReport
): void {
  if (!report.gatePassed || report.gateViolations.length > 0) {
    throw new EvaluationGateFailedError(report.gateViolations, report);
  }
}
