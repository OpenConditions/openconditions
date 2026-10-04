import { createHash, timingSafeEqual } from "node:crypto";
import type { Scope } from "@openconditions/core";
import { strictCredential } from "@openconditions/ingest-framework";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Who the request reads for; see `registerScope`. */
    scope: Scope;
  }
}

/** The shortest operator token boot accepts. */
export const MIN_OPERATOR_TOKEN_LENGTH = 32;

/**
 * The operator token, `OPENCONDITIONS_OPERATOR_TOKEN` (else the file
 * `OPENCONDITIONS_OPERATOR_TOKEN_FILE` names) trimmed; undefined when neither
 * is set. A token file that is set but unreadable or empty fails boot rather
 * than dropping the instance to public scope unnoticed, and a token shorter
 * than `MIN_OPERATOR_TOKEN_LENGTH` fails boot rather than guarding restricted
 * sources with a guessable secret.
 */
export function operatorTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = strictCredential(env, "OPENCONDITIONS_OPERATOR_TOKEN");
  if (!token) return undefined;
  if (token.length < MIN_OPERATOR_TOKEN_LENGTH) {
    throw new Error(
      `OPENCONDITIONS_OPERATOR_TOKEN must be at least ${MIN_OPERATOR_TOKEN_LENGTH} characters`,
    );
  }
  return token;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

const BEARER = /^Bearer(?:\s+(.*))?$/i;

/** `vary` with `field` added, unless it already names it or `*`. */
function varyWith(vary: unknown, field: string): string {
  const current = Array.isArray(vary) ? vary.join(", ") : typeof vary === "string" ? vary : "";
  const fields = current
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  if (fields.some((f) => f === "*" || f.toLowerCase() === field.toLowerCase())) return current;
  return [...fields, field].join(", ");
}

/**
 * Decorates every request with its `scope`: `operator` for
 * `Authorization: Bearer <token>`, `public` without a bearer header or with
 * another scheme. A bearer header with any other value is answered 401. The
 * comparison runs over fixed-length digests in constant time.
 *
 * While no token is configured there is no operator scope: every request,
 * a bearer one included, reads in public scope, so a client set up with a
 * token before the instance degrades to the public data instead of failing
 * every read. Registration warns once that operator scope is disabled.
 *
 * Register it before the rate limiter: its `onRequest` hook decides the
 * scope the limiter reads. A rejected token reads as public there, so it
 * costs the caller a token of its bucket; the 401 is sent after the limiter
 * has counted it, which throttles token guessing.
 *
 * Every response varies on `Authorization`, and an operator response is
 * `private, no-store`: a shared cache must never hand what the operator read
 * to anyone else.
 */
export function registerScope(app: FastifyInstance, token: string | undefined): void {
  const expected = token === undefined ? undefined : digest(token);
  if (expected === undefined) {
    app.log.warn("operator scope disabled: restricted sources are not served");
  }
  const rejected = new WeakSet<FastifyRequest>();
  app.decorateRequest("scope", "public");
  app.addHook("onRequest", async (req) => {
    req.scope = "public";
    if (expected === undefined) return;
    const header = req.headers.authorization;
    if (header === undefined) return;
    const bearer = BEARER.exec(header.trim());
    if (bearer === null) return;
    const presented = (bearer[1] ?? "").trim();
    if (!timingSafeEqual(digest(presented), expected)) {
      rejected.add(req);
      return;
    }
    req.scope = "operator";
  });
  // After every `onRequest` hook, the rate limiter's included.
  app.addHook("preValidation", async (req, reply) => {
    if (rejected.has(req)) return reply.status(401).send({ error: "invalid operator token" });
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Vary", varyWith(reply.getHeader("vary"), "Authorization"));
    if (scopeOf(req) === "operator") reply.header("Cache-Control", "private, no-store");
    return payload;
  });
}

/**
 * The scope a request reads in. A server without `registerScope` reads in
 * public scope: an unset scope never widens what is served.
 */
export function scopeOf(req: FastifyRequest): Scope {
  return req.scope === "operator" ? "operator" : "public";
}
