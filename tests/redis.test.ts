import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";
import { NoopCache, RedisCache, type Cache } from "../src/redis";
import { createProduct, createTestContext, createUser, resetDb, type TestContext } from "./helpers";

describe("Redis integration", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ redis: true });
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetDb(ctx));

  describe("catalogue cache", () => {
    it("serves the public catalogue from the cache until it is invalidated", async () => {
      const product = await createProduct(ctx, { name: "Original" });
      const names = async () => (await request(ctx.app).get("/products")).body.data.map((p: any) => p.name);

      expect(await names()).toEqual(["Original"]);
      // Change the row behind the API's back: a cached response will not notice.
      await ctx.pool.query("UPDATE products SET name = 'Changed in DB' WHERE id = $1", [product.id]);
      expect(await names()).toEqual(["Original"]);

      // Any admin write through the API invalidates the cache.
      const admin = await createUser(ctx, "admin");
      await request(ctx.app).patch(`/products/${product.id}`).set("Authorization", admin.auth).send({ priceCents: 4242 });
      const fresh = await request(ctx.app).get("/products");
      expect(fresh.body.data[0]).toMatchObject({ name: "Changed in DB", priceCents: 4242 });
    });

    it("invalidates on create and on inventory changes", async () => {
      const admin = await createUser(ctx, "admin");
      const before = await request(ctx.app).get("/products");
      expect(before.body.pagination.total).toBe(0);

      const created = await request(ctx.app)
        .post("/products")
        .set("Authorization", admin.auth)
        .send({ sku: "C-1", name: "Cached", priceCents: 500, stock: 1 });
      expect((await request(ctx.app).get("/products")).body.pagination.total).toBe(1);

      await request(ctx.app).post(`/products/${created.body.id}/inventory`).set("Authorization", admin.auth).send({ delta: -1 });
      expect((await request(ctx.app).get("/products")).body.data[0].inStock).toBe(false);
    });

    it("keeps separate entries per query and never caches the admin view", async () => {
      const admin = await createUser(ctx, "admin");
      await createProduct(ctx, { name: "Alpha" });
      await createProduct(ctx, { name: "Beta" });

      const alpha = await request(ctx.app).get("/products?q=alpha");
      const beta = await request(ctx.app).get("/products?q=beta");
      expect(alpha.body.data.map((p: any) => p.name)).toEqual(["Alpha"]);
      expect(beta.body.data.map((p: any) => p.name)).toEqual(["Beta"]);

      await request(ctx.app).get("/products").set("Authorization", admin.auth);
      const keys = await ctx.redis!.keys("cache:products:*");
      // Two public queries cached; the admin request added nothing.
      expect(keys).toHaveLength(2);
      const asAdmin = await request(ctx.app).get("/products?q=alpha").set("Authorization", admin.auth);
      expect(asAdmin.body.data[0]).toHaveProperty("stock");
    });

    it("expires entries after the configured time", async () => {
      await createProduct(ctx);
      await request(ctx.app).get("/products");
      const [key] = await ctx.redis!.keys("cache:products:*");
      const ttl = await ctx.redis!.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });
  });

  describe("rate limiting", () => {
    it("keeps counters in Redis so every instance shares them", async () => {
      const limited = await createTestContext({ redis: true, env: { RATE_LIMIT_MAX: "2" } });
      try {
        await limited.redis!.flushdb();
        expect((await request(limited.app).get("/nothing")).status).toBe(404);
        expect((await request(limited.app).get("/nothing")).status).toBe(404);
        expect((await request(limited.app).get("/nothing")).status).toBe(429);
        expect(await limited.redis!.keys("rl:global:*")).toHaveLength(1);

        // A second app instance on the same Redis sees the same counter.
        const other = await createTestContext({ redis: true, env: { RATE_LIMIT_MAX: "2" } });
        try {
          expect((await request(other.app).get("/nothing")).status).toBe(429);
        } finally {
          await other.close();
        }
      } finally {
        await limited.close();
      }
    });
  });

  it("reports Redis in the health check", async () => {
    const res = await request(ctx.app).get("/health");
    expect(res.body).toEqual({ status: "ok", database: "up", redis: "up" });
  });

  describe("when Redis is unreachable", () => {
    it("keeps serving the catalogue from the database", async () => {
      const dead = new Redis("redis://127.0.0.1:1", {
        maxRetriesPerRequest: 0,
        commandTimeout: 200,
        retryStrategy: () => null,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      dead.on("error", () => undefined);
      const cache = new RedisCache(dead, createLogger("silent"));
      expect(await cache.getJson("k")).toBeNull();
      await expect(cache.setJson("k", { a: 1 }, 5)).resolves.toBeUndefined();
      expect(await cache.version("products")).toBe("0");
      await expect(cache.bump("products")).resolves.toBeUndefined();
      dead.disconnect();
    });

    it("reports the problem in the health check without failing it", async () => {
      const down = await createTestContext({ redis: true });
      try {
        await down.redis!.quit();
        const res = await request(down.app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.redis).toBe("down");
      } finally {
        await down.close();
      }
    });
  });

  it("does nothing when caching is disabled", async () => {
    const cache: Cache = new NoopCache();
    expect(cache.enabled).toBe(false);
    expect(await cache.getJson("x")).toBeNull();
    await cache.setJson("x", 1, 1);
    expect(await cache.version("products")).toBe("0");
    await cache.bump("products");
  });
});
