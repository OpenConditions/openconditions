import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * In-memory token-bucket rate limiter for the public emitter feeds. Ported from
 * the OpenMapX API limiter: each client key gets a bucket of `max` tokens that
 * refills linearly over `windowMs`; a request costs one token, and an empty
 * bucket yields HTTP 429 + `Retry-After`. Buckets live in this process only —
 * fine for a single ingest instance; a multi-replica deployment behind a shared
 * cache would swap the store, but the feeds are cheap reads and one instance is
 * the norm.
 */
interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterOptions {
  /** Bucket capacity = burst size + steady requests per window. */
  max: number;
  /** Window over which a full `max` tokens regenerate, in milliseconds. */
  windowMs: number;
  /** Client key; defaults to forwarded IP + TCP peer (XFF-rotation resistant). */
  keyFn?: (req: FastifyRequest) => string;
  /** Injectable clock — defaults to Date.now (tests pass a controllable one). */
  now?: () => number;
}

/**
 * Composite key of the proxy-derived IP and the real TCP peer. Behind Traefik
 * `req.ip` is the forwarded client; the peer pins direct-exposure clients so a
 * spoofed X-Forwarded-For can't mint a fresh bucket per request.
 */
function defaultKeyFn(req: FastifyRequest): string {
  const peer = req.socket?.remoteAddress ?? "unknown";
  return `${req.ip}|${peer}`;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly keyFn: (req: FastifyRequest) => string;
  private readonly now: () => number;
  private readonly cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(opts: RateLimiterOptions) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.keyFn = opts.keyFn ?? defaultKeyFn;
    this.now = opts.now ?? Date.now;
    // Only sweep stale buckets under the real clock; tests inject `now` and
    // drive time manually, so they neither need nor want a background timer.
    if (opts.now === undefined) {
      this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
      this.cleanupTimer.unref?.();
    }
  }

  /** Token-bucket decision for one key. */
  consume(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.max, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(this.max, bucket.tokens + (elapsed / this.windowMs) * this.max);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfterSec = Math.ceil((((1 - bucket.tokens) / this.max) * this.windowMs) / 1000);
      return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
    }
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Fastify `onRequest`/`preHandler` hook applying the limit, keyed per client. */
  hook() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
      const { allowed, retryAfterSec } = this.consume(this.keyFn(req));
      if (!allowed) {
        reply.header("Retry-After", String(retryAfterSec));
        return reply.status(429).send({ error: "Too many requests", retryAfter: retryAfterSec });
      }
      return undefined;
    };
  }

  private cleanup(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.windowMs * 2) this.buckets.delete(key);
    }
  }

  /** Stops the cleanup timer + drops all buckets (for graceful shutdown/tests). */
  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}
