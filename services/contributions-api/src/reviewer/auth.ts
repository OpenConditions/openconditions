/**
 * Reviewer authentication — the operator bearer token that gates the post-hoc
 * moderation surface. Reviewers are ACCOUNTABLE OPERATORS, not pseudonymous
 * device keys: they present a shared operator credential, never a reporting
 * grant. The token is compared in constant time (both sides hashed to a fixed
 * 32-byte digest first, so neither the comparison nor a length check leaks how
 * much of a guess was right).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

/**
 * Resolves the reviewer bearer token from the environment, mirroring the grant
 * secret's fail-closed contract:
 *
 * - `OPENCONDITIONS_REVIEWER_TOKEN` set (non-empty): its value.
 * - Unset in production (`NODE_ENV=production`): THROWS — the moderation surface
 *   must not come up with an ephemeral token an operator cannot know.
 * - Unset elsewhere: a random ephemeral token is generated and `warn` is called
 *   loudly (the token dies on restart — an acceptable dev default). The token
 *   VALUE is never logged.
 */
export function resolveReviewerToken(
  env: Record<string, string | undefined>,
  warn: (msg: string) => void
): string {
  const configured = env["OPENCONDITIONS_REVIEWER_TOKEN"];
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  if (env["NODE_ENV"] === "production") {
    throw new Error(
      "OPENCONDITIONS_REVIEWER_TOKEN is required in production: refusing to start the reviewer surface with an ephemeral token (fail closed)"
    );
  }
  const ephemeral = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url"
  );
  warn(
    "OPENCONDITIONS_REVIEWER_TOKEN is not set; generated an EPHEMERAL reviewer token — it dies on restart and no operator can know it. Set the env var for anything beyond local development."
  );
  return ephemeral;
}

/** Constant-time string equality; hashing first keeps it length-safe. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Extract a `Bearer <token>` credential from the Authorization header. Returns
 * the empty string when the header is missing or not a bearer scheme, so the
 * caller always feeds a string into the constant-time compare (never short-
 * circuiting on absence).
 */
function bearerToken(req: FastifyRequest): string {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return "";
  }
  return header.slice("Bearer ".length);
}

/**
 * Build the `requireReviewer` preHandler bound to a resolved operator token. A
 * missing or wrong bearer → 401; a correct bearer passes through. Attached to
 * every reviewer route.
 */
export function makeRequireReviewer(token: string): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const provided = bearerToken(req);
    if (provided === "" || !constantTimeEquals(provided, token)) {
      return reply.status(401).send({ error: "reviewer authorization required" });
    }
  };
}
