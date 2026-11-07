import { createPool, migrate } from "../src/db";
import { assertTestDatabase, TEST_DB_URL } from "./env";

export default async function setup() {
  assertTestDatabase(TEST_DB_URL);
  const pool = createPool(TEST_DB_URL);
  try {
    await migrate(pool);
  } catch (err) {
    throw new Error(
      `Cannot prepare the test database. Is PostgreSQL running (docker compose up -d)?\n${(err as Error).message}`,
    );
  } finally {
    await pool.end();
  }
}
