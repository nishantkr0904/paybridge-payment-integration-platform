import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/http-error.js';
import { verifyAccessToken } from '../utils/token.js';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.header('authorization');
  const [scheme, token] = authHeader?.split(' ') ?? [];

  if (scheme !== 'Bearer' || !token) {
    next(new HttpError(401, 'AUTH_TOKEN_MISSING', 'Bearer access token is required.'));
    return;
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new HttpError(401, 'AUTH_TOKEN_INVALID', 'Access token is invalid or expired.'));
  }
}
