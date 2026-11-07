import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockPaymentProvider } from "../src/payments/mock";
import {
  createProduct,
  createTestContext,
  createUser,
  payOrder,
  placeOrder,
  resetDb,
  stockOf,
  type TestContext,
} from "./helpers";

class FailingProvider extends MockPaymentProvider {
  override async createPayment(): Promise<never> {
    throw new Error("provider is down");
  }
}

describe("orders", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await resetDb(ctx);
    admin = await createUser(ctx, "admin");
    alice = await createUser(ctx, "customer");
    bob = await createUser(ctx, "customer");
  });

  const post = (auth: string, path: string, body?: object) =>
    request(ctx.app).post(path).set("Authorization", auth).send(body);
  const get = (auth: string, path: string) => request(ctx.app).get(path).set("Authorization", auth);

  describe("placing an order", () => {
    it("computes the total, reserves stock and snapshots prices", async () => {
      const keyboard = await createProduct(ctx, { name: "Keyboard", priceCents: 1500, stock: 10 });
      const mouse = await createProduct(ctx, { name: "Mouse", priceCents: 250, stock: 5 });

      const { order, clientSecret } = await placeOrder(ctx, alice, [
        { productId: keyboard.id, quantity: 2 },
        { productId: mouse.id, quantity: 4 },
      ]);

      expect(order).toMatchObject({ status: "pending", totalCents: 4000, userId: alice.id, currency: "usd" });
      expect(order.items.map((i) => [i.name, i.quantity, i.unitPriceCents])).toEqual([
        ["Keyboard", 2, 1500],
        ["Mouse", 4, 250],
      ]);
      expect(order.payment).toMatchObject({ provider: "mock", reference: expect.stringMatching(/^mock_pi_/) });
      expect(clientSecret).toContain(order.payment!.reference);
      expect(await stockOf(ctx, keyboard.id)).toBe(8);
      expect(await stockOf(ctx, mouse.id)).toBe(1);

      // A later price change must not rewrite history.
      await ctx.pool.query("UPDATE products SET price_cents = 9999, name = 'Renamed' WHERE id = $1", [keyboard.id]);
      const again = await get(alice.auth, `/orders/${order.id}`);
      expect(again.body.totalCents).toBe(4000);
      expect(again.body.items.find((i: any) => i.productId === keyboard.id)).toMatchObject({
        name: "Keyboard",
        unitPriceCents: 1500,
      });

      const { rows } = await ctx.pool.query(
        "SELECT delta, reason FROM inventory_movements WHERE order_id = $1 ORDER BY delta",
        [order.id],
      );
      expect(rows).toEqual([
        { delta: -4, reason: "order_reserved" },
        { delta: -2, reason: "order_reserved" },
      ]);
    });

    it("merges repeated products into one line", async () => {
      const product = await createProduct(ctx, { stock: 10, priceCents: 100 });
      const { order } = await placeOrder(ctx, alice, [
        { productId: product.id, quantity: 1 },
        { productId: product.id.toUpperCase(), quantity: 2 },
      ]);
      expect(order.items).toHaveLength(1);
      expect(order.items[0].quantity).toBe(3);
      expect(order.totalCents).toBe(300);
      expect(await stockOf(ctx, product.id)).toBe(7);
    });

    it("requires authentication", async () => {
      const product = await createProduct(ctx);
      const res = await request(ctx.app).post("/orders").send({ items: [{ productId: product.id, quantity: 1 }] });
      expect(res.status).toBe(401);
    });

    it("rejects invalid payloads", async () => {
      const product = await createProduct(ctx);
      const bad = async (body: object) => (await post(alice.auth, "/orders", body)).status;
      expect(await bad({ items: [] })).toBe(400);
      expect(await bad({})).toBe(400);
      expect(await bad({ items: [{ productId: product.id, quantity: 0 }] })).toBe(400);
      expect(await bad({ items: [{ productId: product.id, quantity: 1.5 }] })).toBe(400);
      expect(await bad({ items: [{ productId: product.id, quantity: 101 }] })).toBe(400);
      expect(await bad({ items: [{ productId: "nope", quantity: 1 }] })).toBe(400);
      expect(await bad({ items: [{ productId: product.id, quantity: 1, priceCents: 1 }] })).toBe(400);
      expect(await bad({ items: Array.from({ length: 21 }, () => ({ productId: randomUUID(), quantity: 1 })) })).toBe(400);
      expect(
        await bad({
          items: [
            { productId: product.id, quantity: 60 },
            { productId: product.id, quantity: 60 },
          ],
        }),
      ).toBe(400);
      expect(await stockOf(ctx, product.id)).toBe(10);
    });

    it("refuses to oversell and tells the client what is available", async () => {
      const product = await createProduct(ctx, { stock: 2 });
      const res = await post(alice.auth, "/orders", { items: [{ productId: product.id, quantity: 3 }] });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: "insufficient_stock",
        details: { productId: product.id, available: 2 },
      });
      expect(await stockOf(ctx, product.id)).toBe(2);
    });

    it("is all-or-nothing when one line cannot be fulfilled", async () => {
      const plenty = await createProduct(ctx, { stock: 10 });
      const scarce = await createProduct(ctx, { stock: 1 });
      const res = await post(alice.auth, "/orders", {
        items: [
          { productId: plenty.id, quantity: 5 },
          { productId: scarce.id, quantity: 2 },
        ],
      });
      expect(res.status).toBe(409);
      expect(await stockOf(ctx, plenty.id)).toBe(10);
      expect(await stockOf(ctx, scarce.id)).toBe(1);
      const { rows } = await ctx.pool.query("SELECT (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM inventory_movements)::int AS moves");
      expect(rows[0]).toEqual({ orders: 0, moves: 0 });
    });

    it("does not sell unknown or inactive products", async () => {
      const inactive = await createProduct(ctx, { active: false });
      for (const productId of [inactive.id, randomUUID()]) {
        const res = await post(alice.auth, "/orders", { items: [{ productId, quantity: 1 }] });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("product_not_found");
      }
      expect(await stockOf(ctx, inactive.id)).toBe(10);
    });

    it("cancels the order and restores stock if the payment cannot be started", async () => {
      const failing = await createTestContext({ payments: new FailingProvider("x".repeat(16)) });
      try {
        const product = await createProduct(failing, { stock: 5 });
        const res = await request(failing.app)
          .post("/orders")
          .set("Authorization", alice.auth)
          .send({ items: [{ productId: product.id, quantity: 2 }] });
        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe("payment_unavailable");
        expect(await stockOf(failing, product.id)).toBe(5);
        const { rows } = await failing.pool.query("SELECT status FROM orders");
        expect(rows).toEqual([{ status: "cancelled" }]);
      } finally {
        await failing.close();
      }
    });
  });

  describe("reading orders", () => {
    it("shows customers only their own orders, and admins everything", async () => {
      const product = await createProduct(ctx, { stock: 50 });
      const a = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      const b = await placeOrder(ctx, bob, [{ productId: product.id, quantity: 1 }]);

      const mine = await get(alice.auth, "/orders");
      expect(mine.body.data.map((o: any) => o.id)).toEqual([a.order.id]);
      expect(mine.body.pagination.total).toBe(1);

      const all = await get(admin.auth, "/orders");
      expect(all.body.pagination.total).toBe(2);

      expect((await get(alice.auth, `/orders/${a.order.id}`)).status).toBe(200);
      // Someone else's order looks exactly like a missing one.
      expect((await get(alice.auth, `/orders/${b.order.id}`)).status).toBe(404);
      expect((await get(admin.auth, `/orders/${b.order.id}`)).status).toBe(200);
      expect((await get(alice.auth, `/orders/${randomUUID()}`)).status).toBe(404);
      expect((await get(alice.auth, "/orders/not-a-uuid")).status).toBe(404);
      expect((await request(ctx.app).get("/orders")).status).toBe(401);
    });

    it("paginates and filters by status", async () => {
      const product = await createProduct(ctx, { stock: 50 });
      const first = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      await payOrder(ctx, first.order);

      const page = await get(alice.auth, "/orders?limit=2&offset=2");
      expect(page.body.data).toHaveLength(1);
      expect(page.body.pagination).toEqual({ limit: 2, offset: 2, total: 3 });

      const paid = await get(alice.auth, "/orders?status=paid");
      expect(paid.body.data.map((o: any) => o.id)).toEqual([first.order.id]);

      expect((await get(alice.auth, "/orders?status=bogus")).status).toBe(400);
      expect((await get(alice.auth, "/orders?limit=0")).status).toBe(400);
    });
  });

  describe("cancelling", () => {
    it("cancels a pending order and puts the stock back", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 4 }]);
      expect(await stockOf(ctx, product.id)).toBe(6);

      const res = await post(alice.auth, `/orders/${order.id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(res.body.cancelledAt).toEqual(expect.any(String));
      expect(await stockOf(ctx, product.id)).toBe(10);

      const { rows } = await ctx.pool.query(
        "SELECT delta, reason FROM inventory_movements WHERE order_id = $1 ORDER BY id",
        [order.id],
      );
      expect(rows).toEqual([
        { delta: -4, reason: "order_reserved" },
        { delta: 4, reason: "order_cancelled" },
      ]);
    });

    it("cannot be done twice, so stock is never restored twice", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 4 }]);
      expect((await post(alice.auth, `/orders/${order.id}/cancel`)).status).toBe(200);
      const again = await post(alice.auth, `/orders/${order.id}/cancel`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("order_not_cancellable");
      expect(await stockOf(ctx, product.id)).toBe(10);
    });

    it("is restricted to the owner (or an admin)", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      expect((await post(bob.auth, `/orders/${order.id}/cancel`)).status).toBe(404);
      expect((await post(admin.auth, `/orders/${order.id}/cancel`)).status).toBe(200);
      expect((await post(alice.auth, `/orders/${randomUUID()}/cancel`)).status).toBe(404);
      expect((await post(alice.auth, "/orders/nope/cancel")).status).toBe(404);
    });

    it("is not possible once the order is paid", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      await payOrder(ctx, order);
      const res = await post(alice.auth, `/orders/${order.id}/cancel`);
      expect(res.status).toBe(409);
      expect(await stockOf(ctx, product.id)).toBe(9);
    });
  });

  describe("fulfilment", () => {
    it("moves a paid order through shipped to delivered", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      await payOrder(ctx, order);

      const shipped = await post(admin.auth, `/orders/${order.id}/ship`);
      expect(shipped.status).toBe(200);
      expect(shipped.body).toMatchObject({ status: "shipped", shippedAt: expect.any(String), paidAt: expect.any(String) });

      const delivered = await post(admin.auth, `/orders/${order.id}/deliver`);
      expect(delivered.body).toMatchObject({ status: "delivered", deliveredAt: expect.any(String) });
    });

    it("enforces the lifecycle order", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);

      const early = await post(admin.auth, `/orders/${order.id}/ship`);
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe("invalid_transition");

      await payOrder(ctx, order);
      expect((await post(admin.auth, `/orders/${order.id}/deliver`)).status).toBe(409);
    });

    it("is reserved for admins", async () => {
      const product = await createProduct(ctx, { stock: 10 });
      const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
      expect((await post(alice.auth, `/orders/${order.id}/ship`)).status).toBe(403);
      expect((await post(alice.auth, `/orders/${order.id}/deliver`)).status).toBe(403);
      expect((await post(admin.auth, `/orders/${randomUUID()}/ship`)).status).toBe(404);
      expect((await post(admin.auth, "/orders/nope/ship")).status).toBe(404);
    });
  });
});
