import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yamljs';
import { metricsRegistry } from '../../infrastructure/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

interface GrafanaTarget {
  expr?: string;
  legendFormat?: string;
  refId?: string;
}

interface GrafanaPanel {
  id: number;
  title: string;
  type: string;
  targets?: GrafanaTarget[];
  panels?: GrafanaPanel[];
}

interface GrafanaDashboard {
  title: string;
  uid: string;
  schemaVersion: number;
  timezone: string;
  panels: GrafanaPanel[];
}

const PROMQL_KEYWORDS = new Set([
  'histogram_quantile',
  'rate',
  'irate',
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'increase',
  'delta',
  'by',
  'without',
  'offset',
  'bool',
  'or',
  'and',
  'unless',
  'inf',
  'nan',
  'le'
]);

/**
 * Resolves a Prometheus metric name back to its registered base name
 * (e.g. recovery_duration_seconds_bucket -> recovery_duration_seconds).
 */
function resolveBaseMetricName(metricName: string): string {
  if (metricName.endsWith('_bucket')) return metricName.replace(/_bucket$/, '');
  if (metricName.endsWith('_count')) return metricName.replace(/_count$/, '');
  if (metricName.endsWith('_sum')) return metricName.replace(/_sum$/, '');
  return metricName;
}

/**
 * Parses all metric names from a PromQL expression.
 */
function extractMetricNames(expr: string): string[] {
  // Matches metric identifiers like recovery_rate, recovery_cases_total, etc.
  const tokenRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  const metrics: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(expr)) !== null) {
    const token = match[1];
    if (PROMQL_KEYWORDS.has(token)) continue;
    // Skip numbers or duration tokens (e.g. 5m, 10s)
    if (/^\d+[smhdwy]?$/.test(token)) continue;
    // Filter out known label names when parsed in label contexts
    if (['status', 'status_code', 'currency', 'action_type', 'stage', 'source', 'method', 'route'].includes(token)) {
      continue;
    }
    metrics.push(token);
  }

  return Array.from(new Set(metrics));
}

/**
 * Parses all label names referenced in `by (...)` or `{label=...}` in a PromQL expression.
 */
function extractReferencedLabels(expr: string): string[] {
  const labels: string[] = [];

  // Match labels in `by (...)` or `without (...)`
  const byMatch = expr.match(/\bby\s*\(([^)]+)\)/);
  if (byMatch) {
    const byLabels = byMatch[1].split(',').map((l) => l.trim()).filter(Boolean);
    labels.push(...byLabels);
  }

  // Match label names inside `{...}`
  const filterMatch = expr.match(/\{([^}]+)\}/);
  if (filterMatch) {
    const filterParts = filterMatch[1].split(',');
    for (const part of filterParts) {
      const labelName = part.split(/[=~!]/)[0].trim();
      if (labelName) {
        labels.push(labelName);
      }
    }
  }

  return Array.from(new Set(labels));
}

/**
 * Recursively flattens all panels (including rows that contain collapsed/nested panels).
 */
function flattenPanels(panels: GrafanaPanel[]): GrafanaPanel[] {
  const result: GrafanaPanel[] = [];
  for (const panel of panels) {
    result.push(panel);
    if (panel.panels && Array.isArray(panel.panels)) {
      result.push(...flattenPanels(panel.panels));
    }
  }
  return result;
}

describe('Grafana Recovery & Revenue Observability Dashboard (E2 / BT-E2)', () => {
  const dashboardsDir = path.join(REPO_ROOT, 'docker/grafana/dashboards');
  const dashboardsConfigPath = path.join(REPO_ROOT, 'docker/grafana/dashboards.yml');
  const dockerComposePath = path.join(REPO_ROOT, 'docker-compose.yml');

  const registeredMetrics = metricsRegistry.getMetricsAsArray();
  const registeredMetricNames = new Set(registeredMetrics.map((m) => m.name));

  // Map of metricName -> Set of valid labels (with 'le' for histograms)
  const metricLabelMap = new Map<string, Set<string>>();
  for (const m of registeredMetrics) {
    const labels = new Set<string>((m as unknown as { labelNames: string[] }).labelNames || []);
    // Histograms automatically support 'le' in Prometheus bucket queries
    const metricType = (m as unknown as { type: string }).type;
    if (metricType === 'histogram') {
      labels.add('le');
    }
    metricLabelMap.set(m.name, labels);
  }

  describe('1. Dashboard Files & JSON Structure', () => {
    it('finds dashboard files in docker/grafana/dashboards directory', () => {
      expect(fs.existsSync(dashboardsDir)).toBe(true);
      const files = fs.readdirSync(dashboardsDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files).toContain('recovery-overview.json');
    });

    it('parses all dashboard JSON files cleanly without syntax errors', () => {
      const files = fs.readdirSync(dashboardsDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(dashboardsDir, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        expect(() => JSON.parse(raw)).not.toThrow();
      }
    });

    it('validates recovery-overview.json required Grafana metadata schema', () => {
      const filePath = path.join(dashboardsDir, 'recovery-overview.json');
      const dashboard: GrafanaDashboard = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      expect(typeof dashboard.title).toBe('string');
      expect(dashboard.title.length).toBeGreaterThan(0);
      expect(dashboard.title).toContain('PayBridge');

      expect(typeof dashboard.uid).toBe('string');
      expect(dashboard.uid).toBe('paybridge-recovery-overview');

      expect(typeof dashboard.schemaVersion).toBe('number');
      expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(30);

      expect(typeof dashboard.timezone).toBe('string');
      expect(['browser', 'utc']).toContain(dashboard.timezone);

      expect(Array.isArray(dashboard.panels)).toBe(true);
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe('2. Panel Coverage & Metrics Traceability', () => {
    const dashboard: GrafanaDashboard = JSON.parse(
      fs.readFileSync(path.join(dashboardsDir, 'recovery-overview.json'), 'utf8')
    );
    const allPanels = flattenPanels(dashboard.panels);
    const queryPanels = allPanels.filter((p) => p.targets && p.targets.length > 0);

    it('contains at least 13 query panels covering the required recovery & revenue domains', () => {
      expect(queryPanels.length).toBeGreaterThanOrEqual(13);
    });

    it('every PromQL expression strictly references registered metric names without hallucinations', () => {
      for (const panel of queryPanels) {
        for (const target of panel.targets || []) {
          if (!target.expr) continue;
          const extractedMetrics = extractMetricNames(target.expr);
          expect(extractedMetrics.length).toBeGreaterThan(0);

          for (const metric of extractedMetrics) {
            const baseName = resolveBaseMetricName(metric);
            expect(
              registeredMetricNames.has(baseName),
              `Panel "${panel.title}" references unknown metric "${metric}" (resolved base: "${baseName}") in expression: ${target.expr}`
            ).toBe(true);
          }
        }
      }
    });

    it('rejects hallucinated or non-existent metric names in validation logic', () => {
      const fakeExpr = 'sum(fake_recovery_profit_metric_total) by (merchant_id)';
      const extracted = extractMetricNames(fakeExpr);
      expect(extracted).toContain('fake_recovery_profit_metric_total');
      const baseName = resolveBaseMetricName(extracted[0]);
      expect(registeredMetricNames.has(baseName)).toBe(false);
    });

    it('covers all critical PayBridge recovery and revenue metrics', () => {
      const allExpressions = queryPanels
        .flatMap((p) => (p.targets || []).map((t) => t.expr || ''))
        .join(' ');

      // Core recovery KPIs
      expect(allExpressions).toContain('recovery_rate');
      expect(allExpressions).toContain('recovery_revenue_recovered_minor_units_total');
      expect(allExpressions).toContain('recovery_cases_total');
      expect(allExpressions).toContain('recovery_attempts_total');
      expect(allExpressions).toContain('recovery_duration_seconds_bucket');
      expect(allExpressions).toContain('recovery_action_executions_total');
      expect(allExpressions).toContain('recovery_action_duplicates_suppressed_total');

      // Abandonment telemetry
      expect(allExpressions).toContain('checkout_abandonments_detected_total');
      expect(allExpressions).toContain('checkout_abandonment_recoveries_total');
      expect(allExpressions).toContain('checkout_abandonment_dwell_time_seconds_bucket');

      // Ingress SLIs
      expect(allExpressions).toContain('http_requests_total');
      expect(allExpressions).toContain('http_request_duration_seconds_bucket');
    });

    it('preserves integer minor units semantics and currency label on recovered revenue', () => {
      const revenuePanel = queryPanels.find((p) => p.title.includes('Total Recovered Revenue'));
      expect(revenuePanel).toBeDefined();

      const expr = revenuePanel!.targets![0].expr || '';
      expect(expr).toContain('recovery_revenue_recovered_minor_units_total');
      expect(expr).toContain('currency');
    });

    it('uses correct histogram_quantile and rate semantics for duration metrics', () => {
      const durationPanels = queryPanels.filter(
        (p) =>
          p.title.includes('Time to Recovery') ||
          p.title.includes('Dwell-Time') ||
          p.title.includes('P95')
      );
      expect(durationPanels.length).toBeGreaterThanOrEqual(3);

      for (const panel of durationPanels) {
        for (const target of panel.targets || []) {
          const expr = target.expr || '';
          expect(expr).toContain('histogram_quantile');
          expect(expr).toContain('rate');
          expect(expr).toContain('_bucket');
          expect(expr).toContain('le');
        }
      }
    });
  });

  describe('3. PromQL Label Validation & Non-Hallucination', () => {
    const dashboard: GrafanaDashboard = JSON.parse(
      fs.readFileSync(path.join(dashboardsDir, 'recovery-overview.json'), 'utf8')
    );
    const allPanels = flattenPanels(dashboard.panels);
    const queryPanels = allPanels.filter((p) => p.targets && p.targets.length > 0);

    it('all referenced label names correspond to actual metric label definitions', () => {
      for (const panel of queryPanels) {
        for (const target of panel.targets || []) {
          if (!target.expr) continue;
          const extractedMetrics = extractMetricNames(target.expr);
          const referencedLabels = extractReferencedLabels(target.expr);

          for (const metric of extractedMetrics) {
            const baseName = resolveBaseMetricName(metric);
            const validLabels = metricLabelMap.get(baseName);
            expect(
              validLabels,
              `Metric ${baseName} must exist in metricLabelMap`
            ).toBeDefined();

            for (const label of referencedLabels) {
              expect(
                validLabels!.has(label),
                `Panel "${panel.title}" references invalid label "${label}" for metric "${baseName}". Valid labels are: ${Array.from(validLabels!).join(', ')}`
              ).toBe(true);
            }
          }
        }
      }
    });

    it('rejects hallucinated or invalid label names on metrics', () => {
      // recovery_cases_total only has 'status' as a label
      const validLabels = metricLabelMap.get('recovery_cases_total');
      expect(validLabels?.has('status')).toBe(true);
      expect(validLabels?.has('fake_tenant_uuid')).toBe(false);
      expect(validLabels?.has('unregistered_tag')).toBe(false);
    });
  });

  describe('4. Grafana Provisioning Configuration (dashboards.yml)', () => {
    it('verifies dashboards.yml exists and parses as valid YAML', () => {
      expect(fs.existsSync(dashboardsConfigPath)).toBe(true);
      const parsed = YAML.load(dashboardsConfigPath);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe('object');
    });

    it('has apiVersion 1 and configured file provider pointing to mounted path', () => {
      const parsed = YAML.load(dashboardsConfigPath) as {
        apiVersion: number;
        providers: Array<{
          name: string;
          type: string;
          options: { path: string };
        }>;
      };

      expect(parsed.apiVersion).toBe(1);
      expect(Array.isArray(parsed.providers)).toBe(true);
      expect(parsed.providers.length).toBeGreaterThanOrEqual(1);

      const provider = parsed.providers[0];
      expect(typeof provider.name).toBe('string');
      expect(provider.name.length).toBeGreaterThan(0);
      expect(provider.type).toBe('file');

      expect(provider.options).toBeDefined();
      expect(provider.options.path).toBe('/var/lib/grafana/dashboards');
    });
  });

  describe('5. Docker Compose Mount Alignment', () => {
    it('verifies docker-compose.yml defines required Grafana dashboard mounts', () => {
      expect(fs.existsSync(dockerComposePath)).toBe(true);
      const compose = YAML.load(dockerComposePath) as {
        services?: {
          grafana?: {
            volumes?: string[];
          };
        };
      };

      expect(compose.services).toBeDefined();
      expect(compose.services?.grafana).toBeDefined();
      const volumes = compose.services?.grafana?.volumes;
      expect(Array.isArray(volumes)).toBe(true);

      // Verify dashboard provisioning config mount
      const configMount = volumes!.find((v) =>
        v.includes('dashboards.yml') && v.includes('/etc/grafana/provisioning/dashboards/dashboards.yml')
      );
      expect(
        configMount,
        'docker-compose.yml must mount dashboards.yml into /etc/grafana/provisioning/dashboards/dashboards.yml'
      ).toBeDefined();

      // Verify dashboard JSON directory mount
      const dirMount = volumes!.find((v) =>
        v.includes('docker/grafana/dashboards') && v.includes('/var/lib/grafana/dashboards')
      );
      expect(
        dirMount,
        'docker-compose.yml must mount docker/grafana/dashboards into /var/lib/grafana/dashboards'
      ).toBeDefined();
    });

    it('asserts docker-compose directory mount matches dashboards.yml provider path exactly', () => {
      const compose = YAML.load(dockerComposePath) as {
        services: { grafana: { volumes: string[] } };
      };
      const dashboardsConfig = YAML.load(dashboardsConfigPath) as {
        providers: Array<{ options: { path: string } }>;
      };

      const expectedContainerPath = dashboardsConfig.providers[0].options.path;
      const matchingVolume = compose.services.grafana.volumes.find((v) =>
        v.endsWith(`:${expectedContainerPath}`)
      );

      expect(
        matchingVolume,
        `docker-compose.yml volume mount must terminate in ${expectedContainerPath}`
      ).toBeDefined();
    });
  });
});
