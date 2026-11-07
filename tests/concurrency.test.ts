import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createProduct,
  createTestContext,
  createUser,
  placeOrder,
  resetDb,
  sendMockEvent,
  stockOf,
  type TestContext,
} from "./helpers";

describe("concurrency", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetDb(ctx));

  it("never oversells: 25 simultaneous buyers, 10 units", async () => {
    const product = await createProduct(ctx, { stock: 10 });
    const buyers = await Promise.all(Array.from({ length: 25 }, () => createUser(ctx)));

    const results = await Promise.all(
      buyers.map((buyer) =>
        request(ctx.app)
          .post("/orders")
          .set("Authorization", buyer.auth)
          .send({ items: [{ productId: product.id, quantity: 1 }] }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(15);
    expect(await stockOf(ctx, product.id)).toBe(0);

    const { rows } = await ctx.pool.query(
      "SELECT sum(delta)::int AS net FROM inventory_movements WHERE product_id = $1",
      [product.id],
    );
    expect(rows[0].net).toBe(-10);
  });

  it("does not deadlock when orders lock the same products in different orders", async () => {
    const a = await createProduct(ctx, { stock: 100 });
    const b = await createProduct(ctx, { stock: 100 });
    const buyers = await Promise.all(Array.from({ length: 20 }, () => createUser(ctx)));

    const results = await Promise.all(
      buyers.map((buyer, i) =>
        request(ctx.app)
          .post("/orders")
          .set("Authorization", buyer.auth)
          .send({
            items: i % 2 === 0
              ? [{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }]
              : [{ productId: b.id, quantity: 1 }, { productId: a.id, quantity: 1 }],
          }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(ctx, a.id)).toBe(80);
    expect(await stockOf(ctx, b.id)).toBe(80);
  });

  it("restores stock only once when the same order is cancelled twice at the same time", async () => {
    const product = await createProduct(ctx, { stock: 10 });
    const user = await createUser(ctx);
    const { order } = await placeOrder(ctx, user, [{ productId: product.id, quantity: 4 }]);

    const results = await Promise.all([
      request(ctx.app).post(`/orders/${order.id}/cancel`).set("Authorization", user.auth),
      request(ctx.app).post(`/orders/${order.id}/cancel`).set("Authorization", user.auth),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stockOf(ctx, product.id)).toBe(10);
  });

  it("keeps stock and status consistent when payment and cancellation race", async () => {
    for (let round = 0; round < 8; round++) {
      const product = await createProduct(ctx, { stock: 10 });
      const user = await createUser(ctx);
      const { order } = await placeOrder(ctx, user, [{ productId: product.id, quantity: 3 }]);

      const [cancel, payment] = await Promise.all([
        request(ctx.app).post(`/orders/${order.id}/cancel`).set("Authorization", user.auth),
        sendMockEvent(ctx, { type: "payment_succeeded", reference: order.payment!.reference }),
      ]);

      const { rows } = await ctx.pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
      const status = rows[0].status;
      if (status === "paid") {
        // The payment won: the cancellation must have been refused and the stock stays reserved.
        expect(cancel.status).toBe(409);
        expect(payment.body.result).toBe("paid");
        expect(await stockOf(ctx, product.id)).toBe(7);
      } else {
        // The cancellation won: the stock is back and the late payment is flagged, not applied.
        expect(status).toBe("cancelled");
        expect(cancel.status).toBe(200);
        expect(payment.body.result).toBe("late_payment");
        expect(await stockOf(ctx, product.id)).toBe(10);
      }
    }
  });
});
