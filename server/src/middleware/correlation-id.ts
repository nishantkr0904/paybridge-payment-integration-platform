import type { Request, Response, NextFunction } from 'express';
import { generateUlid } from '../utils/ulid.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const ALT_REQUEST_ID_HEADER = 'x-request-id';

export const MAX_CORRELATION_ID_LENGTH = 128;
// Allow alphanumeric characters, dashes, underscores, colons, and dots
export const CORRELATION_ID_REGEX = /^[a-zA-Z0-9_\-.:]+$/;

/**
 * Validate and sanitize a client-provided correlation ID.
 * Rejects oversized strings or strings with control/injection characters.
 */
export function isValidCorrelationId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CORRELATION_ID_LENGTH) {
    return false;
  }
  return CORRELATION_ID_REGEX.test(trimmed);
}

/**
 * Normalizes incoming correlation ID or generates a fresh ULID if absent or invalid.
 */
export function normalizeCorrelationId(headerValue: unknown): string {
  if (isValidCorrelationId(headerValue)) {
    return headerValue.trim();
  }
  return generateUlid();
}

/**
 * Express middleware that attaches a validated correlation ID to req and res.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.headers[CORRELATION_ID_HEADER] || req.headers[ALT_REQUEST_ID_HEADER];
  const correlationId = normalizeCorrelationId(incomingId);

  req.correlationId = correlationId;
  req.id = correlationId;

  res.setHeader(CORRELATION_ID_HEADER, correlationId);

  next();
}
