import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { pinoHttp } from 'pino-http';
import { getMetrics, getMetricsContentType } from './infrastructure/metrics.js';
import { metricsMiddleware } from './middleware/metrics.js';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';

import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { merchantRouter } from './modules/merchant/merchant.routes.js';
import { paymentRouter } from './modules/payment/payment.routes.js';
import { webhookRouter } from './modules/webhook/webhook.routes.js';
import { caseRouter } from './modules/recovery/case.routes.js';
import { traceRouter } from './modules/ai/tracing/trace.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { logger } from './utils/logger.js';

import { isShuttingDown } from './utils/shutdown.js';
import { correlationIdMiddleware } from './middleware/correlation-id.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL }));
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use(metricsMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).correlationId || (req.headers['x-correlation-id'] as string),
      customProps: (req) => ({
        correlationId: (req as express.Request).correlationId,
        traceId: (req as express.Request).correlationId
      })
    })
  );

  app.get('/api/health', (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'shutting_down', service: 'paybridge-server' });
      return;
    }
    res.json({ status: 'ok', service: 'paybridge-server' });
  });

  const handleMetrics = async (_req: express.Request, res: express.Response) => {
    try {
      res.set('Content-Type', getMetricsContentType());
      res.end(await getMetrics());
    } catch (ex) {
      res.status(500).end(ex);
    }
  };

  app.get('/metrics', handleMetrics);
  app.get('/api/metrics', handleMetrics);

  app.use('/api/auth', authRouter);
  app.use('/api/merchants', merchantRouter);
  app.use('/api/payments', paymentRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/recovery', caseRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/v1/ops/agent-traces', traceRouter);
  app.use('/api/ai/traces', traceRouter);

  // Swagger Documentation
  const openApiPath = fs.existsSync(path.join(process.cwd(), 'docs/openapi.yaml'))
    ? path.join(process.cwd(), 'docs/openapi.yaml')
    : path.join(process.cwd(), '../docs/openapi.yaml');

  if (fs.existsSync(openApiPath)) {
    try {
      const swaggerDocument = YAML.load(openApiPath);
      app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize Swagger UI from OpenAPI document');
    }
  }

  app.use(errorHandler);

  return app;
}
