import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProduct, createTestContext, createUser, resetDb, stockOf, type TestContext } from "./helpers";

describe("products", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let customer: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await resetDb(ctx);
    admin = await createUser(ctx, "admin");
    customer = await createUser(ctx, "customer");
  });

  describe("reading", () => {
    it("lists active products publicly without exposing exact stock", async () => {
      await createProduct(ctx, { name: "Visible", stock: 7 });
      await createProduct(ctx, { name: "Sold out", stock: 0 });
      await createProduct(ctx, { name: "Hidden", active: false });

      const res = await request(ctx.app).get("/products");
      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(2);
      const byName = Object.fromEntries(res.body.data.map((p: any) => [p.name, p]));
      expect(byName.Visible.inStock).toBe(true);
      expect(byName["Sold out"].inStock).toBe(false);
      expect(byName.Hidden).toBeUndefined();
      for (const product of res.body.data) expect(product).not.toHaveProperty("stock");
    });

    it("shows admins the exact stock and, on request, inactive products", async () => {
      await createProduct(ctx, { name: "Visible", stock: 7 });
      await createProduct(ctx, { name: "Hidden", active: false, stock: 3 });

      const normal = await request(ctx.app).get("/products").set("Authorization", admin.auth);
      expect(normal.body.data).toHaveLength(1);
      expect(normal.body.data[0].stock).toBe(7);

      const all = await request(ctx.app).get("/products?includeInactive=true").set("Authorization", admin.auth);
      expect(all.body.data).toHaveLength(2);

      // The flag means nothing to a customer.
      const asCustomer = await request(ctx.app).get("/products?includeInactive=true").set("Authorization", customer.auth);
      expect(asCustomer.body.data).toHaveLength(1);
    });

    it("searches by name or SKU and treats wildcards literally", async () => {
      await createProduct(ctx, { name: "Mechanical Keyboard", sku: "KB-1" });
      await createProduct(ctx, { name: "Ergonomic Mouse", sku: "MS-1" });
      await createProduct(ctx, { name: "100% Cotton Mat", sku: "MAT-1" });

      const names = async (q: string) =>
        (await request(ctx.app).get("/products").query({ q })).body.data.map((p: any) => p.name);
      expect(await names("keyboard")).toEqual(["Mechanical Keyboard"]);
      expect(await names("ms-1")).toEqual(["Ergonomic Mouse"]);
      expect(await names("%")).toEqual(["100% Cotton Mat"]);
      expect(await names("_")).toEqual([]);
      expect(await names("zzz")).toEqual([]);
    });

    it("paginates and validates the page parameters", async () => {
      for (let i = 0; i < 5; i++) await createProduct(ctx);
      const page = await request(ctx.app).get("/products?limit=2&offset=4");
      expect(page.body.data).toHaveLength(1);
      expect(page.body.pagination).toEqual({ limit: 2, offset: 4, total: 5 });

      expect((await request(ctx.app).get("/products?limit=0")).status).toBe(400);
      expect((await request(ctx.app).get("/products?limit=1000")).status).toBe(400);
      expect((await request(ctx.app).get("/products?offset=-1")).status).toBe(400);
      expect((await request(ctx.app).get("/products?limit=1&limit=2")).status).toBe(400);
    });

    it("returns a single product, hiding inactive ones from customers", async () => {
      const active = await createProduct(ctx);
      const hidden = await createProduct(ctx, { active: false });

      expect((await request(ctx.app).get(`/products/${active.id}`)).status).toBe(200);
      expect((await request(ctx.app).get(`/products/${hidden.id}`)).status).toBe(404);
      expect((await request(ctx.app).get(`/products/${hidden.id}`).set("Authorization", admin.auth)).status).toBe(200);
      expect((await request(ctx.app).get(`/products/${randomUUID()}`)).status).toBe(404);
      expect((await request(ctx.app).get("/products/not-a-uuid")).status).toBe(404);
    });
  });

  describe("managing (admin only)", () => {
    const body = { sku: "NEW-1", name: "New thing", description: "Nice", priceCents: 1999, stock: 5 };

    it("creates a product and records the initial stock", async () => {
      const res = await request(ctx.app).post("/products").set("Authorization", admin.auth).send(body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ sku: "NEW-1", priceCents: 1999, stock: 5, inStock: true, active: true });

      const { rows } = await ctx.pool.query("SELECT delta, reason FROM inventory_movements WHERE product_id = $1", [res.body.id]);
      expect(rows).toEqual([{ delta: 5, reason: "initial" }]);
    });

    it("creates a product without stock", async () => {
      const res = await request(ctx.app)
        .post("/products")
        .set("Authorization", admin.auth)
        .send({ sku: "NS-1", name: "No stock", priceCents: 100 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ stock: 0, inStock: false, description: "" });
      const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM inventory_movements");
      expect(rows[0].n).toBe(0);
    });

    it("rejects anonymous users and customers", async () => {
      expect((await request(ctx.app).post("/products").send(body)).status).toBe(401);
      expect((await request(ctx.app).post("/products").set("Authorization", customer.auth).send(body)).status).toBe(403);
      const product = await createProduct(ctx);
      expect(
        (await request(ctx.app).patch(`/products/${product.id}`).set("Authorization", customer.auth).send({ name: "x" })).status,
      ).toBe(403);
      expect(
        (await request(ctx.app).post(`/products/${product.id}/inventory`).set("Authorization", customer.auth).send({ delta: 5 })).status,
      ).toBe(403);
    });

    it("rejects a duplicate SKU", async () => {
      await request(ctx.app).post("/products").set("Authorization", admin.auth).send(body);
      const res = await request(ctx.app).post("/products").set("Authorization", admin.auth).send(body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("sku_taken");
    });

    it("validates the input", async () => {
      const post = (payload: object) => request(ctx.app).post("/products").set("Authorization", admin.auth).send(payload);
      expect((await post({ ...body, priceCents: 0 })).status).toBe(400);
      expect((await post({ ...body, priceCents: 19.99 })).status).toBe(400);
      expect((await post({ ...body, priceCents: 2_000_000 })).status).toBe(400);
      expect((await post({ ...body, stock: -1 })).status).toBe(400);
      expect((await post({ ...body, sku: "has spaces" })).status).toBe(400);
      expect((await post({ ...body, name: "   " })).status).toBe(400);
      expect((await post({ ...body, active: false })).status).toBe(400);
    });

    it("updates price, text and visibility", async () => {
      const product = await createProduct(ctx, { priceCents: 1000 });
      const res = await request(ctx.app)
        .patch(`/products/${product.id}`)
        .set("Authorization", admin.auth)
        .send({ priceCents: 1500, name: "Renamed", active: false });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ priceCents: 1500, name: "Renamed", active: false });
      expect((await request(ctx.app).get(`/products/${product.id}`)).status).toBe(404);
    });

    it("rejects empty or unknown updates and unknown products", async () => {
      const product = await createProduct(ctx);
      const patch = (id: string, payload: object) =>
        request(ctx.app).patch(`/products/${id}`).set("Authorization", admin.auth).send(payload);
      expect((await patch(product.id, {})).status).toBe(400);
      expect((await patch(product.id, { stock: 999 })).status).toBe(400);
      expect((await patch(randomUUID(), { name: "x" })).status).toBe(404);
      expect((await patch("nope", { name: "x" })).status).toBe(404);
    });

    it("adjusts inventory in both directions and keeps an audit trail", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const adjust = (delta: number) =>
        request(ctx.app).post(`/products/${product.id}/inventory`).set("Authorization", admin.auth).send({ delta });

      expect((await adjust(5)).body.stock).toBe(15);
      expect((await adjust(-12)).body.stock).toBe(3);
      expect(await stockOf(ctx, product.id)).toBe(3);

      const { rows } = await ctx.pool.query(
        "SELECT delta FROM inventory_movements WHERE product_id = $1 ORDER BY id",
        [product.id],
      );
      expect(rows.map((r) => r.delta)).toEqual([5, -12]);
    });

    it("never lets stock go negative", async () => {
      const product = await createProduct(ctx, { stock: 2 });
      const res = await request(ctx.app)
        .post(`/products/${product.id}/inventory`)
        .set("Authorization", admin.auth)
        .send({ delta: -3 });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "insufficient_stock", details: { available: 2 } });
      expect(await stockOf(ctx, product.id)).toBe(2);
    });

    it("validates inventory adjustments", async () => {
      const product = await createProduct(ctx);
      const adjust = (id: string, payload: object) =>
        request(ctx.app).post(`/products/${id}/inventory`).set("Authorization", admin.auth).send(payload);
      expect((await adjust(product.id, { delta: 0 })).status).toBe(400);
      expect((await adjust(product.id, { delta: 1.5 })).status).toBe(400);
      expect((await adjust(product.id, {})).status).toBe(400);
      expect((await adjust(randomUUID(), { delta: 1 })).status).toBe(404);
      expect((await adjust("nope", { delta: 1 })).status).toBe(404);
    });
  });
});
