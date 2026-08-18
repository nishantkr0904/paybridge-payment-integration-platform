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
 * Acquire a distributed lock.
 * Returns true if the lock was acquired, false otherwise.
 */
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.set(key, 'locked', {
    NX: true,
    EX: ttlSeconds
  });
  return result === 'OK';
}

/**
 * Release a distributed lock.
 */
export async function releaseLock(key: string): Promise<void> {
  await redis.del(key);
}
