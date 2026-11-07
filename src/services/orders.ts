import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { AuthUser } from "../auth";
import { withTransaction } from "../db";
import { assertTransition, canTransition, ORDER_STATUSES, type OrderStatus } from "../domain/order-state";
import { AppError, conflict, notFound, parse } from "../errors";
import { errMeta, type Logger } from "../logger";
import type { PaymentEvent, PaymentProvider } from "../payments/provider";
import { isUuid } from "../util";

// With a price cap of 1,000,000 cents, 100 units and 20 lines an order total stays below
// 2,000,000,000, which fits a Postgres integer.
export const MAX_LINES = 20;
export const MAX_QUANTITY = 100;

export type OrderView = {
  id: string;
  userId: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  items: { productId: string; sku: string; name: string; unitPriceCents: number; quantity: number }[];
  payment: { provider: string; reference: string } | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
};

export type OrderPage = {
  data: OrderView[];
  pagination: { limit: number; offset: number; total: number };
};

export type PaymentEventResult = "paid" | "duplicate" | "already_paid" | "recorded" | "ignored" | "late_payment";

type OrderRow = {
  id: string;
  user_id: string;
  status: OrderStatus;
  total_cents: number;
  currency: string;
  payment_provider: string | null;
  payment_reference: string | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
};

type ItemRow = {
  order_id: string;
  product_id: string;
  sku: string;
  name: string;
  unit_price_cents: number;
  quantity: number;
};

type PaymentRef = { provider: string | null; reference: string | null };

const createSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(MAX_QUANTITY),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_LINES),
  })
  .strict();

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(ORDER_STATUSES).optional(),
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Merges repeated products and sorts them, so every transaction locks rows in the same order. */
function mergeLines(items: { productId: string; quantity: number }[]): [string, number][] {
  const merged = new Map<string, number>();
  for (const item of items) {
    const id = item.productId.toLowerCase();
    merged.set(id, (merged.get(id) ?? 0) + item.quantity);
  }
  for (const quantity of merged.values()) {
    if (quantity > MAX_QUANTITY) {
      throw new AppError(400, "validation_error", `At most ${MAX_QUANTITY} units of a product per order`);
    }
  }
  return [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function createOrderService(deps: {
  pool: Pool;
  payments: PaymentProvider;
  logger: Logger;
  orderExpiryMinutes: number;
}) {
  const { pool, payments, logger, orderExpiryMinutes } = deps;

  async function hydrate(rows: OrderRow[]): Promise<OrderView[]> {
    if (rows.length === 0) return [];
    const items = await pool.query<ItemRow>(
      `SELECT order_id, product_id, sku, name, unit_price_cents, quantity
         FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY name, product_id`,
      [rows.map((r) => r.id)],
    );
    const byOrder = new Map<string, OrderView["items"]>();
    for (const i of items.rows) {
      const list = byOrder.get(i.order_id) ?? [];
      list.push({
        productId: i.product_id,
        sku: i.sku,
        name: i.name,
        unitPriceCents: i.unit_price_cents,
        quantity: i.quantity,
      });
      byOrder.set(i.order_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      status: r.status,
      totalCents: r.total_cents,
      currency: r.currency,
      items: byOrder.get(r.id) ?? [],
      payment:
        r.payment_provider && r.payment_reference
          ? { provider: r.payment_provider, reference: r.payment_reference }
          : null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      paidAt: iso(r.paid_at),
      shippedAt: iso(r.shipped_at),
      deliveredAt: iso(r.delivered_at),
      cancelledAt: iso(r.cancelled_at),
    }));
  }

  async function load(id: string): Promise<OrderView> {
    if (!isUuid(id)) throw notFound("Order");
    const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("Order");
    return (await hydrate(rows))[0];
  }

  /**
   * Cancels a pending order and puts its stock back. Must run inside a transaction: the row lock
   * on the order makes a concurrent payment or cancellation wait, so only one of them wins.
   */
  async function cancelInTx(
    tx: PoolClient,
    orderId: string,
    actor: AuthUser | "system",
  ): Promise<PaymentRef> {
    const res = await tx.query<{
      user_id: string;
      status: OrderStatus;
      payment_provider: string | null;
      payment_reference: string | null;
    }>(
      "SELECT user_id, status, payment_provider, payment_reference FROM orders WHERE id = $1 FOR UPDATE",
      [orderId],
    );
    const order = res.rows[0];
    // Someone else's order looks exactly like a missing one.
    if (!order || (actor !== "system" && actor.role !== "admin" && order.user_id !== actor.id)) {
      throw notFound("Order");
    }
    if (!canTransition(order.status, "cancelled")) {
      throw conflict("order_not_cancellable", "Only pending orders can be cancelled");
    }

    const lines = await tx.query<{ product_id: string; quantity: number }>(
      "SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id",
      [orderId],
    );
    for (const line of lines.rows) {
      await tx.query("UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1", [
        line.product_id,
        line.quantity,
      ]);
    }
    await tx.query(
      `INSERT INTO inventory_movements (product_id, delta, reason, order_id)
       SELECT t.product_id, t.quantity, 'order_cancelled', $3
         FROM unnest($1::uuid[], $2::int[]) AS t(product_id, quantity)`,
      [lines.rows.map((l) => l.product_id), lines.rows.map((l) => l.quantity), orderId],
    );
    await tx.query(
      "UPDATE orders SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1",
      [orderId],
    );
    return { provider: order.payment_provider, reference: order.payment_reference };
  }

  /** After a cancellation, stop the provider from accepting a payment for it. Never throws. */
  async function releasePayment(ref: PaymentRef): Promise<void> {
    if (!ref.reference || ref.provider !== payments.name) return;
    try {
      await payments.cancelPayment(ref.reference);
    } catch (err) {
      logger.warn("Could not cancel the payment at the provider", {
        reference: ref.reference,
        err: errMeta(err),
      });
    }
  }

  async function create(user: AuthUser, input: unknown) {
    const { items } = parse(createSchema, input);
    const wanted = mergeLines(items);

    const created = await withTransaction(pool, async (tx) => {
      const lines: { productId: string; sku: string; name: string; unitPrice: number; quantity: number }[] = [];

      for (const [productId, quantity] of wanted) {
        // Check and decrement in one statement: two buyers can never take the same last unit.
        const res = await tx.query<{ sku: string; name: string; price_cents: number }>(
          `UPDATE products SET stock = stock - $2, updated_at = now()
            WHERE id = $1 AND active AND stock >= $2
            RETURNING sku, name, price_cents`,
          [productId, quantity],
        );
        const row = res.rows[0];
        if (!row) {
          const probe = await tx.query<{ stock: number; active: boolean }>(
            "SELECT stock, active FROM products WHERE id = $1",
            [productId],
          );
          const product = probe.rows[0];
          if (!product || !product.active) {
            throw new AppError(404, "product_not_found", `Product ${productId} is not available`);
          }
          throw conflict("insufficient_stock", `Not enough stock for product ${productId}`, {
            productId,
            available: product.stock,
          });
        }
        lines.push({ productId, sku: row.sku, name: row.name, unitPrice: row.price_cents, quantity });
      }

      const total = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
      const order = await tx.query<{ id: string }>(
        "INSERT INTO orders (user_id, status, total_cents) VALUES ($1, 'pending', $2) RETURNING id",
        [user.id, total],
      );
      const orderId = order.rows[0].id;

      await tx.query(
        `INSERT INTO order_items (order_id, product_id, sku, name, unit_price_cents, quantity)
         SELECT $1, t.product_id, t.sku, t.name, t.price, t.quantity
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::int[], $6::int[])
                AS t(product_id, sku, name, price, quantity)`,
        [
          orderId,
          lines.map((l) => l.productId),
          lines.map((l) => l.sku),
          lines.map((l) => l.name),
          lines.map((l) => l.unitPrice),
          lines.map((l) => l.quantity),
        ],
      );
      await tx.query(
        `INSERT INTO inventory_movements (product_id, delta, reason, order_id)
         SELECT t.product_id, -t.quantity, 'order_reserved', $1
           FROM unnest($2::uuid[], $3::int[]) AS t(product_id, quantity)`,
        [orderId, lines.map((l) => l.productId), lines.map((l) => l.quantity)],
      );
      return { id: orderId, total };
    });

    let payment: { reference: string; clientSecret: string };
    try {
      payment = await payments.createPayment({
        orderId: created.id,
        amountCents: created.total,
        currency: "usd",
      });
    } catch (err) {
      logger.error("Could not start the payment, cancelling the order", {
        orderId: created.id,
        err: errMeta(err),
      });
      await withTransaction(pool, (tx) => cancelInTx(tx, created.id, "system"));
      throw new AppError(502, "payment_unavailable", "The payment could not be started, please try again");
    }

    await pool.query(
      "UPDATE orders SET payment_provider = $2, payment_reference = $3, updated_at = now() WHERE id = $1",
      [created.id, payments.name, payment.reference],
    );
    return { order: await load(created.id), clientSecret: payment.clientSecret };
  }

  async function get(user: AuthUser, id: string): Promise<OrderView> {
    const order = await load(id);
    if (user.role !== "admin" && order.userId !== user.id) throw notFound("Order");
    return order;
  }

  async function list(user: AuthUser, rawQuery: unknown): Promise<OrderPage> {
    const q = parse(listSchema, rawQuery);
    const where: string[] = [];
    const params: unknown[] = [];
    if (user.role !== "admin") {
      params.push(user.id);
      where.push(`user_id = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows, count] = await Promise.all([
      pool.query<OrderRow>(
        `SELECT * FROM orders ${whereSql}
          ORDER BY created_at DESC, id
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, q.offset],
      ),
      pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders ${whereSql}`, params),
    ]);
    return {
      data: await hydrate(rows.rows),
      pagination: { limit: q.limit, offset: q.offset, total: count.rows[0].n },
    };
  }

  async function cancel(user: AuthUser, id: string): Promise<OrderView> {
    if (!isUuid(id)) throw notFound("Order");
    const ref = await withTransaction(pool, (tx) => cancelInTx(tx, id, user));
    await releasePayment(ref);
    return load(id);
  }

  async function advance(id: string, to: "shipped" | "delivered"): Promise<OrderView> {
    if (!isUuid(id)) throw notFound("Order");
    await withTransaction(pool, async (tx) => {
      const res = await tx.query<{ status: OrderStatus }>(
        "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!res.rows[0]) throw notFound("Order");
      assertTransition(res.rows[0].status, to);
      const column = to === "shipped" ? "shipped_at" : "delivered_at";
      await tx.query(`UPDATE orders SET status = $2, ${column} = now(), updated_at = now() WHERE id = $1`, [
        id,
        to,
      ]);
    });
    return load(id);
  }

  /** Applies a verified webhook event. Safe to call many times with the same event. */
  async function applyPaymentEvent(event: PaymentEvent): Promise<PaymentEventResult> {
    return withTransaction(pool, async (tx): Promise<PaymentEventResult> => {
      const seen = await tx.query(
        "INSERT INTO payment_events (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [event.provider, event.id],
      );
      if (seen.rowCount === 0) return "duplicate";

      const res = await tx.query<{ id: string; status: OrderStatus }>(
        "SELECT id, status FROM orders WHERE payment_provider = $1 AND payment_reference = $2 FOR UPDATE",
        [event.provider, event.reference],
      );
      const order = res.rows[0];
      if (!order) {
        logger.warn("Payment event for an unknown payment", { reference: event.reference });
        return "ignored";
      }
      if (event.type === "payment_failed") return "recorded";

      if (order.status === "pending") {
        await tx.query(
          "UPDATE orders SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1",
          [order.id],
        );
        return "paid";
      }
      if (order.status === "cancelled") {
        logger.error("Payment received for a cancelled order: a manual refund is required", {
          orderId: order.id,
          reference: event.reference,
        });
        return "late_payment";
      }
      return "already_paid";
    });
  }

  /** Cancels pending orders nobody paid for, returning their stock to the shelf. */
  async function expireStale(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - orderExpiryMinutes * 60_000);
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM orders WHERE status = 'pending' AND created_at < $1 ORDER BY created_at LIMIT 100",
      [cutoff],
    );
    let expired = 0;
    for (const { id } of rows) {
      try {
        const ref = await withTransaction(pool, (tx) => cancelInTx(tx, id, "system"));
        await releasePayment(ref);
        expired++;
      } catch (err) {
        // Paid or cancelled in the meantime: nothing to do.
        if (err instanceof AppError && err.code === "order_not_cancellable") continue;
        logger.error("Could not expire an order", { orderId: id, err: errMeta(err) });
      }
    }
    return expired;
  }

  return {
    create,
    get,
    list,
    cancel,
    ship: (id: string) => advance(id, "shipped"),
    deliver: (id: string) => advance(id, "delivered"),
    applyPaymentEvent,
    expireStale,
  };
}
