import type { Config } from "../config";
import { MockPaymentProvider } from "./mock";
import type { PaymentProvider } from "./provider";
import { StripePaymentProvider } from "./stripe";

export function createPaymentProvider(config: Config): PaymentProvider {
  if (config.paymentProvider === "stripe") {
    // loadConfig guarantees both values are present for this provider.
    return StripePaymentProvider.fromKeys(config.stripeSecretKey!, config.stripeWebhookSecret!);
  }
  return new MockPaymentProvider(config.mockWebhookSecret);
}
