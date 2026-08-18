import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { merchantRouter } from './modules/merchant/merchant.routes.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL }));
  app.use(express.json());
  app.use(morgan('combined'));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'paybridge-server' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/merchants', merchantRouter);
  app.use(errorHandler);

  return app;
}
