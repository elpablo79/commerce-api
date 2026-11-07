/**
 * Simulates the payment provider telling the API that an order was paid.
 *   npm run mock:pay -- <orderId>            -> payment succeeded
 *   npm run mock:pay -- <orderId> --fail     -> payment failed
 * Only works with PAYMENT_PROVIDER=mock.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { signMockPayload } from "../src/payments/mock";

const [orderId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const failed = process.argv.includes("--fail");
if (!orderId) {
  console.error("Usage: npm run mock:pay -- <orderId> [--fail]");
  process.exit(1);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const { rows } = await pool.query<{ payment_reference: string }>(
    "SELECT payment_reference FROM orders WHERE id = $1 AND payment_provider = 'mock'",
    [orderId],
  );
  if (!rows[0]) {
    console.error("No order with a mock payment was found for that id.");
    process.exit(1);
  }

  const body = JSON.stringify({
    id: randomUUID(),
    type: failed ? "payment_failed" : "payment_succeeded",
    reference: rows[0].payment_reference,
  });
  const res = await fetch(`http://localhost:${config.port}/webhooks/payments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mock-signature": signMockPayload(config.mockWebhookSecret, body),
    },
    body,
  });
  console.log(res.status, await res.text());
} finally {
  await pool.end();
}
