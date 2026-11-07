import type { z } from "zod";

/** An error that is safe to show to API clients. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = (message = "Authentication required") =>
  new AppError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do this") =>
  new AppError(403, "forbidden", message);
export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/** Validates untrusted input and turns zod failures into a 400 with per-field details. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      "validation_error",
      "The request is not valid",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
