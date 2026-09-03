import crypto from 'node:crypto';
import { HttpError } from '../../utils/http-error.js';
import {
  findIdempotencyKey,
  insertIdempotencyKey,
  reclaimFailedIdempotencyKey,
  updateIdempotencyKey
} from './idempotency.repository.js';

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }

  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeJson((value as Record<string, unknown>)[k])}`
  );
  return '{' + pairs.join(',') + '}';
}

export function computeRequestHash(payload: unknown): string {
  const canonicalString = canonicalizeJson(payload ?? {});
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}

export function validateIdempotencyKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new HttpError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be a non-empty string between 1 and 255 characters.'
    );
  }
  return trimmed;
}

export interface IdempotentExecutionResult<T> {
  statusCode: number;
  data: T;
  isIdempotentReplay: boolean;
}

export async function executeWithIdempotency<T>(params: {
  merchantId: number;
  idempotencyKey?: string;
  requestPath: string;
  payload: unknown;
  action: () => Promise<{ statusCode: number; data: T }>;
}): Promise<IdempotentExecutionResult<T>> {
  const { merchantId, idempotencyKey, requestPath, payload, action } = params;

  // Backward compatibility: If no idempotency key is provided, execute action directly
  if (!idempotencyKey) {
    const result = await action();
    return {
      statusCode: result.statusCode,
      data: result.data,
      isIdempotentReplay: false
    };
  }

  const validatedKey = validateIdempotencyKey(idempotencyKey);
  const requestHash = computeRequestHash(payload);

  let inserted = false;

  try {
    await insertIdempotencyKey({
      merchantId,
      idempotencyKey: validatedKey,
      requestPath,
      requestHash
    });
    inserted = true;
  } catch (err: unknown) {
    const dbErr = err as { code?: string; errno?: number };
    if (dbErr.code !== 'ER_DUP_ENTRY' && dbErr.errno !== 1062) {
      throw err;
    }
  }

  if (!inserted) {
    const existing = await findIdempotencyKey(merchantId, validatedKey);

    if (!existing) {
      // Edge-case: key was removed concurrently; attempt to insert again
      await insertIdempotencyKey({
        merchantId,
        idempotencyKey: validatedKey,
        requestPath,
        requestHash
      });
    } else {
      // 1. Request fingerprint consistency check
      if (existing.requestHash !== requestHash) {
        throw new HttpError(
          409,
          'IDEMPOTENCY_KEY_MISMATCH',
          'Idempotency key was previously used with a different request payload.'
        );
      }

      // 2. Completed request -> return stored result
      if (existing.status === 'completed') {
        return {
          statusCode: existing.responseStatus ?? 200,
          data: existing.responseBody as T,
          isIdempotentReplay: true
        };
      }

      // 3. In-flight request -> reject concurrent attempt
      if (existing.status === 'processing') {
        throw new HttpError(
          409,
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this idempotency key is currently in progress. Please retry shortly.'
        );
      }

      // 4. Failed previous request -> reclaim key for retry
      if (existing.status === 'failed') {
        const reclaimed = await reclaimFailedIdempotencyKey(
          merchantId,
          validatedKey,
          requestPath,
          requestHash
        );

        if (!reclaimed) {
          throw new HttpError(
            409,
            'IDEMPOTENCY_IN_PROGRESS',
            'A request with this idempotency key is currently in progress. Please retry shortly.'
          );
        }
      }
    }
  }

  // Execute the protected side-effecting action
  try {
    const result = await action();

    await updateIdempotencyKey(
      merchantId,
      validatedKey,
      'completed',
      result.statusCode,
      result.data
    );

    return {
      statusCode: result.statusCode,
      data: result.data,
      isIdempotentReplay: false
    };
  } catch (actionError) {
    // Mark idempotency record as failed so retry can succeed
    try {
      await updateIdempotencyKey(merchantId, validatedKey, 'failed', null, null);
    } catch {
      // Log/ignore DB failure during error handling to preserve original exception
    }
    throw actionError;
  }
}
