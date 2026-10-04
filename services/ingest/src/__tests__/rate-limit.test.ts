import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerScope } from "../api/scope.js";
import { RateLimiter, registerRateLimit } from "../rate-limit.js";

/** A controllable clock so the token-bucket math is tested without real time. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter.consume", () => {
  it("allows up to `max` requests then denies", () => {
    const c = clock();
    const rl = new RateLimiter({ max: 3, windowMs: 1000, now: c.now });
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(true);
    const denied = rl.consume("a");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("keeps separate buckets per key", () => {
    const c = clock();
    const rl = new RateLimiter({ max: 1, windowMs: 1000, now: c.now });
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(false);
    // A different key is unaffected.
    expect(rl.consume("b").allowed).toBe(true);
  });

  it("refills tokens as the window elapses", () => {
    const c = clock();
    const rl = new RateLimiter({ max: 2, windowMs: 1000, now: c.now });
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(false);
    // Half a window refills one token (max=2 over 1000ms).
    c.advance(500);
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(false);
    // A full further window tops back up to the cap (no over-refill).
    c.advance(10_000);
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(false);
  });

  it("reports a Retry-After that shrinks as tokens regenerate", () => {
    const c = clock();
    const rl = new RateLimiter({ max: 1, windowMs: 2000, now: c.now });
    expect(rl.consume("a").allowed).toBe(true);
    const first = rl.consume("a");
    expect(first.allowed).toBe(false);
    c.advance(1000);
    const later = rl.consume("a");
    expect(later.allowed).toBe(false);
    expect(later.retryAfterSec).toBeLessThanOrEqual(first.retryAfterSec);
  });
});

describe("registerRateLimit", () => {
  const TOKEN = "operator-token-of-the-limiter-suite-0123456789";

  /** A server with the scope hook, a limiter of one request per minute, and one route. */
  async function server() {
    const app = Fastify();
    registerScope(app, TOKEN);
    registerRateLimit(app, new RateLimiter({ max: 1, windowMs: 60_000, now: () => 0 }));
    app.get("/situations", async () => ({ records: [] }));
    app.get("/status", async () => ({ status: "ok" }));
    await app.ready();
    const get = (
      url: string,
      headers: Record<string, string> = {},
      remoteAddress = "203.0.113.9",
    ) => app.inject({ method: "GET", url, headers, remoteAddress });
    return { app, get };
  }

  it("operator requests skip the rate limiter", async () => {
    const { app, get } = await server();
    for (let i = 0; i < 3; i++) {
      const res = await get("/situations", { authorization: `Bearer ${TOKEN}` });
      expect(res.statusCode).toBe(200);
    }
    expect((await get("/situations")).statusCode).toBe(200);
    expect((await get("/situations")).statusCode).toBe(429);
    await app.close();
  });

  it("counts a rejected token against the caller's bucket, so guessing is throttled", async () => {
    const { app, get } = await server();
    expect((await get("/situations", { authorization: "Bearer nope" })).statusCode).toBe(401);
    expect((await get("/situations", { authorization: "Bearer nope2" })).statusCode).toBe(429);
    expect((await get("/situations")).statusCode).toBe(429);
    await app.close();
  });

  it("reads a non-Bearer Authorization header in the public scope, and counts it", async () => {
    const { app, get } = await server();
    expect((await get("/situations", { authorization: "Basic dXNlcjpwYXNz" })).statusCode).toBe(
      200,
    );
    expect((await get("/situations", { authorization: `Bearerxyz${TOKEN}` })).statusCode).toBe(429);
    await app.close();
  });

  it("exempts the health probe and loopback peers", async () => {
    const { app, get } = await server();
    for (let i = 0; i < 3; i++) {
      expect((await get("/status")).statusCode).toBe(200);
      expect((await get("/situations", {}, "127.0.0.1")).statusCode).toBe(200);
    }
    await app.close();
  });
});

describe("RateLimiter.hook", () => {
  it("sends 429 + Retry-After once the bucket is empty", async () => {
    const c = clock();
    const rl = new RateLimiter({ max: 1, windowMs: 1000, now: c.now, keyFn: () => "fixed" });
    const hook = rl.hook();

    const headers: Record<string, string> = {};
    let statusCode = 200;
    let body: unknown;
    const makeReply = () => ({
      header(k: string, v: string) {
        headers[k] = v;
        return this;
      },
      status(code: number) {
        statusCode = code;
        return this;
      },
      send(payload: unknown) {
        body = payload;
        return this;
      },
    });
    const req = { ip: "9.9.9.9", socket: { remoteAddress: "9.9.9.9" } } as never;

    await hook(req, makeReply() as never);
    expect(statusCode).toBe(200); // first request passes (hook returns undefined)

    await hook(req, makeReply() as never);
    expect(statusCode).toBe(429);
    expect(headers["Retry-After"]).toBeDefined();
    expect((body as { error: string }).error).toMatch(/too many/i);
  });
});
