/**
 * Token issuance: the quota-gated blind-signing half of the Privacy Pass
 * exchange. The issuer never sees the token it signs — the challenge (and its
 * domain-separated redemptionContext) is baked into the blinded message by
 * the client — so nothing here can link an issued token to its redemption.
 *
 * Honesty constraint: the per-(key, epoch) quota bounds ISSUANCE only. N
 * redeemed tokens do not prove N distinct contributors, and per-cell bounding
 * is NOT provided here.
 *
 * Log separation (binding): this module logs ONLY through the injected issuer
 * logger and never logs the reporter keyId, proof fields, or any request id.
 */
import type postgres from "postgres";
import { publicVerif } from "@cloudflare/privacypass-ts";
import { ATTESTER_POLICY } from "../attester/policy.js";
import { publicContextString, type PublicContext } from "./context.js";
import { DEFAULT_ISSUER_NAME, loadActiveIssuerKeys, type ActiveIssuerKey } from "./keys.js";

const { BLIND_RSA, TokenRequest } = publicVerif;

export interface IssueLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export type IssueRefusalReason = "not-enrolled" | "blocked" | "over-quota" | "bad-request";

export type IssueResult =
  | { issued: true; tokenResponse: Uint8Array }
  | { issued: false; reason: IssueRefusalReason };

export interface IssueDeps {
  log: IssueLogger;
  /** Currently valid issuer keys; loaded from the DB when omitted. */
  keys?: ActiveIssuerKey[];
  /** Per-epoch issuance ceiling; defaults to the attester policy. */
  cap?: number;
  issuerName?: string;
  /** ISO instant used for key-validity when keys are loaded here. */
  now?: string;
}

/**
 * Issues one Blind-RSA token response for `blindedRequestBytes`.
 *
 * Order of operations (fail closed):
 *  1. the reporter must exist and not be blocked;
 *  2. the TokenRequest must parse and name a currently valid issuer key;
 *  3. the per-(key, epoch) quota row is bumped atomically — a single
 *     INSERT ... ON CONFLICT DO UPDATE ... WHERE issued < cap, so concurrent
 *     issuances can never exceed the cap;
 *  4. only then is the blind signature computed.
 */
export async function issueToken(
  sql: postgres.Sql,
  keyId: string,
  epoch: string,
  blindedRequestBytes: Uint8Array,
  publicContext: PublicContext,
  deps: IssueDeps
): Promise<IssueResult> {
  const { log } = deps;
  const cap = deps.cap ?? ATTESTER_POLICY.grantTokensPerEpoch;
  const purpose = publicContextString(publicContext);

  const reporterRows = await sql<{ status: string }[]>`
    SELECT status FROM conditions.reporter WHERE key_id = ${keyId}
  `;
  const reporter = reporterRows[0];
  if (reporter === undefined) {
    log.warn({ purpose, epoch, outcome: "not-enrolled" }, "token issuance refused");
    return { issued: false, reason: "not-enrolled" };
  }
  if (reporter.status === "blocked" || cap < 1) {
    log.warn({ purpose, epoch, outcome: "blocked" }, "token issuance refused");
    return { issued: false, reason: "blocked" };
  }

  let request: InstanceType<typeof TokenRequest>;
  try {
    request = TokenRequest.deserialize(BLIND_RSA, blindedRequestBytes);
  } catch {
    log.warn({ purpose, epoch, outcome: "bad-request" }, "token issuance refused");
    return { issued: false, reason: "bad-request" };
  }

  const keys =
    deps.keys ??
    (await loadActiveIssuerKeys(
      sql,
      deps.now ?? new Date().toISOString(),
      deps.issuerName ?? DEFAULT_ISSUER_NAME
    ));
  const issuerKey = keys.find((k) => k.truncatedTokenKeyId === request.truncatedTokenKeyId);
  if (issuerKey === undefined) {
    log.warn({ purpose, epoch, outcome: "bad-request" }, "token issuance refused: unknown key id");
    return { issued: false, reason: "bad-request" };
  }

  const quotaRows = await sql<{ issued: number }[]>`
    INSERT INTO conditions.token_quota (key_id, epoch, issued)
    VALUES (${keyId}, ${epoch}, 1)
    ON CONFLICT (key_id, epoch) DO UPDATE
      SET issued = token_quota.issued + 1
      WHERE token_quota.issued < ${cap}
    RETURNING issued
  `;
  if (quotaRows.length === 0 || quotaRows[0]!.issued > cap) {
    log.info({ purpose, epoch, outcome: "over-quota" }, "token issuance refused");
    return { issued: false, reason: "over-quota" };
  }

  const response = await issuerKey.issuer.issue(request);
  log.info({ purpose, epoch, outcome: "issued" }, "token issued");
  return { issued: true, tokenResponse: response.serialize() };
}
