import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors";
import type { PaymentEvent, PaymentProvider } from "./provider";

export function signMockPayload(secret: string, body: Buffer | string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const eventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(["payment_succeeded", "payment_failed"]),
  reference: z.string().min(1).max(200),
});

/**
 * Offline stand-in for a real provider. It uses the same flow as Stripe (a signed webhook
 * tells us when a payment succeeded) so the whole order lifecycle can be run without any account.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;
  readonly signatureHeader = "x-mock-signature";

  constructor(private readonly secret: string) {}

  async createPayment(_input: {
    orderId: string;
    amountCents: number;
    currency: string;
  }): Promise<{ reference: string; clientSecret: string }> {
    const reference = `mock_pi_${randomUUID()}`;
    return { reference, clientSecret: `${reference}_secret_${randomBytes(8).toString("hex")}` };
  }

  async cancelPayment(_reference: string): Promise<void> {}

  parseWebhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null {
    const invalid = () => new AppError(400, "invalid_signature", "Invalid webhook signature");
    if (!signature) throw invalid();

    const expected = Buffer.from(signMockPayload(this.secret, rawBody), "hex");
    const given = Buffer.from(signature, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new AppError(400, "invalid_payload", "The webhook body is not valid JSON");
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) throw new AppError(400, "invalid_payload", "The webhook payload is not valid");
    return { provider: this.name, ...parsed.data };
  }
}
