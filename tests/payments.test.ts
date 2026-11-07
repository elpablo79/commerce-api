import { randomUUID } from "node:crypto";
import request from "supertest";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentProvider } from "../src/payments";
import { MockPaymentProvider, signMockPayload } from "../src/payments/mock";
import { StripePaymentProvider, type StripeLike } from "../src/payments/stripe";
import { loadConfig } from "../src/config";
import {
  createProduct,
  createTestContext,
  createUser,
  payOrder,
  placeOrder,
  resetDb,
  sendMockEvent,
  stockOf,
  type TestContext,
} from "./helpers";

describe("payment webhooks (mock provider)", () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await resetDb(ctx);
    user = await createUser(ctx);
  });

  async function pendingOrder() {
    const product = await createProduct(ctx, { stock: 10 });
    const { order } = await placeOrder(ctx, user, [{ productId: product.id, quantity: 2 }]);
    return { order, product };
  }
  const statusOf = async (id: string) =>
    (await ctx.pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;

  it("marks the order as paid when a valid event arrives", async () => {
    const { order } = await pendingOrder();
    const res = await sendMockEvent(ctx, { type: "payment_succeeded", reference: order.payment!.reference });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, result: "paid" });

    const after = await request(ctx.app).get(`/orders/${order.id}`).set("Authorization", user.auth);
    expect(after.body).toMatchObject({ status: "paid", paidAt: expect.any(String) });
  });

  it("ignores a redelivered event", async () => {
    const { order } = await pendingOrder();
    const event = { id: "evt_1", type: "payment_succeeded" as const, reference: order.payment!.reference };
    expect((await sendMockEvent(ctx, event)).body.result).toBe("paid");
    expect((await sendMockEvent(ctx, event)).body.result).toBe("duplicate");
    expect(await statusOf(order.id)).toBe("paid");
  });

  it("does nothing harmful when a second, different event arrives for a paid order", async () => {
    const { order } = await pendingOrder();
    await payOrder(ctx, order);
    const again = await sendMockEvent(ctx, { type: "payment_succeeded", reference: order.payment!.reference });
    expect(again.body.result).toBe("already_paid");
  });

  it("keeps the order pending after a failed payment, so the customer can retry", async () => {
    const { order } = await pendingOrder();
    const res = await sendMockEvent(ctx, { type: "payment_failed", reference: order.payment!.reference });
    expect(res.body.result).toBe("recorded");
    expect(await statusOf(order.id)).toBe("pending");
  });

  it("does not resurrect a cancelled order, and flags the payment for a manual refund", async () => {
    const { order, product } = await pendingOrder();
    await request(ctx.app).post(`/orders/${order.id}/cancel`).set("Authorization", user.auth);
    const res = await sendMockEvent(ctx, { type: "payment_succeeded", reference: order.payment!.reference });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("late_payment");
    expect(await statusOf(order.id)).toBe("cancelled");
    expect(await stockOf(ctx, product.id)).toBe(10);
  });

  it("acknowledges events about unknown payments without changing anything", async () => {
    await pendingOrder();
    const res = await sendMockEvent(ctx, { type: "payment_succeeded", reference: "mock_pi_unknown" });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("ignored");
  });

  it("rejects events with a bad or missing signature and leaves the order alone", async () => {
    const { order } = await pendingOrder();
    const body = JSON.stringify({ id: randomUUID(), type: "payment_succeeded", reference: order.payment!.reference });

    const wrongSecret = await request(ctx.app)
      .post("/webhooks/payments")
      .set("content-type", "application/json")
      .set("x-mock-signature", signMockPayload("not-the-real-secret-at-all", body))
      .send(body);
    expect(wrongSecret.status).toBe(400);
    expect(wrongSecret.body.error.code).toBe("invalid_signature");

    const missing = await request(ctx.app).post("/webhooks/payments").set("content-type", "application/json").send(body);
    expect(missing.status).toBe(400);

    const notHex = await request(ctx.app)
      .post("/webhooks/payments")
      .set("content-type", "application/json")
      .set("x-mock-signature", "zzzz")
      .send(body);
    expect(notHex.status).toBe(400);

    // A valid signature over a tampered body must fail too.
    const tampered = await request(ctx.app)
      .post("/webhooks/payments")
      .set("content-type", "application/json")
      .set("x-mock-signature", signMockPayload(ctx.config.mockWebhookSecret, body))
      .send(body.replace("payment_succeeded", "payment_failed"));
    expect(tampered.status).toBe(400);

    expect(await statusOf(order.id)).toBe("pending");
  });

  it("rejects signed payloads that are not valid events", async () => {
    const sign = (body: string) =>
      request(ctx.app)
        .post("/webhooks/payments")
        .set("content-type", "application/json")
        .set("x-mock-signature", signMockPayload(ctx.config.mockWebhookSecret, body))
        .send(body);
    expect((await sign("this is not json")).body.error.code).toBe("invalid_payload");
    expect((await sign(JSON.stringify({ id: "1", type: "something_else", reference: "x" }))).body.error.code).toBe("invalid_payload");
  });

  it("handles an empty request without crashing", async () => {
    const res = await request(ctx.app).post("/webhooks/payments");
    expect(res.status).toBe(400);
  });
});

describe("Stripe provider", () => {
  const secret = "whsec_test_secret";
  const real = new Stripe("sk_test_dummy_key_never_used_for_network_calls");

  const intents = {
    create: vi.fn(async () => ({ id: "pi_test_1", client_secret: "pi_test_1_secret_abc" as string | null })),
    cancel: vi.fn(async () => ({})),
  };
  const stripe = { paymentIntents: intents, webhooks: real.webhooks } as unknown as StripeLike;
  const provider = new StripePaymentProvider(stripe, secret);

  function stripeEvent(type: string, objectId: string | null = "pi_test_1", id = `evt_${randomUUID()}`) {
    const payload = JSON.stringify({ id, object: "event", type, data: { object: { id: objectId ?? undefined, object: "payment_intent" } } });
    const header = real.webhooks.generateTestHeaderString({ payload, secret });
    return { payload, header };
  }

  beforeEach(() => {
    intents.create.mockClear();
    intents.cancel.mockClear();
  });

  it("creates an idempotent PaymentIntent and returns the client secret", async () => {
    const result = await provider.createPayment({ orderId: "order-1", amountCents: 2500, currency: "usd" });
    expect(result).toEqual({ reference: "pi_test_1", clientSecret: "pi_test_1_secret_abc" });
    expect(intents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2500, currency: "usd", metadata: { orderId: "order-1" } }),
      { idempotencyKey: "order-order-1" },
    );
  });

  it("fails loudly when Stripe returns no client secret", async () => {
    intents.create.mockResolvedValueOnce({ id: "pi_x", client_secret: null });
    await expect(provider.createPayment({ orderId: "o", amountCents: 100, currency: "usd" })).rejects.toThrow(/client secret/);
  });

  it("cancels a PaymentIntent", async () => {
    await provider.cancelPayment("pi_test_1");
    expect(intents.cancel).toHaveBeenCalledWith("pi_test_1");
  });

  it("verifies real Stripe signatures and maps the events we care about", () => {
    const ok = stripeEvent("payment_intent.succeeded", "pi_abc", "evt_1");
    expect(provider.parseWebhook(Buffer.from(ok.payload), ok.header)).toEqual({
      provider: "stripe",
      id: "evt_1",
      type: "payment_succeeded",
      reference: "pi_abc",
    });
    const failed = stripeEvent("payment_intent.payment_failed", "pi_abc", "evt_2");
    expect(provider.parseWebhook(Buffer.from(failed.payload), failed.header)?.type).toBe("payment_failed");
  });

  it("ignores events it does not use", () => {
    const other = stripeEvent("customer.created", "cus_1");
    expect(provider.parseWebhook(Buffer.from(other.payload), other.header)).toBeNull();
    const noId = stripeEvent("payment_intent.succeeded", null);
    expect(provider.parseWebhook(Buffer.from(noId.payload), noId.header)).toBeNull();
  });

  it("rejects wrong, missing and tampered signatures", () => {
    const ok = stripeEvent("payment_intent.succeeded");
    expect(() => provider.parseWebhook(Buffer.from(ok.payload), undefined)).toThrowError(/Missing webhook signature/);
    expect(() => provider.parseWebhook(Buffer.from(ok.payload), "t=1,v1=deadbeef")).toThrowError(/Invalid webhook signature/);
    expect(() => provider.parseWebhook(Buffer.from(ok.payload + " "), ok.header)).toThrowError(/Invalid webhook signature/);
    const wrongSecret = real.webhooks.generateTestHeaderString({ payload: ok.payload, secret: "whsec_other" });
    expect(() => provider.parseWebhook(Buffer.from(ok.payload), wrongSecret)).toThrowError(/Invalid webhook signature/);
  });

  describe("end to end through the HTTP API", () => {
    let ctx: TestContext;
    beforeAll(async () => {
      ctx = await createTestContext({ payments: provider });
    });
    afterAll(() => ctx.close());
    beforeEach(() => resetDb(ctx));

    it("pays an order using a Stripe-signed webhook", async () => {
      const user = await createUser(ctx);
      const product = await createProduct(ctx, { stock: 5, priceCents: 700 });
      const { order, clientSecret } = await placeOrder(ctx, user, [{ productId: product.id, quantity: 3 }]);
      expect(order.payment).toEqual({ provider: "stripe", reference: "pi_test_1" });
      expect(clientSecret).toBe("pi_test_1_secret_abc");
      expect(intents.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 2100 }), expect.anything());

      const event = stripeEvent("payment_intent.succeeded", "pi_test_1");
      const res = await request(ctx.app)
        .post("/webhooks/payments")
        .set("content-type", "application/json")
        .set("stripe-signature", event.header)
        .send(event.payload);
      expect(res.body.result).toBe("paid");

      const unused = stripeEvent("customer.created", "cus_1");
      const ignored = await request(ctx.app)
        .post("/webhooks/payments")
        .set("content-type", "application/json")
        .set("stripe-signature", unused.header)
        .send(unused.payload);
      expect(ignored.status).toBe(200);
      expect(ignored.body.result).toBe("ignored");
    });
  });
});

describe("provider selection", () => {
  const base = { DATABASE_URL: "postgres://x/y", JWT_SECRET: "s".repeat(32) };

  it("builds the mock provider by default and Stripe when configured", () => {
    expect(createPaymentProvider(loadConfig(base))).toBeInstanceOf(MockPaymentProvider);
    const stripe = createPaymentProvider(
      loadConfig({ ...base, PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }),
    );
    expect(stripe).toBeInstanceOf(StripePaymentProvider);
    expect(stripe.name).toBe("stripe");
  });
});
