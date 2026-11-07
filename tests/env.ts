export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://commerce:commerce@localhost:5432/commerce_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

/** Tests wipe their tables, so refuse to run against anything that is not clearly a test database. */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run tests on database "${name}": its name must end with "_test"`);
  }
}

export function assertTestRedis(url: string): void {
  const index = new URL(url).pathname.replace(/^\//, "");
  if (!index || index === "0") {
    throw new Error("Refusing to run tests on Redis database 0: use a dedicated index such as /15");
  }
}
