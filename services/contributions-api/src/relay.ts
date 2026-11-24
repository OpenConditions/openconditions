/**
 * Relay trust. A fronting application (OpenMapX's API) forwards its users'
 * requests from one address and never forwards theirs, so a limit keyed on
 * the client address would put every user of that application in one bucket.
 * A request carrying the configured relay token as its bearer is therefore
 * counted in a relay bucket of its own, with a ceiling sized for the whole
 * application; the relay limits its own clients per address. Without the
 * token configured every request is keyed on its address as before.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { strictCredential } from "@openconditions/ingest-framework";
import type { FastifyRequest } from "fastify";

export const RELAY_TOKEN_VARIABLE = "OPENCONDITIONS_RELAY_TOKEN";
export const RELAY_ENROLL_LIMIT_VARIABLE = "OPENCONDITIONS_RELAY_ENROLL_LIMIT_PER_MINUTE";

/** The shortest relay token accepted, so a guessable one fails boot. */
export const MIN_RELAY_TOKEN_LENGTH = 32;

/** Enrollments a minute the relay bucket allows, unless configured. */
export const DEFAULT_RELAY_ENROLL_LIMIT_PER_MINUTE = 600;

/** The bucket key of relayed requests; an address can never take this form. */
export const RELAY_BUCKET = "relay";

export interface RelayTrust {
  token: string;
  enrollLimitPerMinute: number;
}

/**
 * Reads the relay settings: undefined without a token (no relay is trusted).
 * A token shorter than {@link MIN_RELAY_TOKEN_LENGTH} characters, or a limit
 * that is not a whole number above 0, throws, so a misconfiguration stops the
 * boot. The token may instead be a file named by `OPENCONDITIONS_RELAY_TOKEN_FILE`.
 */
export function resolveRelayTrust(env: Record<string, string | undefined>): RelayTrust | undefined {
  const token = strictCredential(env, RELAY_TOKEN_VARIABLE);
  const rawLimit = env[RELAY_ENROLL_LIMIT_VARIABLE]?.trim() ?? "";
  let enrollLimitPerMinute = DEFAULT_RELAY_ENROLL_LIMIT_PER_MINUTE;
  if (rawLimit !== "") {
    const value = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `${RELAY_ENROLL_LIMIT_VARIABLE} must be a whole number above 0, got "${rawLimit}"`,
      );
    }
    enrollLimitPerMinute = value;
  }
  if (token === undefined) return undefined;
  if (token.length < MIN_RELAY_TOKEN_LENGTH) {
    throw new Error(
      `${RELAY_TOKEN_VARIABLE} must be at least ${MIN_RELAY_TOKEN_LENGTH} characters; generate it with openssl rand -hex 32`,
    );
  }
  return { token, enrollLimitPerMinute };
}

/** Constant-time string equality; hashing first keeps it length-safe. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Whether the request's bearer is the relay token, compared in constant time. */
export function isRelayed(req: FastifyRequest, relay: RelayTrust | undefined): boolean {
  if (relay === undefined) return false;
  const header = req.headers["authorization"];
  const provided =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
  return constantTimeEquals(provided, relay.token);
}
