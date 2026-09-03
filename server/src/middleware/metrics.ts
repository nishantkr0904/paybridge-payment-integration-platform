import type { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../infrastructure/metrics.js';

interface RequestWithMatchedBaseUrl extends Request {
  _matchedBaseUrl?: string;
}

export function getNormalizedRoute(req: Request): string {
  if (!req.route || typeof req.route.path !== 'string') {
    return 'unmatched';
  }

  const reqWithBase = req as RequestWithMatchedBaseUrl;
  const baseUrl = reqWithBase._matchedBaseUrl || req.baseUrl || '';
  return baseUrl + req.route.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip metrics scraping endpoints from self-instrumentation
  const reqPath = (req.originalUrl || req.path || '').split('?')[0];
  if (reqPath === '/metrics' || reqPath === '/api/metrics') {
    return next();
  }

  // Track the deepest non-empty baseUrl assigned by Express as it traverses sub-routers
  let currentBaseUrl = req.baseUrl || '';
  let deepestBaseUrl = currentBaseUrl;

  const reqWithBase = req as RequestWithMatchedBaseUrl;
  reqWithBase._matchedBaseUrl = deepestBaseUrl;

  Object.defineProperty(req, 'baseUrl', {
    get() {
      return currentBaseUrl;
    },
    set(val: string) {
      currentBaseUrl = val;
      if (val && val.length >= deepestBaseUrl.length) {
        deepestBaseUrl = val;
        reqWithBase._matchedBaseUrl = deepestBaseUrl;
      }
    },
    configurable: true,
    enumerable: true
  });

  const startTime = process.hrtime();
  let recorded = false;

  const record = () => {
    if (recorded) return;
    recorded = true;

    const diff = process.hrtime(startTime);
    const durationSeconds = diff[0] + diff[1] / 1e9;

    const method = req.method ? req.method.toUpperCase() : 'UNKNOWN';
    const route = getNormalizedRoute(req);
    const statusCode = res.statusCode ? String(res.statusCode) : '500';

    httpRequestsTotal.inc({ method, route, status_code: statusCode });
    httpRequestDurationSeconds.observe(
      { method, route, status_code: statusCode },
      durationSeconds
    );
  };

  res.on('finish', record);
  res.on('close', record);

  next();
}
