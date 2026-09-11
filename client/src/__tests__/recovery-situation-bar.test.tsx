import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SituationBar, formatMinorUnits } from '../pages/RecoveryPage';
import type { RecoveryAnalytics } from '../api/recovery';

describe('Recovery Cockpit Situation Bar (Task 3)', () => {
  const mockAnalytics: RecoveryAnalytics = {
    merchantId: 10,
    currency: 'INR',
    period: {
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-11T23:59:59Z'
    },
    counts: {
      totalCases: 10,
      eligibleCases: 8,
      ineligibleCases: 2,
      totalAttempts: 12,
      successfulRecoveries: 6,
      unrecoveredCases: 2,
      suppressedCases: 1,
      inFlightCases: 3
    },
    revenue: {
      totalDetectedMinorUnits: 500000,
      addressableMinorUnits: 400000,
      nonAddressableMinorUnits: 100000,
      recoveredRevenueMinorUnits: 300000,
      unrecoveredRevenueMinorUnits: 70000,
      suppressedRevenueMinorUnits: 20000,
      inFlightRevenueMinorUnits: 10000
    },
    rates: {
      recoveryRate: 0.75,
      revenueRecoveryRate: 0.75,
      attemptRecoveryRate: 0.5,
      overallCaseRecoveryRate: 0.6
    },
    latency: {
      sampleSize: 6,
      avgDurationSeconds: 120,
      minDurationSeconds: 30,
      maxDurationSeconds: 300,
      p50DurationSeconds: 110,
      p90DurationSeconds: 250,
      p99DurationSeconds: 290
    },
    strategyPerformance: [
      {
        strategy: 'RETRY_PAYMENT',
        attempts: 8,
        successfulRecoveries: 5,
        recoveryRate: 0.625,
        recoveredRevenueMinorUnits: 250000
      }
    ],
    categoryPerformance: [
      {
        failureCategory: 'INSUFFICIENT_FUNDS',
        isAddressable: true,
        caseCount: 5,
        detectedMinorUnits: 250000,
        recoveredMinorUnits: 180000,
        suppressedMinorUnits: 0,
        unrecoveredMinorUnits: 50000,
        inFlightMinorUnits: 20000
      }
    ],
    reconciliation: {
      isReconciled: true,
      varianceMinorUnits: 0
    }
  };

  describe('1. Four Situation Bar Metrics Display', () => {
    it('renders all four canonical metrics with accurate values and labels', () => {
      const html = renderToStaticMarkup(
        <SituationBar
          analytics={mockAnalytics}
          awaitingApprovalCount={2}
          isLoading={false}
          isError={false}
        />
      );

      // Verify all 4 metric titles are present
      expect(html).toContain('Recovered Revenue');
      expect(html).toContain('Value at Risk');
      expect(html).toContain('Recovery Rate');
      expect(html).toContain('Requires Attention');

      // 1. Recovered Revenue from revenue.recoveredRevenueMinorUnits (300000 minor units -> ₹3,000.00)
      expect(html).toContain(formatMinorUnits(300000, 'INR'));

      // 2. Value at Risk from revenue.addressableMinorUnits (400000 minor units -> ₹4,000.00)
      expect(html).toContain(formatMinorUnits(400000, 'INR'));

      // 3. Recovery Rate from rates.revenueRecoveryRate (0.75 -> 75.0%)
      expect(html).toContain('75.0%');

      // 4. Requires Attention / Awaiting Approval (2 cases)
      expect(html).toContain('2 cases awaiting approval');
      expect(html).toContain('data-testid="metric-requires-attention"');
    });

    it('formats single case awaiting approval with singular noun', () => {
      const html = renderToStaticMarkup(
        <SituationBar
          analytics={mockAnalytics}
          awaitingApprovalCount={1}
        />
      );

      expect(html).toContain('1 case awaiting approval');
    });
  });

  describe('2. Rate Formatting & Rounding', () => {
    it('formats rate with one decimal place correctly for fractions', () => {
      const customAnalytics: RecoveryAnalytics = {
        ...mockAnalytics,
        rates: {
          ...mockAnalytics.rates,
          revenueRecoveryRate: 0.6254
        }
      };

      const html = renderToStaticMarkup(
        <SituationBar
          analytics={customAnalytics}
          awaitingApprovalCount={0}
        />
      );

      // 0.6254 * 100 = 62.54 -> toFixed(1) = 62.5%
      expect(html).toContain('62.5%');
    });

    it('formats zero rate as 0.0%', () => {
      const zeroRateAnalytics: RecoveryAnalytics = {
        ...mockAnalytics,
        rates: {
          ...mockAnalytics.rates,
          revenueRecoveryRate: 0
        }
      };

      const html = renderToStaticMarkup(
        <SituationBar
          analytics={zeroRateAnalytics}
          awaitingApprovalCount={0}
        />
      );

      expect(html).toContain('0.0%');
    });
  });

  describe('3. Currency & Minor Units Formatting', () => {
    it('uses currency from analytics response for formatting', () => {
      const usdAnalytics: RecoveryAnalytics = {
        ...mockAnalytics,
        currency: 'USD',
        revenue: {
          ...mockAnalytics.revenue,
          recoveredRevenueMinorUnits: 125050,
          addressableMinorUnits: 250000
        }
      };

      const html = renderToStaticMarkup(
        <SituationBar
          analytics={usdAnalytics}
          awaitingApprovalCount={0}
        />
      );

      expect(html).toContain(formatMinorUnits(125050, 'USD'));
      expect(html).toContain(formatMinorUnits(250000, 'USD'));
    });
  });

  describe('4. Loading & Error States', () => {
    it('renders skeleton pulse cards when isLoading is true', () => {
      const html = renderToStaticMarkup(
        <SituationBar
          isLoading={true}
          isError={false}
        />
      );

      expect(html).toContain('data-testid="situation-bar-skeleton"');
      expect(html).toContain('animate-pulse');
      expect(html).not.toContain('data-testid="recovery-situation-bar"');
    });

    it('renders error banner with retry button when isError is true', () => {
      const handleRetry = vi.fn();
      const html = renderToStaticMarkup(
        <SituationBar
          isLoading={false}
          isError={true}
          onRetry={handleRetry}
        />
      );

      expect(html).toContain('data-testid="situation-bar-error"');
      expect(html).toContain('Failed to load recovery analytics metrics.');
      expect(html).toContain('Retry');
      expect(html).not.toContain('data-testid="recovery-situation-bar"');
    });
  });

  describe('5. Requires Attention Amber Alert Styling', () => {
    it('applies amber styling and pulsing indicator when awaitingApprovalCount > 0', () => {
      const html = renderToStaticMarkup(
        <SituationBar
          analytics={mockAnalytics}
          awaitingApprovalCount={3}
        />
      );

      expect(html).toContain('border-amber-300');
      expect(html).toContain('bg-amber-50/50');
      expect(html).toContain('text-amber-900');
      expect(html).toContain('animate-pulse');
    });

    it('applies neutral slate styling when awaitingApprovalCount is 0', () => {
      const html = renderToStaticMarkup(
        <SituationBar
          analytics={mockAnalytics}
          awaitingApprovalCount={0}
        />
      );

      expect(html).toContain('border-slate-200');
      expect(html).toContain('bg-white');
      expect(html).toContain('0 cases awaiting approval');
    });
  });

  describe('6. Distinction between inFlightCases and awaiting_approval', () => {
    it('proves Requires Attention uses awaitingApprovalCount and not inFlightCases', () => {
      // In mockAnalytics, inFlightCases is 3, but awaitingApprovalCount is passed as 1
      const html = renderToStaticMarkup(
        <SituationBar
          analytics={mockAnalytics}
          awaitingApprovalCount={1}
        />
      );

      // The card must show 1, NOT 3
      expect(html).toContain('1 case awaiting approval');
      expect(html).not.toContain('3 cases awaiting approval');
    });
  });
});
