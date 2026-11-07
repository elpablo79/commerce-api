import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockPaymentProvider } from "../src/payments/mock";
import { createProduct, createTestContext, createUser, payOrder, placeOrder, resetDb, stockOf, type TestContext } from "./helpers";

class SpyProvider extends MockPaymentProvider {
  cancelled: string[] = [];
  failOnCancel = false;
  override async cancelPayment(reference: string): Promise<void> {
    if (this.failOnCancel) throw new Error("provider unreachable");
    this.cancelled.push(reference);
  }
}

describe("order expiry", () => {
  let ctx: TestContext;
  const provider = new SpyProvider("dev-only-mock-webhook-secret");

  beforeAll(async () => {
    ctx = await createTestContext({ payments: provider });
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await resetDb(ctx);
    provider.cancelled = [];
    provider.failOnCancel = false;
  });

  const age = (orderId: string, minutes: number) =>
    ctx.pool.query("UPDATE orders SET created_at = now() - make_interval(mins => $2) WHERE id = $1", [orderId, minutes]);
  const statusOf = async (id: string) =>
    (await ctx.pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;

  it("cancels unpaid orders past the deadline, returns their stock and stops the payment", async () => {
    const user = await createUser(ctx);
    const product = await createProduct(ctx, { stock: 10 });
    const stale = await placeOrder(ctx, user, [{ productId: product.id, quantity: 3 }]);
    const fresh = await placeOrder(ctx, user, [{ productId: product.id, quantity: 2 }]);
    const paid = await placeOrder(ctx, user, [{ productId: product.id, quantity: 1 }]);
    await payOrder(ctx, paid.order);
    await age(stale.order.id, 31);
    await age(paid.order.id, 120);
    expect(await stockOf(ctx, product.id)).toBe(4);

    expect(await ctx.container.orders.expireStale()).toBe(1);

    expect(await statusOf(stale.order.id)).toBe("cancelled");
    expect(await statusOf(fresh.order.id)).toBe("pending");
    expect(await statusOf(paid.order.id)).toBe("paid");
    expect(await stockOf(ctx, product.id)).toBe(7);
    expect(provider.cancelled).toEqual([stale.order.payment!.reference]);

    // Running it again finds nothing left to do.
    expect(await ctx.container.orders.expireStale()).toBe(0);
  });

  it("uses the clock it is given", async () => {
    const user = await createUser(ctx);
    const product = await createProduct(ctx, { stock: 10 });
    const { order } = await placeOrder(ctx, user, [{ productId: product.id, quantity: 1 }]);
    expect(await ctx.container.orders.expireStale(new Date(Date.now() + 29 * 60_000))).toBe(0);
    expect(await ctx.container.orders.expireStale(new Date(Date.now() + 31 * 60_000))).toBe(1);
    expect(await statusOf(order.id)).toBe("cancelled");
  });

  it("still expires the order when the provider cannot be reached", async () => {
    provider.failOnCancel = true;
    const user = await createUser(ctx);
    const product = await createProduct(ctx, { stock: 10 });
    const { order } = await placeOrder(ctx, user, [{ productId: product.id, quantity: 2 }]);
    await age(order.id, 60);
    expect(await ctx.container.orders.expireStale()).toBe(1);
    expect(await statusOf(order.id)).toBe("cancelled");
    expect(await stockOf(ctx, product.id)).toBe(10);
  });

  it("skips orders that got paid between the lookup and the cancellation", async () => {
    const user = await createUser(ctx);
    const product = await createProduct(ctx, { stock: 10 });
    const { order } = await placeOrder(ctx, user, [{ productId: product.id, quantity: 2 }]);
    await age(order.id, 60);
    // Simulates the race: the order is no longer pending when the sweeper gets to it.
    await ctx.pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [order.id]);
    expect(await ctx.container.orders.expireStale()).toBe(0);
    expect(await stockOf(ctx, product.id)).toBe(8);
  });
});
