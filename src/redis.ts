import { Redis } from "ioredis";
import { errMeta, type Logger } from "./logger";

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: 2, commandTimeout: 1000 });
  // Without a listener an unreachable Redis would crash the process with an unhandled "error" event.
  redis.on("error", (err) => logger.warn("Redis error", { err: errMeta(err) }));
  return redis;
}

/**
 * Cache-aside storage. Every method is best effort: if the cache is down the API keeps
 * working and simply reads from the database.
 */
export interface Cache {
  readonly enabled: boolean;
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Current generation of a namespace; include it in keys so a `bump` invalidates them all. */
  version(namespace: string): Promise<string>;
  bump(namespace: string): Promise<void>;
}

export class NoopCache implements Cache {
  readonly enabled = false;
  async getJson<T>(): Promise<T | null> {
    return null;
  }
  async setJson(): Promise<void> {}
  async version(): Promise<string> {
    return "0";
  }
  async bump(): Promise<void> {}
}

export class RedisCache implements Cache {
  readonly enabled = true;

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn("Cache read failed", { key, err: errMeta(err) });
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      this.logger.warn("Cache write failed", { key, err: errMeta(err) });
    }
  }

  async version(namespace: string): Promise<string> {
    try {
      return (await this.redis.get(`cache:version:${namespace}`)) ?? "0";
    } catch (err) {
      this.logger.warn("Cache version read failed", { namespace, err: errMeta(err) });
      return "0";
    }
  }

  async bump(namespace: string): Promise<void> {
    try {
      await this.redis.incr(`cache:version:${namespace}`);
    } catch (err) {
      this.logger.warn("Cache invalidation failed", { namespace, err: errMeta(err) });
    }
  }
}
