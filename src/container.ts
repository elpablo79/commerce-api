import type { Pool } from "pg";
import { createTokenService } from "./auth";
import type { Config } from "./config";
import type { Logger } from "./logger";
import type { PaymentProvider } from "./payments/provider";
import type { Cache } from "./redis";
import { createOrderService } from "./services/orders";
import { createProductService } from "./services/products";
import { createUserService } from "./services/users";

/** Builds every service from its dependencies. REST and GraphQL share the same instances. */
export function createContainer(deps: {
  config: Config;
  pool: Pool;
  payments: PaymentProvider;
  logger: Logger;
  cache: Cache;
}) {
  const { config, pool, payments, logger, cache } = deps;
  const tokens = createTokenService(config.jwtSecret);
  return {
    tokens,
    users: createUserService({ pool, tokens, bcryptRounds: config.bcryptRounds }),
    products: createProductService({ pool, cache, cacheTtlSeconds: config.catalogCacheTtlSeconds }),
    orders: createOrderService({
      pool,
      payments,
      logger,
      orderExpiryMinutes: config.orderExpiryMinutes,
    }),
    payments,
  };
}

export type Container = ReturnType<typeof createContainer>;
