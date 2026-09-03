import crypto from 'node:crypto';
import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = createClient({ url: redisUrl });

redis.on('error', (err) => console.error('Redis Client Error', err));
redis.on('connect', () => console.log('Redis Client Connected'));

export async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }
}

export async function disconnectRedis() {
  if (redis.isOpen) {
    await redis.disconnect();
  }
}

/**
 * Acquire a distributed lock with an ownership token.
 * If ownerToken is not provided, a random UUID is generated.
 * Returns the ownerToken if the lock was acquired, or null if lock is held.
 */
export async function acquireLock(
  key: string,
  ttlSeconds: number,
  ownerToken: string = crypto.randomUUID()
): Promise<string | null> {
  const result = await redis.set(key, ownerToken, {
    NX: true,
    EX: ttlSeconds
  });
  return result === 'OK' ? ownerToken : null;
}

export const RELEASE_LOCK_LUA_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

/**
 * Release a distributed lock atomically using a Lua script.
 * Releases only if the stored token matches the provided ownerToken.
 * Returns true if the lock was released, false if the caller was not the owner or key expired.
 */
export async function releaseLock(key: string, ownerToken: string): Promise<boolean> {
  const result = await redis.eval(RELEASE_LOCK_LUA_SCRIPT, {
    keys: [key],
    arguments: [ownerToken]
  });
  return result === 1;
}
