import express, { Router } from "express";
import type { Request, RequestHandler } from "express";
import type { Container } from "../container";
import { requireAdmin, requireAuth } from "./middleware";
import "./types";

// Express types route params as `string | string[]`; a non-UUID value ends up as a plain 404 downstream.
const idOf = (req: Request) => String(req.params.id);

export function authRoutes(container: Container, limiter: RequestHandler) {
  const r = Router();
  r.post("/register", limiter, async (req, res) => {
    res.status(201).json(await container.users.register(req.body));
  });
  r.post("/login", limiter, async (req, res) => {
    res.json(await container.users.login(req.body));
  });
  r.get("/me", requireAuth, async (req, res) => {
    res.json(await container.users.me(req.user!.id));
  });
  return r;
}

export function productRoutes({ products }: Container) {
  const r = Router();
  r.get("/", async (req, res) => {
    const { q, limit, offset, includeInactive } = req.query;
    res.json(await products.list(req.user, { search: q, limit, offset, includeInactive }));
  });
  r.get("/:id", async (req, res) => {
    res.json(await products.get(req.user, idOf(req)));
  });
  r.post("/", requireAdmin, async (req, res) => {
    res.status(201).json(await products.create(req.body));
  });
  r.patch("/:id", requireAdmin, async (req, res) => {
    res.json(await products.update(idOf(req), req.body));
  });
  r.post("/:id/inventory", requireAdmin, async (req, res) => {
    res.json(await products.adjustInventory(idOf(req), req.body));
  });
  return r;
}

export function orderRoutes({ orders }: Container) {
  const r = Router();
  r.use(requireAuth);
  r.post("/", async (req, res) => {
    res.status(201).json(await orders.create(req.user!, req.body));
  });
  r.get("/", async (req, res) => {
    const { limit, offset, status } = req.query;
    res.json(await orders.list(req.user!, { limit, offset, status }));
  });
  r.get("/:id", async (req, res) => {
    res.json(await orders.get(req.user!, idOf(req)));
  });
  r.post("/:id/cancel", async (req, res) => {
    res.json(await orders.cancel(req.user!, idOf(req)));
  });
  r.post("/:id/ship", requireAdmin, async (req, res) => {
    res.json(await orders.ship(idOf(req)));
  });
  r.post("/:id/deliver", requireAdmin, async (req, res) => {
    res.json(await orders.deliver(idOf(req)));
  });
  return r;
}

export function webhookRoutes({ orders, payments }: Container) {
  const r = Router();
  // The signature is computed over the exact bytes received, so the body must stay raw here.
  r.post("/payments", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const event = payments.parseWebhook(raw, req.header(payments.signatureHeader));
    if (!event) {
      res.json({ received: true, result: "ignored" });
      return;
    }
    res.json({ received: true, result: await orders.applyPaymentEvent(event) });
  });
  return r;
}
