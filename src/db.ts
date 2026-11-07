import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Pool, PoolClient } from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Runs `fn` in a transaction; commits on success and rolls back if it throws. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATION_LOCK = 727274;

/** Applies pending .sql files in order. Safe to call from several instances at once. */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
