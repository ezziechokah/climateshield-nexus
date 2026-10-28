import { Redis } from "ioredis";

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };
export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  mode: "redis" | "memory";
}

class MemoryRateLimiter implements RateLimiter {
  readonly mode = "memory" as const;
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    if (this.#buckets.size > 20000) for (const [bucketKey, entry] of this.#buckets) if (entry.resetAt <= now) this.#buckets.delete(bucketKey);
    const current = this.#buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count++;
    return current.count <= limit
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

  async close() { this.#buckets.clear(); }
  async ping() { return true; }
}

class RedisRateLimiter implements RateLimiter {
  readonly mode = "redis" as const;
  readonly #redis: Redis;
  constructor(url: string) { this.#redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000 }); }

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const [count, ttl] = await this.#redis.eval(`local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return {count, redis.call('TTL', KEYS[1])}`, 1, key, String(windowSeconds)) as [number, number];
    return { allowed: count <= limit, retryAfterSeconds: count <= limit ? 0 : Math.max(1, ttl) };
  }

  async ping() { return await this.#redis.ping() === "PONG"; }
  async close() { await this.#redis.quit(); }
}

export function createRateLimiter(environment = process.env.NODE_ENV): RateLimiter {
  if (process.env.REDIS_URL) return new RedisRateLimiter(process.env.REDIS_URL);
  if (environment === "production") throw new Error("REDIS_URL is required for distributed production rate limiting.");
  return new MemoryRateLimiter();
}