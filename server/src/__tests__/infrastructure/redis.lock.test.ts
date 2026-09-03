import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { redis, connectRedis, disconnectRedis, acquireLock, releaseLock } from '../../infrastructure/redis.js';

describe('TASK-001: Atomic Distributed Lock (redis.ts)', () => {
  const testKeyPrefix = `test:lock:${crypto.randomUUID()}`;

  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    // Cleanup any lingering keys
    const keys = await redis.keys(`${testKeyPrefix}:*`);
    if (keys.length > 0) {
      await redis.del(keys);
    }
    await disconnectRedis();
  });

  beforeEach(async () => {
    // Ensure clean state for test keys
    const keys = await redis.keys(`${testKeyPrefix}:*`);
    if (keys.length > 0) {
      await redis.del(keys);
    }
  });

  it('acquires lock and stores unique ownership token (not static "locked")', async () => {
    const key = `${testKeyPrefix}:order-1`;
    const token = await acquireLock(key, 10);

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token).not.toBe('locked');

    // Verify stored value in Redis matches the returned token
    const storedValue = await redis.get(key);
    expect(storedValue).toBe(token);
  });

  it('rejects concurrent acquisition on the same key', async () => {
    const key = `${testKeyPrefix}:order-2`;
    const token1 = await acquireLock(key, 10);
    const token2 = await acquireLock(key, 10);

    expect(token1).toBeTruthy();
    expect(token2).toBeNull();

    // Verify original token is preserved
    const storedValue = await redis.get(key);
    expect(storedValue).toBe(token1);
  });

  it('allows explicit custom owner token on acquisition', async () => {
    const key = `${testKeyPrefix}:order-custom`;
    const customToken = `custom-owner-${crypto.randomUUID()}`;
    const token = await acquireLock(key, 10, customToken);

    expect(token).toBe(customToken);
    const storedValue = await redis.get(key);
    expect(storedValue).toBe(customToken);
  });

  it('successfully releases lock when called with the matching owner token', async () => {
    const key = `${testKeyPrefix}:order-3`;
    const token = await acquireLock(key, 10);
    expect(token).not.toBeNull();

    const released = await releaseLock(key, token!);
    expect(released).toBe(true);

    // Verify key was deleted in Redis
    const storedValue = await redis.get(key);
    expect(storedValue).toBeNull();
  });

  it('refuses to release lock when called with non-owner token (no-op)', async () => {
    const key = `${testKeyPrefix}:order-4`;
    const realToken = await acquireLock(key, 10);
    expect(realToken).not.toBeNull();

    const fakeToken = crypto.randomUUID();
    const released = await releaseLock(key, fakeToken);

    expect(released).toBe(false);

    // Verify the key still exists and is still owned by the real token
    const storedValue = await redis.get(key);
    expect(storedValue).toBe(realToken);

    // Real owner can still release afterwards
    const realReleased = await releaseLock(key, realToken!);
    expect(realReleased).toBe(true);
  });

  it('prevents Defect D2: delayed worker cannot release a lock stolen after expiry', async () => {
    const key = `${testKeyPrefix}:order-d2`;

    // Worker A acquires lock with 1 second TTL
    const workerAToken = await acquireLock(key, 1);
    expect(workerAToken).not.toBeNull();

    // Wait for Worker A's lock TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Worker B acquires the now-expired lock with its own token
    const workerBToken = await acquireLock(key, 10);
    expect(workerBToken).not.toBeNull();
    expect(workerBToken).not.toBe(workerAToken);

    // Worker A wakes up late and tries to release the lock using its expired token
    const workerARelease = await releaseLock(key, workerAToken!);
    expect(workerARelease).toBe(false);

    // Verify Worker B's lock was NOT deleted by Worker A's late release
    const storedValue = await redis.get(key);
    expect(storedValue).toBe(workerBToken);

    // Worker B finishes and releases cleanly
    const workerBRelease = await releaseLock(key, workerBToken!);
    expect(workerBRelease).toBe(true);
  });

  it('handles race conditions: exactly 1 of 10 concurrent acquisitions succeeds', async () => {
    const key = `${testKeyPrefix}:order-race`;

    const results = await Promise.all(
      Array.from({ length: 10 }).map(() => acquireLock(key, 10))
    );

    const successfulAcquisitions = results.filter((token) => token !== null);
    const failedAcquisitions = results.filter((token) => token === null);

    expect(successfulAcquisitions).toHaveLength(1);
    expect(failedAcquisitions).toHaveLength(9);

    const winnerToken = successfulAcquisitions[0]!;
    const storedValue = await redis.get(key);
    expect(storedValue).toBe(winnerToken);
  });

  it('handles concurrent release attempts: fake releases fail and only true owner succeeds', async () => {
    const key = `${testKeyPrefix}:order-concurrent-release`;
    const realToken = await acquireLock(key, 10);
    expect(realToken).not.toBeNull();

    const fakeTokens = Array.from({ length: 5 }).map(() => crypto.randomUUID());
    const releaseAttempts = [...fakeTokens, realToken!];

    // Shuffle release attempts
    const shuffledAttempts = releaseAttempts.sort(() => Math.random() - 0.5);

    const results = await Promise.all(
      shuffledAttempts.map((token) => releaseLock(key, token))
    );

    const successfulReleases = results.filter((res) => res === true);
    const failedReleases = results.filter((res) => res === false);

    expect(successfulReleases).toHaveLength(1);
    expect(failedReleases).toHaveLength(5);

    // Verify lock is deleted
    const storedValue = await redis.get(key);
    expect(storedValue).toBeNull();
  });
});
