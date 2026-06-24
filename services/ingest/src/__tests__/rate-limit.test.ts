import { describe, expect, it } from "vitest";
import { RateLimiter } from "../rate-limit.js";

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
