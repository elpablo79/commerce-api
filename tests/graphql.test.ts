import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProduct, createTestContext, createUser, gql, payOrder, placeOrder, resetDb, stockOf, type TestContext } from "./helpers";

describe("GraphQL API", () => {
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
    alice = await createUser(ctx, "customer", "alice@example.com");
    bob = await createUser(ctx, "customer");
  });

  const PRODUCTS = "query($s: String, $l: Int, $o: Int) { products(search: $s, limit: $l, offset: $o) { total limit offset data { id name priceCents inStock stock } } }";

  it("lists and searches products, hiding exact stock from customers", async () => {
    await createProduct(ctx, { name: "Mechanical Keyboard", stock: 4 });
    await createProduct(ctx, { name: "Mouse", stock: 0 });
    await createProduct(ctx, { name: "Retired", active: false });

    const all = await gql(ctx, PRODUCTS, {});
    expect(all.body.errors).toBeUndefined();
    expect(all.body.data.products.total).toBe(2);
    expect(all.body.data.products.data.every((p: any) => p.stock === null)).toBe(true);

    const found = await gql(ctx, PRODUCTS, { s: "keyboard", l: 5, o: 0 });
    expect(found.body.data.products.data.map((p: any) => p.name)).toEqual(["Mechanical Keyboard"]);
    expect(found.body.data.products.data[0].inStock).toBe(true);

    const asAdmin = await gql(ctx, PRODUCTS, { s: "keyboard" }, admin.auth);
    expect(asAdmin.body.data.products.data[0].stock).toBe(4);
  });

  it("fetches one product and returns null for a missing or hidden one", async () => {
    const product = await createProduct(ctx, { name: "Lamp" });
    const hidden = await createProduct(ctx, { active: false });
    const query = "query($id: ID!) { product(id: $id) { name } }";
    expect((await gql(ctx, query, { id: product.id })).body.data.product).toEqual({ name: "Lamp" });
    expect((await gql(ctx, query, { id: hidden.id })).body.data.product).toBeNull();
    expect((await gql(ctx, query, { id: randomUUID() })).body.data.product).toBeNull();
    expect((await gql(ctx, query, { id: "nope" })).body.data.product).toBeNull();
  });

  it("describes the current user, or null when anonymous", async () => {
    const me = "{ me { email role } }";
    expect((await gql(ctx, me, {}, alice.auth)).body.data.me).toEqual({ email: "alice@example.com", role: "customer" });
    expect((await gql(ctx, me)).body.data.me).toBeNull();
    expect((await gql(ctx, me, {}, "Bearer garbage")).body.data.me).toBeNull();
  });

  it("places an order and reserves stock", async () => {
    const product = await createProduct(ctx, { priceCents: 1200, stock: 5 });
    const res = await gql(
      ctx,
      `mutation($items: [OrderItemInput!]!) {
         createOrder(items: $items) { clientSecret order { id status totalCents items { name quantity unitPriceCents } } }
       }`,
      { items: [{ productId: product.id, quantity: 2 }] },
      alice.auth,
    );
    expect(res.body.errors).toBeUndefined();
    const { order, clientSecret } = res.body.data.createOrder;
    expect(order).toMatchObject({ status: "PENDING", totalCents: 2400 });
    expect(order.items).toEqual([{ name: product.name, quantity: 2, unitPriceCents: 1200 }]);
    expect(clientSecret).toMatch(/^mock_pi_/);
    expect(await stockOf(ctx, product.id)).toBe(3);
  });

  it("returns stable error codes", async () => {
    const product = await createProduct(ctx, { stock: 1 });
    const mutation = "mutation($items: [OrderItemInput!]!) { createOrder(items: $items) { clientSecret } }";

    const anonymous = await gql(ctx, mutation, { items: [{ productId: product.id, quantity: 1 }] });
    expect(anonymous.body.errors[0].extensions.code).toBe("unauthorized");

    const oversell = await gql(ctx, mutation, { items: [{ productId: product.id, quantity: 5 }] }, alice.auth);
    expect(oversell.body.errors[0].extensions).toMatchObject({
      code: "insufficient_stock",
      details: { available: 1 },
    });

    const invalid = await gql(ctx, mutation, { items: [] }, alice.auth);
    expect(invalid.body.errors[0].extensions.code).toBe("validation_error");

    // Schema-level problems are reported by GraphQL itself.
    const malformed = await gql(ctx, "{ nonexistent }");
    expect(malformed.body.errors[0].message).toMatch(/Cannot query field/);
  });

  it("lists orders by owner, with filtering and pagination", async () => {
    const product = await createProduct(ctx, { stock: 20 });
    const first = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
    await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
    await placeOrder(ctx, bob, [{ productId: product.id, quantity: 1 }]);
    await payOrder(ctx, first.order);

    const query = "query($status: OrderStatus, $limit: Int) { orders(status: $status, limit: $limit) { total data { id status } } }";
    const mine = await gql(ctx, query, {}, alice.auth);
    expect(mine.body.data.orders.total).toBe(2);
    expect((await gql(ctx, query, { limit: 1 }, alice.auth)).body.data.orders.data).toHaveLength(1);
    const paid = await gql(ctx, query, { status: "PAID" }, alice.auth);
    expect(paid.body.data.orders.data).toEqual([{ id: first.order.id, status: "PAID" }]);
    expect((await gql(ctx, query, {}, admin.auth)).body.data.orders.total).toBe(3);

    const anonymous = await gql(ctx, query, {});
    expect(anonymous.body.errors[0].extensions.code).toBe("unauthorized");
  });

  it("fetches an order only for its owner or an admin", async () => {
    const product = await createProduct(ctx, { stock: 5 });
    const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 1 }]);
    const query = "query($id: ID!) { order(id: $id) { id status } }";
    expect((await gql(ctx, query, { id: order.id }, alice.auth)).body.data.order.id).toBe(order.id);
    expect((await gql(ctx, query, { id: order.id }, admin.auth)).body.data.order.id).toBe(order.id);
    expect((await gql(ctx, query, { id: order.id }, bob.auth)).body.data.order).toBeNull();
    expect((await gql(ctx, query, { id: randomUUID() }, alice.auth)).body.data.order).toBeNull();
  });

  it("cancels an order", async () => {
    const product = await createProduct(ctx, { stock: 5 });
    const { order } = await placeOrder(ctx, alice, [{ productId: product.id, quantity: 2 }]);
    const mutation = "mutation($id: ID!) { cancelOrder(id: $id) { status cancelledAt } }";

    const notYours = await gql(ctx, mutation, { id: order.id }, bob.auth);
    expect(notYours.body.errors[0].extensions.code).toBe("not_found");

    const ok = await gql(ctx, mutation, { id: order.id }, alice.auth);
    expect(ok.body.data.cancelOrder.status).toBe("CANCELLED");
    expect(await stockOf(ctx, product.id)).toBe(5);

    const again = await gql(ctx, mutation, { id: order.id }, alice.auth);
    expect(again.body.errors[0].extensions.code).toBe("order_not_cancellable");
  });
});
