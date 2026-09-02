import type { CalibrationBucket } from './evaluation.types.js';

export interface CalibrationSample {
  confidence: number;
  isCorrect: boolean;
}

/**
 * Computes Expected Calibration Error (ECE) across confidence bins.
 * Evaluates whether predicted confidence aligns with realised empirical accuracy.
 * (AI-011 Requirement 5)
 */
export function computeExpectedCalibrationError(
  samples: CalibrationSample[],
  numBins = 5
): {
  ece: number;
  buckets: CalibrationBucket[];
} {
  if (samples.length === 0) {
    return { ece: 0, buckets: [] };
  }

  const binSize = 1.0 / numBins;
  const buckets: CalibrationBucket[] = [];
  let weightedCalibrationSum = 0;

  for (let i = 0; i < numBins; i++) {
    const binStart = i * binSize;
    const binEnd = (i + 1) * binSize;

    // Filter samples belonging to this confidence bucket
    const binSamples = samples.filter((s) => {
      const conf = Math.max(0, Math.min(1, s.confidence));
      if (i === numBins - 1) {
        return conf >= binStart && conf <= binEnd;
      }
      return conf >= binStart && conf < binEnd;
    });

    const count = binSamples.length;
    if (count === 0) {
      buckets.push({
        binRange: [Number(binStart.toFixed(2)), Number(binEnd.toFixed(2))],
        count: 0,
        meanConfidence: 0,
        accuracy: 0,
        calibrationGap: 0
      });
      continue;
    }

    const meanConfidence =
      binSamples.reduce((sum, s) => sum + s.confidence, 0) / count;
    const accuracy =
      binSamples.filter((s) => s.isCorrect).length / count;
    const calibrationGap = Math.abs(accuracy - meanConfidence);

    weightedCalibrationSum += (count / samples.length) * calibrationGap;

    buckets.push({
      binRange: [Number(binStart.toFixed(2)), Number(binEnd.toFixed(2))],
      count,
      meanConfidence: Number(meanConfidence.toFixed(4)),
      accuracy: Number(accuracy.toFixed(4)),
      calibrationGap: Number(calibrationGap.toFixed(4))
    });
  }

  return {
    ece: Number(weightedCalibrationSum.toFixed(4)),
    buckets
  };
}
