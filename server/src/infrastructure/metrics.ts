import client from 'prom-client';

export const metricsRegistry = new client.Registry();

// Enable default Node.js runtime metrics (memory, CPU, event loop lag, etc.)
client.collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry]
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry]
});

export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export function resetMetricsRegistry(): void {
  metricsRegistry.resetMetrics();
}
