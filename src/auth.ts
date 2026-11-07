import { jwtVerify, SignJWT } from "jose";

export type Role = "customer" | "admin";
export type AuthUser = { id: string; email: string; role: Role };

export const TOKEN_TTL_SECONDS = 60 * 60;
const ISSUER = "commerce-api";

export function createTokenService(secret: string) {
  const key = new TextEncoder().encode(secret);

  return {
    async sign(user: AuthUser): Promise<string> {
      return new SignJWT({ email: user.email, role: user.role })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.id)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
        .sign(key);
    },

    /** Returns the user for a valid token, or null for anything else (never throws). */
    async verify(token: string | null | undefined): Promise<AuthUser | null> {
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer: ISSUER });
        if (
          typeof payload.sub !== "string" ||
          typeof payload.email !== "string" ||
          (payload.role !== "customer" && payload.role !== "admin")
        ) {
          return null;
        }
        return { id: payload.sub, email: payload.email, role: payload.role };
      } catch {
        return null;
      }
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;

export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer (\S+)$/i.exec(header ?? "");
  return match ? match[1] : null;
}
