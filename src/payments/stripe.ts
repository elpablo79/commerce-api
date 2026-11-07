import Stripe from "stripe";
import { AppError } from "../errors";
import type { PaymentEvent, PaymentProvider } from "./provider";

/** The small part of the Stripe SDK this provider uses, which also makes it easy to stub in tests. */
export interface StripeLike {
  paymentIntents: {
    create(
      params: {
        amount: number;
        currency: string;
        automatic_payment_methods: { enabled: boolean };
        metadata: Record<string, string>;
      },
      options: { idempotencyKey: string },
    ): Promise<{ id: string; client_secret: string | null }>;
    cancel(id: string): Promise<unknown>;
  };
  webhooks: {
    constructEvent(
      payload: Buffer,
      header: string,
      secret: string,
    ): { id: string; type: string; data: { object: { id?: string } } };
  };
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly signatureHeader = "stripe-signature";

  constructor(
    private readonly stripe: StripeLike,
    private readonly webhookSecret: string,
  ) {}

  static fromKeys(secretKey: string, webhookSecret: string): StripePaymentProvider {
    return new StripePaymentProvider(new Stripe(secretKey) as unknown as StripeLike, webhookSecret);
  }

  async createPayment(input: { orderId: string; amountCents: number; currency: string }) {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency,
        automatic_payment_methods: { enabled: true },
        metadata: { orderId: input.orderId },
      },
      // Retrying the same order can never create a second charge.
      { idempotencyKey: `order-${input.orderId}` },
    );
    if (!intent.client_secret) throw new Error("Stripe did not return a client secret");
    return { reference: intent.id, clientSecret: intent.client_secret };
  }

  async cancelPayment(reference: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(reference);
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null {
    if (!signature) throw new AppError(400, "invalid_signature", "Missing webhook signature");

    let event: ReturnType<StripeLike["webhooks"]["constructEvent"]>;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new AppError(400, "invalid_signature", "Invalid webhook signature");
    }

    const reference = event.data.object.id;
    if (!reference) return null;
    if (event.type === "payment_intent.succeeded") {
      return { provider: this.name, id: event.id, type: "payment_succeeded", reference };
    }
    if (event.type === "payment_intent.payment_failed") {
      return { provider: this.name, id: event.id, type: "payment_failed", reference };
    }
    return null;
  }
}
