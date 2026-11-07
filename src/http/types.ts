import type { AuthUser } from "../auth";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware; null for anonymous requests. */
      user: AuthUser | null;
    }
  }
}

export {};
