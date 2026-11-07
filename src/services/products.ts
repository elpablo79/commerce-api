import type { Pool } from "pg";
import { z } from "zod";
import type { AuthUser } from "../auth";
import { withTransaction } from "../db";
import { AppError, conflict, notFound, parse } from "../errors";
import type { Cache } from "../redis";
import { escapeLike, isUniqueViolation, isUuid } from "../util";

export const MAX_PRICE_CENTS = 1_000_000;
export const MAX_STOCK = 1_000_000;

export type ProductView = {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  inStock: boolean;
  /** Exact quantity: only visible to admins. */
  stock?: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProductPage = {
  data: ProductView[];
  pagination: { limit: number; offset: number; total: number };
};

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  description: string;
  price_cents: number;
  stock: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

const toView = (row: ProductRow, admin: boolean): ProductView => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  description: row.description,
  priceCents: row.price_cents,
  inStock: row.stock > 0,
  ...(admin ? { stock: row.stock } : {}),
  active: row.active,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const createSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, "SKU may only contain letters, numbers, dots, dashes and underscores"),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(""),
    priceCents: z.number().int().min(1).max(MAX_PRICE_CENTS),
    stock: z.number().int().min(0).max(MAX_STOCK).default(0),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000),
    priceCents: z.number().int().min(1).max(MAX_PRICE_CENTS),
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

const adjustSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-MAX_STOCK)
      .max(MAX_STOCK)
      .refine((v) => v !== 0, "delta cannot be zero"),
  })
  .strict();

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  includeInactive: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
});

const UPDATE_COLUMNS = {
  name: "name",
  description: "description",
  priceCents: "price_cents",
  active: "active",
} as const;

export function createProductService(deps: {
  pool: Pool;
  cache: Cache;
  cacheTtlSeconds: number;
}) {
  const { pool, cache, cacheTtlSeconds } = deps;
  const isAdmin = (viewer: AuthUser | null) => viewer?.role === "admin";

  async function list(viewer: AuthUser | null, rawQuery: unknown): Promise<ProductPage> {
    const q = parse(listSchema, rawQuery);
    const admin = isAdmin(viewer);

    // Only the public view is cached: admins always see live stock and inactive products.
    let cacheKey: string | null = null;
    if (!admin && cache.enabled) {
      const version = await cache.version("products");
      cacheKey = `cache:products:${version}:${JSON.stringify([q.search ?? null, q.limit, q.offset])}`;
      const hit = await cache.getJson<ProductPage>(cacheKey);
      if (hit) return hit;
    }

    const where: string[] = [];
    const params: unknown[] = [];
    if (!(admin && q.includeInactive)) where.push("active");
    if (q.search) {
      params.push(`%${escapeLike(q.search)}%`);
      where.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows, count] = await Promise.all([
      pool.query<ProductRow>(
        `SELECT * FROM products ${whereSql}
          ORDER BY created_at DESC, id
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, q.offset],
      ),
      pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM products ${whereSql}`, params),
    ]);

    const page: ProductPage = {
      data: rows.rows.map((r) => toView(r, admin)),
      pagination: { limit: q.limit, offset: q.offset, total: count.rows[0].n },
    };
    if (cacheKey) await cache.setJson(cacheKey, page, cacheTtlSeconds);
    return page;
  }

  async function get(viewer: AuthUser | null, id: string): Promise<ProductView> {
    if (!isUuid(id)) throw notFound("Product");
    const { rows } = await pool.query<ProductRow>("SELECT * FROM products WHERE id = $1", [id]);
    const row = rows[0];
    if (!row || (!row.active && !isAdmin(viewer))) throw notFound("Product");
    return toView(row, isAdmin(viewer));
  }

  async function create(input: unknown): Promise<ProductView> {
    const data = parse(createSchema, input);
    try {
      const row = await withTransaction(pool, async (tx) => {
        const res = await tx.query<ProductRow>(
          `INSERT INTO products (sku, name, description, price_cents, stock)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [data.sku, data.name, data.description, data.priceCents, data.stock],
        );
        if (data.stock > 0) {
          await tx.query(
            "INSERT INTO inventory_movements (product_id, delta, reason) VALUES ($1, $2, 'initial')",
            [res.rows[0].id, data.stock],
          );
        }
        return res.rows[0];
      });
      await cache.bump("products");
      return toView(row, true);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("sku_taken", "A product with this SKU already exists");
      throw err;
    }
  }

  async function update(id: string, input: unknown): Promise<ProductView> {
    if (!isUuid(id)) throw notFound("Product");
    const data = parse(updateSchema, input);
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
      const value = data[key as keyof typeof UPDATE_COLUMNS];
      if (value !== undefined) {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const { rows } = await pool.query<ProductRow>(
      `UPDATE products SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound("Product");
    await cache.bump("products");
    return toView(rows[0], true);
  }

  async function adjustInventory(id: string, input: unknown): Promise<ProductView> {
    if (!isUuid(id)) throw notFound("Product");
    const { delta } = parse(adjustSchema, input);
    const row = await withTransaction(pool, async (tx) => {
      const res = await tx.query<ProductRow>(
        `UPDATE products SET stock = stock + $2, updated_at = now()
          WHERE id = $1 AND stock + $2 >= 0 RETURNING *`,
        [id, delta],
      );
      if (!res.rows[0]) {
        const probe = await tx.query<{ stock: number }>("SELECT stock FROM products WHERE id = $1", [id]);
        if (!probe.rows[0]) throw notFound("Product");
        throw new AppError(409, "insufficient_stock", "Stock cannot go below zero", {
          available: probe.rows[0].stock,
        });
      }
      await tx.query(
        "INSERT INTO inventory_movements (product_id, delta, reason) VALUES ($1, $2, 'admin_adjustment')",
        [id, delta],
      );
      return res.rows[0];
    });
    await cache.bump("products");
    return toView(row, true);
  }

  return { list, get, create, update, adjustInventory };
}
