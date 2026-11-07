export type PaymentEvent = {
  provider: string;
  /** Unique per delivery attempt group; used to ignore duplicates. */
  id: string;
  type: "payment_succeeded" | "payment_failed";
  /** The provider's identifier of the payment (a Stripe PaymentIntent id, for example). */
  reference: string;
};

export interface PaymentProvider {
  readonly name: "mock" | "stripe";
  /** Name of the HTTP header that carries the webhook signature. */
  readonly signatureHeader: string;
  createPayment(input: {
    orderId: string;
    amountCents: number;
    currency: string;
  }): Promise<{ reference: string; clientSecret: string }>;
  /** Best effort: stops a payment that was never completed. */
  cancelPayment(reference: string): Promise<void>;
  /**
   * Verifies the signature and translates the provider payload.
   * Throws a 400 AppError when the signature is invalid; returns null for events we do not use.
   */
  parseWebhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null;
}
