import { LLMError, LLMTimeoutError } from './llm.types.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export function isTransientLLMError(error: unknown): boolean {
  if (error instanceof LLMTimeoutError) {
    return true;
  }

  if (error instanceof LLMError) {
    if (error.statusCode === 429 || (error.statusCode && error.statusCode >= 500)) {
      return true;
    }
    return error.isTransient;
  }

  const err = error as { status?: number; statusCode?: number; code?: string; message?: string };
  const statusCode = err?.status || err?.statusCode;

  if (statusCode === 429 || (statusCode && statusCode >= 500 && statusCode < 600)) {
    return true;
  }

  const msg = (err?.message || '').toLowerCase();
  const code = (err?.code || '').toLowerCase();

  if (
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    msg.includes('connection reset')
  ) {
    return true;
  }

  return false;
}

export async function executeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 2;
  const initialDelayMs = options?.initialDelayMs ?? 200;
  const maxDelayMs = options?.maxDelayMs ?? 2000;
  const backoffFactor = options?.backoffFactor ?? 2;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt > maxRetries || !isTransientLLMError(error)) {
        throw error;
      }

      // Jittered exponential backoff: delay = min(maxDelay, initial * factor^(attempt-1) + jitter)
      const baseDelay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      const jitter = Math.random() * 0.2 * baseDelay; // up to 20% jitter
      const delay = Math.min(maxDelayMs, Math.floor(baseDelay + jitter));

      await new Promise((res) => setTimeout(res, delay));
    }
  }

  throw lastError;
}
