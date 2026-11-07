import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import request from "supertest";
import { expect } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer } from "../src/container";
import { createPool } from "../src/db";
import { createApp } from "../src/http/app";
import { createLogger } from "../src/logger";
import { MockPaymentProvider, signMockPayload } from "../src/payments/mock";
import type { PaymentProvider } from "../src/payments/provider";
import { createRedis, NoopCache, RedisCache } from "../src/redis";
import type { OrderView } from "../src/services/orders";
import { assertTestDatabase, assertTestRedis, TEST_DB_URL, TEST_REDIS_URL } from "./env";

type Options = {
  payments?: PaymentProvider;
  env?: Record<string, string>;
  /** Connect to the test Redis (cache + shared rate limiting). Off by default. */
  redis?: boolean;
  /** Pool handed to the HTTP layer only, to simulate a broken database. */
  appPool?: Pool;
};

export async function createTestContext(options: Options = {}) {
  assertTestDatabase(TEST_DB_URL);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET: "test-secret-that-is-comfortably-longer-than-32-chars",
    BCRYPT_ROUNDS: "4",
    LOG_LEVEL: "silent",
    RATE_LIMIT_MAX: "100000",
    AUTH_RATE_LIMIT_MAX: "100000",
    CATALOG_CACHE_TTL_SECONDS: "60",
    ...options.env,
  });
  const logger = createLogger("silent");
  const pool = createPool(TEST_DB_URL);

  let redis: Redis | null = null;
  if (options.redis) {
    assertTestRedis(TEST_REDIS_URL);
    redis = createRedis(TEST_REDIS_URL, logger);
  }
  const cache = redis ? new RedisCache(redis, logger) : new NoopCache();
  const payments = options.payments ?? new MockPaymentProvider(config.mockWebhookSecret);
  const container = createContainer({ config, pool, payments, logger, cache });
  const app = createApp({ config, pool: options.appPool ?? pool, logger, container, redis });

  return {
    config,
    pool,
    redis,
    cache,
    payments,
    container,
    app,
    logger,
    async close() {
      await pool.end();
      redis?.disconnect();
    },
  };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;

export async function resetDb(ctx: TestContext) {
  await ctx.pool.query(
    "TRUNCATE TABLE payment_events, inventory_movements, order_items, orders, products, users RESTART IDENTITY CASCADE",
  );
  await ctx.redis?.flushdb();
}

export async function createUser(ctx: TestContext, role: "customer" | "admin" = "customer", email?: string) {
  const address = email ?? `${role}-${randomUUID().slice(0, 8)}@example.com`;
  const hash = await bcrypt.hash("password-123", 4);
  const { rows } = await ctx.pool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [address, hash, role],
  );
  const user = { id: rows[0].id, email: address, role };
  const token = await ctx.container.tokens.sign(user);
  return { ...user, token, auth: `Bearer ${token}` };
}

let counter = 0;
export async function createProduct(
  ctx: TestContext,
  overrides: Partial<{ sku: string; name: string; priceCents: number; stock: number; active: boolean }> = {},
) {
  counter++;
  const row = {
    sku: overrides.sku ?? `SKU-${counter}-${randomUUID().slice(0, 6)}`,
    name: overrides.name ?? `Product ${counter}`,
    priceCents: overrides.priceCents ?? 1000,
    stock: overrides.stock ?? 10,
    active: overrides.active ?? true,
  };
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price_cents, stock, active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [row.sku, row.name, row.priceCents, row.stock, row.active],
  );
  return { id: rows[0].id, ...row };
}

export async function stockOf(ctx: TestContext, productId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ stock: number }>("SELECT stock FROM products WHERE id = $1", [productId]);
  return rows[0].stock;
}

export async function placeOrder(
  ctx: TestContext,
  user: { auth: string },
  items: { productId: string; quantity: number }[],
) {
  const res = await request(ctx.app).post("/orders").set("Authorization", user.auth).send({ items });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { order: OrderView; clientSecret: string };
}

export function sendMockEvent(
  ctx: TestContext,
  event: { id?: string; type: "payment_succeeded" | "payment_failed"; reference: string },
  secret = ctx.config.mockWebhookSecret,
) {
  const body = JSON.stringify({ id: event.id ?? randomUUID(), type: event.type, reference: event.reference });
  return request(ctx.app)
    .post("/webhooks/payments")
    .set("content-type", "application/json")
    .set("x-mock-signature", signMockPayload(secret, body))
    .send(body);
}

export async function payOrder(ctx: TestContext, order: OrderView) {
  const res = await sendMockEvent(ctx, { type: "payment_succeeded", reference: order.payment!.reference });
  expect(res.status).toBe(200);
  expect(res.body.result).toBe("paid");
}

export function gql(ctx: TestContext, query: string, variables: Record<string, unknown> = {}, auth?: string) {
  const req = request(ctx.app).post("/graphql").set("content-type", "application/json");
  if (auth) req.set("Authorization", auth);
  return req.send({ query, variables });
}
