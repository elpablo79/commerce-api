import bcrypt from "bcryptjs";
import type { Pool } from "pg";
import { z } from "zod";
import { TOKEN_TTL_SECONDS, type Role, type TokenService } from "../auth";
import { conflict, parse, unauthorized } from "../errors";
import { isUniqueViolation } from "../util";

export type UserView = { id: string; email: string; role: Role; createdAt: string };

type UserRow = { id: string; email: string; password_hash: string; role: Role; created_at: Date };

const toView = (row: UserRow): UserView => ({
  id: row.id,
  email: row.email,
  role: row.role,
  createdAt: row.created_at.toISOString(),
});

// bcrypt only looks at the first 72 bytes, so longer passwords would be silently truncated.
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((v) => Buffer.byteLength(v) <= 72, "Password must be at most 72 bytes");

// `strict` rejects unknown keys, so nobody can sneak in `role: "admin"` at registration.
const registerSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(254), password })
  .strict();

const loginSchema = z
  .object({ email: z.string().trim().toLowerCase().max(254), password: z.string().min(1).max(200) })
  .strict();

export function createUserService(deps: { pool: Pool; tokens: TokenService; bcryptRounds: number }) {
  const { pool, tokens, bcryptRounds } = deps;
  // Compared against when the email is unknown so response time does not reveal valid accounts.
  const dummyHash = bcrypt.hashSync("not-a-real-password", bcryptRounds);

  async function session(row: UserRow) {
    const token = await tokens.sign({ id: row.id, email: row.email, role: row.role });
    return { user: toView(row), token, expiresIn: TOKEN_TTL_SECONDS };
  }

  return {
    async register(input: unknown) {
      const { email, password } = parse(registerSchema, input);
      const hash = await bcrypt.hash(password, bcryptRounds);
      try {
        const { rows } = await pool.query<UserRow>(
          "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *",
          [email, hash],
        );
        return await session(rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw conflict("email_taken", "An account with this email already exists");
        }
        throw err;
      }
    },

    async login(input: unknown) {
      const { email, password } = parse(loginSchema, input);
      const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
      const user = rows[0];
      const valid = await bcrypt.compare(password, user?.password_hash ?? dummyHash);
      if (!user || !valid) throw unauthorized("Invalid email or password");
      return session(user);
    },

    async me(userId: string): Promise<UserView> {
      const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
      if (!rows[0]) throw unauthorized();
      return toView(rows[0]);
    },
  };
}
