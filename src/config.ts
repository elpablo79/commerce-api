import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().optional(),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
    MOCK_WEBHOOK_SECRET: z.string().min(16).default("dev-only-mock-webhook-secret"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    CORS_ORIGINS: z.string().default(""),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    ORDER_EXPIRY_MINUTES: z.coerce.number().int().min(1).default(30),
    CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(15),
    LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PROVIDER === "stripe") {
      for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when PAYMENT_PROVIDER=stripe`,
          });
        }
      }
    }
    if (env.PAYMENT_PROVIDER === "mock" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PAYMENT_PROVIDER"],
        message: "PAYMENT_PROVIDER=mock is not allowed in production",
      });
    }
  });

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // A blank value in a .env file means "not set".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    paymentProvider: e.PAYMENT_PROVIDER,
    mockWebhookSecret: e.MOCK_WEBHOOK_SECRET,
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    rateLimitMax: e.RATE_LIMIT_MAX,
    authRateLimitMax: e.AUTH_RATE_LIMIT_MAX,
    bcryptRounds: e.BCRYPT_ROUNDS,
    orderExpiryMinutes: e.ORDER_EXPIRY_MINUTES,
    catalogCacheTtlSeconds: e.CATALOG_CACHE_TTL_SECONDS,
    logLevel: e.LOG_LEVEL,
  };
}

export type Config = ReturnType<typeof loadConfig>;
