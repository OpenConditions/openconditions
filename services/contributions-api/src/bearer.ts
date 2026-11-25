/**
 * Bearer credentials of the operator surfaces (the reviewer token, the relay
 * token): read from the Authorization header and compared in constant time.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Constant-time string equality. Both sides are hashed to a fixed 32-byte
 * digest first, so neither the comparison nor a length check leaks how much
 * of a guess was right.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The `Bearer <token>` credential of the Authorization header; the empty
 * string when the header is missing or not a bearer scheme, so a caller
 * always feeds a string into the constant-time compare.
 */
export function bearerToken(req: FastifyRequest): string {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length);
}
