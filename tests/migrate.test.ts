import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, MIGRATIONS_DIR, withTransaction } from "../src/db";
import { readdir } from "node:fs/promises";
import { assertTestDatabase, TEST_DB_URL } from "./env";

// Runs in a throwaway schema so the real tables used by the other tests are never touched.
const SCHEMA = "migrate_test";

describe("migrations", () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;

  const tableExists = async (name: string) =>
    (await admin.query("SELECT to_regclass($1) AS t", [`${SCHEMA}.${name}`])).rows[0].t !== null;

  beforeAll(async () => {
    assertTestDatabase(TEST_DB_URL);
    admin = createPool(TEST_DB_URL);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    const url = new URL(TEST_DB_URL);
    url.searchParams.set("options", `-c search_path=${SCHEMA}`);
    pool = createPool(url.toString());
    dir = await mkdtemp(join(tmpdir(), "migrations-"));
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("applies pending files in order, once", async () => {
    await writeFile(join(dir, "002_second.sql"), "CREATE TABLE second (id int);");
    await writeFile(join(dir, "001_first.sql"), "CREATE TABLE first (id int);");
    await writeFile(join(dir, "notes.txt"), "not a migration");

    expect(await migrate(pool, dir)).toEqual(["001_first.sql", "002_second.sql"]);
    expect(await tableExists("first")).toBe(true);
    expect(await tableExists("second")).toBe(true);

    // Running again is a no-op.
    expect(await migrate(pool, dir)).toEqual([]);
  });

  it("rolls back a failing migration completely and reports which one failed", async () => {
    await writeFile(join(dir, "003_broken.sql"), "CREATE TABLE half_done (id int); THIS IS NOT SQL;");
    await expect(migrate(pool, dir)).rejects.toThrowError(/Migration 003_broken\.sql failed/);

    expect(await tableExists("half_done")).toBe(false);
    const { rows } = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["001_first.sql", "002_second.sql"]);
  });

  it("is safe when several instances start at the same time", async () => {
    await rm(join(dir, "003_broken.sql"));
    await writeFile(join(dir, "004_shared.sql"), "CREATE TABLE shared (id int);");
    const results = await Promise.all([migrate(pool, dir), migrate(pool, dir), migrate(pool, dir)]);
    // Exactly one of them did the work; none failed.
    expect(results.flat()).toEqual(["004_shared.sql"]);
  });

  it("ships the migrations the application needs", async () => {
    const files = await readdir(MIGRATIONS_DIR);
    expect(files).toContain("001_init.sql");
  });
});

describe("transactions", () => {
  it("rolls back everything when the callback throws", async () => {
    const pool = createPool(TEST_DB_URL);
    try {
      await pool.query("CREATE TEMP TABLE IF NOT EXISTS scratch (n int)").catch(() => undefined);
      await expect(
        withTransaction(pool, async (tx) => {
          await tx.query("INSERT INTO users (email, password_hash) VALUES ('rollback@example.com', 'x')");
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'rollback@example.com'");
      expect(rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
