import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { pinoHttp } from 'pino-http';
import client from 'prom-client';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';

// Enable default metrics collection (memory, CPU, etc.)
client.collectDefaultMetrics();
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { merchantRouter } from './modules/merchant/merchant.routes.js';
import { paymentRouter } from './modules/payment/payment.routes.js';
import { webhookRouter } from './modules/webhook/webhook.routes.js';
import { logger } from './utils/logger.js';

import { isShuttingDown } from './utils/shutdown.js';
import { correlationIdMiddleware } from './middleware/correlation-id.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL }));
  app.use(express.json());
  app.use(correlationIdMiddleware);
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

  app.get('/api/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', client.register.contentType);
      res.end(await client.register.metrics());
    } catch (ex) {
      res.status(500).end(ex);
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/merchants', merchantRouter);
  app.use('/api/payments', paymentRouter);
  app.use('/api/webhooks', webhookRouter);

  // Swagger Documentation
  const swaggerDocument = YAML.load(path.join(process.cwd(), '../docs/openapi.yaml'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  app.use(errorHandler);

  return app;
}
