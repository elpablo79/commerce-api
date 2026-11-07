/**
 * Walks through the whole shop flow against a running server (npm run dev) with seeded data:
 * browse, register, order, pay, ship, then query the same data over GraphQL.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { signMockPayload } from "../src/payments/mock";

const config = loadConfig();
const base = process.env.DEMO_BASE_URL ?? `http://localhost:${config.port}`;
const password = process.env.SEED_PASSWORD ?? "demo-password-123";

type Json = Record<string, any>;

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);
const ok = (text: string) => console.log(`   ✓ ${text}`);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

step(1, "Browse the public catalogue");
const catalogue = await call("GET", "/products?limit=3");
ok(`${catalogue.pagination.total} products, first: ${catalogue.data[0].name} (${money(catalogue.data[0].priceCents)})`);
const product = catalogue.data[0];

step(2, "Register a new customer");
const email = `demo-${Date.now()}@example.com`;
const customer = await call("POST", "/auth/register", { body: { email, password } });
ok(`registered ${customer.user.email} with role ${customer.user.role}`);

step(3, "Place an order for 2 units");
const created = await call("POST", "/orders", {
  token: customer.token,
  body: { items: [{ productId: product.id, quantity: 2 }] },
});
const order = created.order;
ok(`order ${order.id} is ${order.status}, total ${money(order.totalCents)}`);
ok(`client secret for the payment SDK: ${created.clientSecret.slice(0, 24)}...`);

step(4, "The payment provider confirms the payment (signed webhook)");
const event = JSON.stringify({ id: randomUUID(), type: "payment_succeeded", reference: order.payment.reference });
const hook = await fetch(`${base}/webhooks/payments`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-mock-signature": signMockPayload(config.mockWebhookSecret, event) },
  body: event,
});
ok(`webhook answered ${hook.status} ${await hook.text()}`);
const paid = await call("GET", `/orders/${order.id}`, { token: customer.token });
ok(`order is now ${paid.status}`);

step(5, "An admin ships it and checks the stock");
const admin = await call("POST", "/auth/login", { body: { email: "admin@example.com", password } });
const shipped = await call("POST", `/orders/${order.id}/ship`, { token: admin.token });
ok(`order is now ${shipped.status}`);
const adminView = await call("GET", `/products/${product.id}`, { token: admin.token });
ok(`${adminView.name}: exactly ${adminView.stock} left (customers only see inStock=${product.inStock})`);

step(6, "The same data over GraphQL");
const gql = await fetch(`${base}/graphql`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${customer.token}` },
  body: JSON.stringify({
    query: "{ me { email } orders { total data { status totalCents items { name quantity } } } }",
  }),
});
const data = ((await gql.json()) as Json).data;
ok(`${data.me.email} has ${data.orders.total} order: ${JSON.stringify(data.orders.data[0])}`);

console.log("\nDemo complete.");
