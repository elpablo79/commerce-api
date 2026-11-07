import request from "supertest";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, createUser, resetDb, type TestContext } from "./helpers";

describe("authentication", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetDb(ctx));

  const register = (body: unknown) => request(ctx.app).post("/auth/register").send(body as object);

  it("registers a customer and returns a token that works", async () => {
    const res = await register({ email: "  Ada@Example.com ", password: "correct-horse" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "ada@example.com", role: "customer" });
    expect(res.body.expiresIn).toBe(3600);
    expect(res.body.user).not.toHaveProperty("password_hash");

    const me = await request(ctx.app).get("/auth/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("ada@example.com");
  });

  it("never stores the password in clear text", async () => {
    await register({ email: "ada@example.com", password: "correct-horse" });
    const { rows } = await ctx.pool.query("SELECT password_hash FROM users");
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].password_hash).not.toContain("correct-horse");
  });

  it("rejects a duplicate email, ignoring case", async () => {
    await register({ email: "ada@example.com", password: "correct-horse" });
    const res = await register({ email: "ADA@example.com", password: "another-pass" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("validates email and password", async () => {
    expect((await register({ email: "not-an-email", password: "correct-horse" })).status).toBe(400);
    expect((await register({ email: "a@example.com", password: "short" })).status).toBe(400);
    expect((await register({ email: "a@example.com", password: "é".repeat(40) })).status).toBe(400);
    const missing = await request(ctx.app).post("/auth/register");
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("validation_error");
  });

  it("does not let a client choose its own role", async () => {
    const res = await register({ email: "eve@example.com", password: "correct-horse", role: "admin" });
    expect(res.status).toBe(400);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM users");
    expect(rows[0].n).toBe(0);
  });

  it("logs in with the right password only", async () => {
    await register({ email: "ada@example.com", password: "correct-horse" });
    const ok = await request(ctx.app).post("/auth/login").send({ email: "ADA@example.com", password: "correct-horse" });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String));

    const wrong = await request(ctx.app).post("/auth/login").send({ email: "ada@example.com", password: "wrong-pass" });
    const unknown = await request(ctx.app).post("/auth/login").send({ email: "nobody@example.com", password: "wrong-pass" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // The two failures must be indistinguishable.
    expect(unknown.body).toEqual(wrong.body);
  });

  it("rejects missing, malformed, forged and expired tokens", async () => {
    const user = await createUser(ctx);
    const get = (auth?: string) => {
      const req = request(ctx.app).get("/auth/me");
      return auth ? req.set("Authorization", auth) : req;
    };
    expect((await get()).status).toBe(401);
    expect((await get("Bearer not-a-token")).status).toBe(401);
    expect((await get(`Token ${user.token}`)).status).toBe(401);
    expect((await get(user.auth)).status).toBe(200);

    const key = (secret: string) => new TextEncoder().encode(secret);
    const claims = { email: user.email, role: "admin" };
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("commerce-api")
      .setExpirationTime("1h")
      .sign(key("a-completely-different-secret-with-32-chars!!"));
    expect((await get(`Bearer ${forged}`)).status).toBe(401);

    const expired = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("commerce-api")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key(ctx.config.jwtSecret));
    expect((await get(`Bearer ${expired}`)).status).toBe(401);

    const wrongIssuer = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("someone-else")
      .setExpirationTime("1h")
      .sign(key(ctx.config.jwtSecret));
    expect((await get(`Bearer ${wrongIssuer}`)).status).toBe(401);

    const badRole = await new SignJWT({ email: user.email, role: "superuser" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("commerce-api")
      .setExpirationTime("1h")
      .sign(key(ctx.config.jwtSecret));
    expect((await get(`Bearer ${badRole}`)).status).toBe(401);
  });

  it("rejects a valid token whose user no longer exists", async () => {
    const user = await createUser(ctx);
    await ctx.pool.query("DELETE FROM users WHERE id = $1", [user.id]);
    const res = await request(ctx.app).get("/auth/me").set("Authorization", user.auth);
    expect(res.status).toBe(401);
  });
});
