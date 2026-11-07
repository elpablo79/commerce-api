import { loadConfig } from "../src/config";
import { createPool, migrate } from "../src/db";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
} finally {
  await pool.end();
}
