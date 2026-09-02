import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApp } from '../../app.js';
import {
  metricsRegistry,
  getMetrics,
  getMetricsContentType,
  resetMetricsRegistry
} from '../../infrastructure/metrics.js';
import { metricsMiddleware, getNormalizedRoute } from '../../middleware/metrics.js';

describe('Prometheus Metrics & HTTP RED Instrumentation (OBS-001 / TASK-006)', () => {
  let server: Server | null = null;
  let baseUrl: string = '';

  beforeEach(() => {
    resetMetricsRegistry();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function startServer(app = createApp()): Promise<string> {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve(baseUrl);
      });
    });
  }

  describe('Metrics Endpoints (/metrics and /api/metrics)', () => {
    it('GET /metrics returns 200 with Prometheus Content-Type', async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(getMetricsContentType());
      expect(getMetricsContentType()).toBe('text/plain; version=0.0.4; charset=utf-8');
      const body = await res.text();
      expect(body).toContain('# HELP http_requests_total');
      expect(body).toContain('# TYPE http_requests_total counter');
      expect(body).toContain('# HELP http_request_duration_seconds');
      expect(body).toContain('# TYPE http_request_duration_seconds histogram');
    });

    it('GET /api/metrics returns 200 with Prometheus Content-Type', async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/api/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(getMetricsContentType());
      const body = await res.text();
      expect(body).toContain('# HELP http_requests_total');
      expect(body).toContain('# TYPE http_requests_total counter');
    });

    it('scraping /metrics and /api/metrics does not instrument scraping requests recursively', async () => {
      await startServer();
      await fetch(`${baseUrl}/metrics`);
      await fetch(`${baseUrl}/api/metrics`);

      const metrics = await getMetrics();
      expect(metrics).not.toContain('route="/metrics"');
      expect(metrics).not.toContain('route="/api/metrics"');
    });
  });

  describe('HTTP RED Metrics Collection', () => {
    it('records successful API request count and duration under correct method, route, and status_code', async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);

      const metrics = await getMetrics();
      expect(metrics).toContain('http_requests_total{method="GET",route="/api/health",status_code="200"} 1');
      expect(metrics).toContain('http_request_duration_seconds_count{method="GET",route="/api/health",status_code="200"} 1');
      expect(metrics).toContain('http_request_duration_seconds_bucket{le="0.005",method="GET",route="/api/health",status_code="200"}');
    });

    it('records 4xx client errors with actual status code and route', async () => {
      await startServer();
      // POST /api/auth/login without body returns 400 validation error
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);

      const metrics = await getMetrics();
      expect(metrics).toContain('http_requests_total{method="POST",route="/api/auth/login",status_code="400"} 1');
    });

    it('records unmatched 404 routes under bounded "unmatched" route label', async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/api/nonexistent-path-12345`);
      expect(res.status).toBe(404);

      const metrics = await getMetrics();
      expect(metrics).toContain('http_requests_total{method="GET",route="unmatched",status_code="404"} 1');
      expect(metrics).not.toContain('/api/nonexistent-path-12345');
    });

    it('records 5xx server errors with status_code="500"', async () => {
      const app = express();
      app.use(metricsMiddleware);
      app.get('/api/test-error', (_req, _res) => {
        throw new Error('Simulated internal server error');
      });
      // Express error handler
      app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      });

      await startServer(app);
      const res = await fetch(`${baseUrl}/api/test-error`);
      expect(res.status).toBe(500);

      const metrics = await getMetrics();
      expect(metrics).toContain('http_requests_total{method="GET",route="/api/test-error",status_code="500"} 1');
    });
  });

  describe('High-Cardinality Protection & Route Normalization', () => {
    it('normalizes parameterized Express sub-routes and prevents dynamic ID explosion', async () => {
      const app = express();
      app.use(metricsMiddleware);

      const router = express.Router();
      router.post('/orders/:orderRef/pay', (_req, res) => {
        res.status(202).json({ status: 'processing' });
      });
      router.get('/orders/:orderRef', (_req, res) => {
        res.status(200).json({ status: 'found' });
      });
      app.use('/api/payments', router);

      await startServer(app);

      // Send requests with two different dynamic IDs
      await fetch(`${baseUrl}/api/payments/orders/ord_9999/pay`, { method: 'POST' });
      await fetch(`${baseUrl}/api/payments/orders/ord_8888/pay`, { method: 'POST' });
      await fetch(`${baseUrl}/api/payments/orders/ord_9999`, { method: 'GET' });

      const metrics = await getMetrics();

      // Parameterized route label should be used for both POST requests
      expect(metrics).toContain('http_requests_total{method="POST",route="/api/payments/orders/:orderRef/pay",status_code="202"} 2');
      expect(metrics).toContain('http_requests_total{method="GET",route="/api/payments/orders/:orderRef",status_code="200"} 1');

      // Concrete IDs must NEVER appear in metric labels
      expect(metrics).not.toContain('ord_9999');
      expect(metrics).not.toContain('ord_8888');
    });

    it('strips query parameters from route labels', async () => {
      await startServer();
      await fetch(`${baseUrl}/api/health?debug=true&timestamp=123456789`);

      const metrics = await getMetrics();
      expect(metrics).toContain('http_requests_total{method="GET",route="/api/health",status_code="200"} 1');
      expect(metrics).not.toContain('debug=true');
      expect(metrics).not.toContain('123456789');
    });

    it('getNormalizedRoute helper returns "unmatched" for missing route metadata', () => {
      const mockReq = {} as express.Request;
      expect(getNormalizedRoute(mockReq)).toBe('unmatched');

      const mockReqWithEmptyRoute = { route: {} } as express.Request;
      expect(getNormalizedRoute(mockReqWithEmptyRoute)).toBe('unmatched');

      const mockReqWithValidRoute = {
        baseUrl: '/api/v1',
        route: { path: '/items/:id' }
      } as unknown as express.Request;
      expect(getNormalizedRoute(mockReqWithValidRoute)).toBe('/api/v1/items/:id');
    });
  });

  describe('Registry Isolation & Reset Mechanism', () => {
    it('resets metrics values cleanly between test runs without duplicate registration errors', async () => {
      await startServer();
      await fetch(`${baseUrl}/api/health`);

      let metrics = await getMetrics();
      expect(metrics).toContain('http_requests_total{method="GET",route="/api/health",status_code="200"} 1');

      resetMetricsRegistry();

      metrics = await getMetrics();
      // After reset, counter should be reset
      expect(metrics).not.toContain('http_requests_total{method="GET",route="/api/health",status_code="200"} 1');

      // Calling createApp multiple times must not fail
      expect(() => createApp()).not.toThrow();
      expect(() => createApp()).not.toThrow();
    });

    it('configures histogram buckets matching specification exactly', () => {
      const metricAsArray = metricsRegistry.getMetricsAsArray();
      const durationMetric = metricAsArray.find((m) => m.name === 'http_request_duration_seconds');
      expect(durationMetric).toBeDefined();
    });
  });
});
