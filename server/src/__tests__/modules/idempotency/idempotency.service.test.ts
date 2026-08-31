import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpError } from '../../../utils/http-error.js';
import * as idempotencyRepo from '../../../modules/idempotency/idempotency.repository.js';
import {
  canonicalizeJson,
  computeRequestHash,
  validateIdempotencyKey,
  executeWithIdempotency
} from '../../../modules/idempotency/idempotency.service.js';
import type { IdempotencyRecord } from '../../../modules/idempotency/idempotency.types.js';

vi.mock('../../../modules/idempotency/idempotency.repository.js', () => ({
  insertIdempotencyKey: vi.fn(),
  findIdempotencyKey: vi.fn(),
  updateIdempotencyKey: vi.fn(),
  reclaimFailedIdempotencyKey: vi.fn(),
  deleteIdempotencyKey: vi.fn()
}));

describe('Idempotency Service (idempotency.service.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canonicalizeJson & computeRequestHash', () => {
    it('produces identical hashes for objects with different key order', () => {
      const obj1 = { amount: 5000, currency: 'INR', description: 'test' };
      const obj2 = { description: 'test', currency: 'INR', amount: 5000 };

      expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
      expect(computeRequestHash(obj1)).toBe(computeRequestHash(obj2));
    });

    it('produces different hashes for different payloads', () => {
      const obj1 = { amount: 5000, currency: 'INR' };
      const obj2 = { amount: 6000, currency: 'INR' };

      expect(computeRequestHash(obj1)).not.toBe(computeRequestHash(obj2));
    });

    it('handles nested objects and arrays deterministically', () => {
      const obj1 = { meta: { b: 2, a: 1 }, items: [1, 2, { y: 'b', x: 'a' }] };
      const obj2 = { items: [1, 2, { x: 'a', y: 'b' }], meta: { a: 1, b: 2 } };

      expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
      expect(computeRequestHash(obj1)).toBe(computeRequestHash(obj2));
    });
  });

  describe('validateIdempotencyKey', () => {
    it('accepts valid non-empty string keys up to 255 characters', () => {
      expect(validateIdempotencyKey('idemp_12345')).toBe('idemp_12345');
      expect(validateIdempotencyKey('  valid_with_spaces  ')).toBe('valid_with_spaces');
      expect(validateIdempotencyKey('a'.repeat(255))).toBe('a'.repeat(255));
    });

    it('rejects empty or whitespace-only keys with 400', () => {
      expect(() => validateIdempotencyKey('')).toThrow(HttpError);
      expect(() => validateIdempotencyKey('   ')).toThrow(HttpError);
    });

    it('rejects keys exceeding 255 characters with 400', () => {
      expect(() => validateIdempotencyKey('a'.repeat(256))).toThrow(HttpError);
    });
  });

  describe('executeWithIdempotency', () => {
    const merchantId = 1;
    const idempotencyKey = 'test_key_001';
    const requestPath = '/api/payments/orders';
    const payload = { amount: 1000, currency: 'INR' };
    const expectedHash = computeRequestHash(payload);

    it('executes action directly when idempotencyKey is not provided (backward compatible)', async () => {
      const action = vi.fn().mockResolvedValue({ statusCode: 201, data: { orderId: 1 } });

      const result = await executeWithIdempotency({
        merchantId,
        requestPath,
        payload,
        action
      });

      expect(action).toHaveBeenCalledTimes(1);
      expect(idempotencyRepo.insertIdempotencyKey).not.toHaveBeenCalled();
      expect(result).toEqual({
        statusCode: 201,
        data: { orderId: 1 },
        isIdempotentReplay: false
      });
    });

    it('first request: successfully inserts processing record, executes action, and marks completed', async () => {
      vi.mocked(idempotencyRepo.insertIdempotencyKey).mockResolvedValue(true);
      vi.mocked(idempotencyRepo.updateIdempotencyKey).mockResolvedValue();

      const action = vi.fn().mockResolvedValue({ statusCode: 201, data: { orderId: 42 } });

      const result = await executeWithIdempotency({
        merchantId,
        idempotencyKey,
        requestPath,
        payload,
        action
      });

      expect(idempotencyRepo.insertIdempotencyKey).toHaveBeenCalledWith({
        merchantId,
        idempotencyKey,
        requestPath,
        requestHash: expectedHash
      });
      expect(action).toHaveBeenCalledTimes(1);
      expect(idempotencyRepo.updateIdempotencyKey).toHaveBeenCalledWith(
        merchantId,
        idempotencyKey,
        'completed',
        201,
        { orderId: 42 }
      );
      expect(result).toEqual({
        statusCode: 201,
        data: { orderId: 42 },
        isIdempotentReplay: false
      });
    });

    it('completed duplicate request: returns cached response without executing action', async () => {
      // Simulate duplicate key in DB
      const dupError = new Error('Duplicate entry');
      (dupError as unknown as { code: string }).code = 'ER_DUP_ENTRY';
      vi.mocked(idempotencyRepo.insertIdempotencyKey).mockRejectedValue(dupError);

      const existingRecord: IdempotencyRecord = {
        id: 10,
        merchantId,
        idempotencyKey,
        requestPath,
        requestHash: expectedHash,
        responseStatus: 201,
        responseBody: { orderId: 42 },
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      vi.mocked(idempotencyRepo.findIdempotencyKey).mockResolvedValue(existingRecord);

      const action = vi.fn();

      const result = await executeWithIdempotency({
        merchantId,
        idempotencyKey,
        requestPath,
        payload,
        action
      });

      expect(action).not.toHaveBeenCalled();
      expect(result).toEqual({
        statusCode: 201,
        data: { orderId: 42 },
        isIdempotentReplay: true
      });
    });

    it('concurrent duplicate request (in-flight): rejects with 409 IDEMPOTENCY_IN_PROGRESS', async () => {
      const dupError = new Error('Duplicate entry');
      (dupError as unknown as { code: string }).code = 'ER_DUP_ENTRY';
      vi.mocked(idempotencyRepo.insertIdempotencyKey).mockRejectedValue(dupError);

      const inFlightRecord: IdempotencyRecord = {
        id: 10,
        merchantId,
        idempotencyKey,
        requestPath,
        requestHash: expectedHash,
        responseStatus: null,
        responseBody: null,
        status: 'processing',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      vi.mocked(idempotencyRepo.findIdempotencyKey).mockResolvedValue(inFlightRecord);

      const action = vi.fn();

      await expect(
        executeWithIdempotency({
          merchantId,
          idempotencyKey,
          requestPath,
          payload,
          action
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_IN_PROGRESS'
      });

      expect(action).not.toHaveBeenCalled();
    });

    it('conflicting payload: rejects with 409 IDEMPOTENCY_KEY_MISMATCH when payload differs', async () => {
      const dupError = new Error('Duplicate entry');
      (dupError as unknown as { code: string }).code = 'ER_DUP_ENTRY';
      vi.mocked(idempotencyRepo.insertIdempotencyKey).mockRejectedValue(dupError);

      const existingRecord: IdempotencyRecord = {
        id: 10,
        merchantId,
        idempotencyKey,
        requestPath,
        requestHash: computeRequestHash({ amount: 99999, currency: 'USD' }), // different payload
        responseStatus: 201,
        responseBody: { orderId: 99 },
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      vi.mocked(idempotencyRepo.findIdempotencyKey).mockResolvedValue(existingRecord);

      const action = vi.fn();

      await expect(
        executeWithIdempotency({
          merchantId,
          idempotencyKey,
          requestPath,
          payload,
          action
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_MISMATCH'
      });

      expect(action).not.toHaveBeenCalled();
    });

    it('failed previous request: reclaims key and executes fresh attempt on retry', async () => {
      const dupError = new Error('Duplicate entry');
      (dupError as unknown as { code: string }).code = 'ER_DUP_ENTRY';
      vi.mocked(idempotencyRepo.insertIdempotencyKey).mockRejectedValue(dupError);

      const failedRecord: IdempotencyRecord = {
        id: 10,
        merchantId,
        idempotencyKey,
        requestPath,
        requestHash: expectedHash,
        responseStatus: null,
        responseBody: null,
        status: 'failed',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      vi.mocked(idempotencyRepo.findIdempotencyKey).mockResolvedValue(failedRecord);
      vi.mocked(idempotencyRepo.reclaimFailedIdempotencyKey).mockResolvedValue(true);
      vi.mocked(idempotencyRepo.updateIdempotencyKey).mockResolvedValue();

      const action = vi.fn().mockResolvedValue({ statusCode: 201, data: { orderId: 88 } });

      const result = await executeWithIdempotency({
        merchantId,
        idempotencyKey,
        requestPath,
        payload,
        action
      });

      expect(idempotencyRepo.reclaimFailedIdempotencyKey).toHaveBeenCalledWith(
        merchantId,
        idempotencyKey,
        requestPath,
        expectedHash
      );
      expect(action).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        statusCode: 201,
        data: { orderId: 88 },
        isIdempotentReplay: false
      });
    });

    it('marks record as failed when action throws an error', async () => {
      vi.mocked(idempotencyRepo.insertIdempotencyKey).mockResolvedValue(true);
      vi.mocked(idempotencyRepo.updateIdempotencyKey).mockResolvedValue();

      const action = vi.fn().mockRejectedValue(new Error('Downstream DB error'));

      await expect(
        executeWithIdempotency({
          merchantId,
          idempotencyKey,
          requestPath,
          payload,
          action
        })
      ).rejects.toThrow('Downstream DB error');

      expect(idempotencyRepo.updateIdempotencyKey).toHaveBeenCalledWith(
        merchantId,
        idempotencyKey,
        'failed',
        null,
        null
      );
    });
  });
});
