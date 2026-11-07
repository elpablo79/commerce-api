import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Let a local .env override the test database / Redis URLs without exporting them in the shell.
const fileEnv = loadEnv("test", process.cwd(), "");
for (const key of ["TEST_DATABASE_URL", "TEST_REDIS_URL"]) {
  if (fileEnv[key] && !process.env[key]) process.env[key] = fileEnv[key];
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Tests share one database, so test files run one after the other.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The entrypoint only wires things together and starts listening.
      exclude: ["src/server.ts"],
      reporter: ["text", "html"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
