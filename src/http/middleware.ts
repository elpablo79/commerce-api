import type { ErrorRequestHandler, RequestHandler } from "express";
import { bearerToken, type TokenService } from "../auth";
import { AppError, forbidden, unauthorized } from "../errors";
import { errMeta, type Logger } from "../logger";
import "./types";

export const authenticate = (tokens: TokenService): RequestHandler =>
  async (req, _res, next) => {
    req.user = await tokens.verify(bearerToken(req.header("authorization")));
    next();
  };

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) throw unauthorized();
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) throw unauthorized();
  if (req.user.role !== "admin") throw forbidden();
  next();
};

export const requestLogger = (logger: Logger): RequestHandler => (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    logger.info("request", {
      method: req.method,
      // The query string is left out on purpose: it can contain search terms or other personal data.
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
    });
  });
  next();
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
};

export const errorHandler = (logger: Logger): ErrorRequestHandler => (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }
  // Errors raised by the body parser.
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "invalid_json", message: "The request body is not valid JSON" } });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: { code: "payload_too_large", message: "The request body is too large" } });
    return;
  }

  logger.error("Unhandled error", { path: req.originalUrl.split("?")[0], err: errMeta(err) });
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
};
