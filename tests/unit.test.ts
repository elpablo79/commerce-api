import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config";
import { assertTransition, canTransition, ORDER_STATUSES } from "../src/domain/order-state";
import { AppError, parse } from "../src/errors";
import { createLogger, errMeta } from "../src/logger";
import { escapeLike, isUniqueViolation, isUuid } from "../src/util";
import { assertTestDatabase, assertTestRedis } from "./env";

describe("order state machine", () => {
  it("allows exactly the intended lifecycle", () => {
    const allowed: [string, string][] = [
      ["pending", "paid"],
      ["pending", "cancelled"],
      ["paid", "shipped"],
      ["shipped", "delivered"],
    ];
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("refuses to cancel a paid order and explains why", () => {
    expect(() => assertTransition("paid", "cancelled")).toThrowError(/cannot move from paid to cancelled/);
    expect(() => assertTransition("pending", "paid")).not.toThrow();
  });
});

describe("configuration", () => {
  const base = { DATABASE_URL: "postgres://x/y", JWT_SECRET: "s".repeat(32) };

  it("applies sensible defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 4000,
      paymentProvider: "mock",
      bcryptRounds: 12,
      orderExpiryMinutes: 30,
      corsOrigins: [],
      redisUrl: undefined,
    });
  });

  it("reports every problem at once", () => {
    expect(() => loadConfig({})).toThrowError(/DATABASE_URL[\s\S]*JWT_SECRET/);
    expect(() => loadConfig({ ...base, JWT_SECRET: "short" })).toThrowError(/at least 32 characters/);
  });

  it("requires the Stripe keys when Stripe is selected", () => {
    expect(() => loadConfig({ ...base, PAYMENT_PROVIDER: "stripe" })).toThrowError(/STRIPE_SECRET_KEY is required/);
    const config = loadConfig({
      ...base,
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    expect(config.paymentProvider).toBe("stripe");
  });

  it("does not allow the mock payment provider in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrowError(/not allowed in production/);
  });

  it("treats blank values as unset and parses the CORS list", () => {
    const config = loadConfig({
      ...base,
      REDIS_URL: "",
      CORS_ORIGINS: " https://a.example , https://b.example ,",
    });
    expect(config.redisUrl).toBeUndefined();
    expect(config.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes JSON lines and respects the level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger("info");
    logger.info("hello", { a: 1 });
    logger.debug("hidden");
    logger.warn("careful");
    logger.error("broken");
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ level: "info", msg: "hello", a: 1 });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("is silent when asked to be", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger("silent");
    logger.info("x");
    logger.debug("x");
    expect(log).not.toHaveBeenCalled();
  });

  it("serialises errors and other values", () => {
    expect(errMeta(new Error("boom"))).toMatchObject({ name: "Error", message: "boom" });
    expect(errMeta("plain")).toEqual({ message: "plain" });
  });
});

describe("helpers", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("recognises UUIDs", () => {
    expect(isUuid("5f0d7f0e-6a5b-4c1e-9d3e-0a1b2c3d4e5f")).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it("recognises unique violations", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it("turns validation failures into a 400 with field details", () => {
    const schema = z.object({ name: z.string().min(2) });
    try {
      parse(schema, { name: "x" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as AppError).details).toEqual([{ path: "name", message: expect.any(String) }]);
    }
  });
});

describe("test safety guards", () => {
  it("refuses databases that are not named *_test", () => {
    expect(() => assertTestDatabase("postgres://u:p@h/commerce")).toThrowError(/must end with "_test"/);
    expect(() => assertTestDatabase("postgres://u:p@h/commerce_test")).not.toThrow();
  });

  it("refuses Redis database 0", () => {
    expect(() => assertTestRedis("redis://localhost:6379")).toThrowError(/database 0/);
    expect(() => assertTestRedis("redis://localhost:6379/0")).toThrowError(/database 0/);
    expect(() => assertTestRedis("redis://localhost:6379/15")).not.toThrow();
  });
});
