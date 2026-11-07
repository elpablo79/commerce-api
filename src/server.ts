import { createContainer } from "./container";
import { loadConfig } from "./config";
import { createPool, migrate } from "./db";
import { createApp } from "./http/app";
import { createLogger, errMeta } from "./logger";
import { createPaymentProvider } from "./payments";
import { createRedis, NoopCache, RedisCache } from "./redis";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const pool = createPool(config.databaseUrl);
  pool.on("error", (err) => logger.error("Idle database client error", { err: errMeta(err) }));

  // Idempotent and guarded by an advisory lock, so several instances can start together.
  const applied = await migrate(pool);
  if (applied.length > 0) logger.info("Applied migrations", { applied });

  const redis = config.redisUrl ? createRedis(config.redisUrl, logger) : null;
  const cache = redis ? new RedisCache(redis, logger) : new NoopCache();
  const payments = createPaymentProvider(config);
  const container = createContainer({ config, pool, payments, logger, cache });
  const app = createApp({ config, pool, logger, container, redis });

  const server = app.listen(config.port, () => {
    logger.info("Commerce API listening", {
      port: config.port,
      payments: payments.name,
      redis: redis ? "enabled" : "disabled",
    });
  });

  // Release stock held by orders that were never paid. Safe to run on every instance at once.
  const expiry = setInterval(() => {
    container.orders
      .expireStale()
      .then((count) => count > 0 && logger.info("Expired unpaid orders", { count }))
      .catch((err) => logger.error("Order expiry failed", { err: errMeta(err) }));
  }, 60_000);
  expiry.unref();

  const shutdown = (signal: string) => {
    logger.info("Shutting down", { signal });
    clearInterval(expiry);
    server.close(async () => {
      await pool.end();
      redis?.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
