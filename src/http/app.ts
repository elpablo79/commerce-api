import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { createYoga } from "graphql-yoga";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { bearerToken } from "../auth";
import type { Config } from "../config";
import type { Container } from "../container";
import { createGraphqlSchema, type GraphQLContext } from "../graphql/schema";
import type { Logger } from "../logger";
import { authenticate, errorHandler, notFoundHandler, requestLogger } from "./middleware";
import { authRoutes, orderRoutes, productRoutes, webhookRoutes } from "./routes";
import "./types";

export type AppDeps = {
  config: Config;
  pool: Pool;
  logger: Logger;
  container: Container;
  /** When present, rate-limit counters live in Redis so they are shared by every instance. */
  redis: Redis | null;
};

export function createApp({ config, pool, logger, container, redis }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use(helmet());
  if (config.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: config.corsOrigins,
        methods: ["GET", "POST", "PATCH", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type"],
        maxAge: 600,
      }),
    );
  }
  app.use(requestLogger(logger));

  const limiter = (prefix: string, windowMs: number, limit: number): RequestHandler =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      // If Redis is unreachable, let requests through instead of taking the API down.
      passOnStoreError: true,
      ...(redis
        ? {
            store: new RedisStore({
              prefix: `rl:${prefix}:`,
              sendCommand: (command: string, ...args: string[]) =>
                redis.call(command, ...args) as Promise<RedisReply>,
            }),
          }
        : {}),
      handler: (_req, res) => {
        res
          .status(429)
          .json({ error: { code: "rate_limited", message: "Too many requests, please slow down" } });
      },
    });

  app.use(limiter("global", 60_000, config.rateLimitMax));

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
    } catch {
      res.status(503).json({ status: "unavailable", database: "down" });
      return;
    }
    let cache: "up" | "down" | "disabled" = "disabled";
    if (redis) {
      cache = await redis.ping().then(
        () => "up" as const,
        () => "down" as const,
      );
    }
    // Redis is an optimisation, so its absence degrades the API but does not make it unhealthy.
    res.json({ status: "ok", database: "up", redis: cache });
  });

  app.use("/webhooks", webhookRoutes(container));

  const yoga = createYoga<object, GraphQLContext>({
    schema: createGraphqlSchema(container),
    graphqlEndpoint: "/graphql",
    graphiql: false,
    landingPage: false,
    cors: false,
    maskedErrors: true,
    logging: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => logger.warn("graphql", { args: args.map(String) }),
      error: (...args: unknown[]) => logger.error("graphql", { args: args.map(String) }),
    },
    context: async ({ request }) => ({
      user: await container.tokens.verify(bearerToken(request.headers.get("authorization"))),
    }),
  });
  app.use(yoga.graphqlEndpoint, yoga);

  const api = express.Router();
  api.use(express.json({ limit: "100kb" }));
  api.use(authenticate(container.tokens));
  api.use("/auth", authRoutes(container, limiter("auth", 15 * 60_000, config.authRateLimitMax)));
  api.use("/products", productRoutes(container));
  api.use("/orders", orderRoutes(container));
  app.use(api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
