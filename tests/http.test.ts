import type { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, gql, type TestContext } from "./helpers";

describe("HTTP behaviour", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("reports health", async () => {
    const res = await request(ctx.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "up", redis: "disabled" });
  });

  it("answers unknown routes with JSON", async () => {
    const res = await request(ctx.app).get("/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("rejects malformed and oversized JSON bodies", async () => {
    const malformed = await request(ctx.app)
      .post("/auth/login")
      .set("content-type", "application/json")
      .send("{ not json");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_json");

    const huge = await request(ctx.app)
      .post("/auth/login")
      .send({ email: "a@example.com", password: "x".repeat(200_000) });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe("payload_too_large");
  });

  it("sets security headers and does not advertise the framework", async () => {
    const res = await request(ctx.app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("sends no CORS headers unless origins are configured", async () => {
    const res = await request(ctx.app).get("/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("only allows the configured CORS origins", async () => {
    const cors = await createTestContext({ env: { CORS_ORIGINS: "https://shop.example" } });
    try {
      const allowed = await request(cors.app).options("/products").set("Origin", "https://shop.example").set("Access-Control-Request-Method", "GET");
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://shop.example");
      const denied = await request(cors.app).get("/products").set("Origin", "https://evil.example");
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await cors.close();
    }
  });

  it("rate limits all traffic and the auth endpoints more strictly", async () => {
    const limited = await createTestContext({ env: { RATE_LIMIT_MAX: "3", AUTH_RATE_LIMIT_MAX: "2" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await request(limited.app).get("/health")).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      const blocked = await request(limited.app).get("/health");
      expect(blocked.body.error.code).toBe("rate_limited");
      expect(blocked.headers["ratelimit"] ?? blocked.headers["ratelimit-policy"]).toBeDefined();
    } finally {
      await limited.close();
    }

    const auth = await createTestContext({ env: { AUTH_RATE_LIMIT_MAX: "2" } });
    try {
      const login = () => request(auth.app).post("/auth/login").send({ email: "a@example.com", password: "whatever" });
      expect((await login()).status).toBe(401);
      expect((await login()).status).toBe(401);
      expect((await login()).status).toBe(429);
      // Other routes are not affected by the auth limiter.
      expect((await request(auth.app).get("/health")).status).toBe(200);
    } finally {
      await auth.close();
    }
  });

  describe("when the database is unavailable", () => {
    const broken = {
      query: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Pool;
    let down: TestContext;
    beforeAll(async () => {
      down = await createTestContext({ appPool: broken });
    });
    afterAll(() => down.close());

    it("reports unhealthy", async () => {
      const res = await request(down.app).get("/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unavailable");
    });
  });

  describe("when something unexpected fails", () => {
    const brokenQueries = {
      query: async () => {
        throw new Error("password=hunter2 must never reach the client");
      },
      connect: async () => {
        throw new Error("password=hunter2 must never reach the client");
      },
    } as unknown as Pool;
    let ctxBroken: TestContext;
    beforeAll(async () => {
      ctxBroken = await createTestContext();
      // Rebuild the services on a pool that always fails, keeping the real HTTP layer.
      const { createContainer } = await import("../src/container");
      const { createApp } = await import("../src/http/app");
      const container = createContainer({
        config: ctxBroken.config,
        pool: brokenQueries,
        payments: ctxBroken.payments,
        logger: ctxBroken.logger,
        cache: ctxBroken.cache,
      });
      ctxBroken.app = createApp({ config: ctxBroken.config, pool: ctxBroken.pool, logger: ctxBroken.logger, container, redis: null });
    });
    afterAll(() => ctxBroken.close());

    it("returns a generic 500 over REST without leaking details", async () => {
      const res = await request(ctxBroken.app).get("/products");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: "internal_error", message: "Something went wrong" } });
    });

    it("masks the error over GraphQL as well", async () => {
      const res = await gql(ctxBroken, "{ products { total } }");
      expect(JSON.stringify(res.body)).not.toContain("hunter2");
      expect(res.body.errors).toHaveLength(1);
    });
  });
});
