/**
 * Token redemption (origin side): single-use enforcement + Blind-RSA
 * verification against every issuer key valid at redemption time.
 *
 * Verify order is INSERT-FIRST, fail closed:
 *  1. INSERT the SHA-256 of the full serialized token bytes into
 *     conditions.spent_token — a conflict on the primary key means the token
 *     was already spent, so the answer is false before any crypto runs. If
 *     the insert succeeds but verification then fails, the row is KEPT: a bad
 *     token burning its own hash is harmless.
 *  2. Rebuild the expected TokenChallenge from the domain-separated public
 *     context and compare its SHA-256 against the challengeDigest the token
 *     signed over (constant-time). A token issued for context A can never
 *     redeem under context B — the redemptionContext bytes ARE the binding.
 *  3. Library signature verification against the issuer key named by the
 *     token's tokenKeyId, if that key is valid at redemption time.
 *
 * Honesty constraint: a redeemed token proves possession of ONE unspent
 * token, not a distinct human contributor.
 *
 * Log separation (binding): the origin logger logs ONLY purpose + outcome —
 * never token bytes, reporter keys, or request ids.
 */
import { timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { publicVerif, Token } from "@cloudflare/privacypass-ts";
import { publicContextString, redemptionContext, type PublicContext } from "./context.js";
import type { IssueLogger } from "./issue.js";
import { loadActiveIssuerKeys } from "./keys.js";

const { BLIND_RSA, BlindRSAMode, Origin } = publicVerif;

export interface TokenVerifierOptions {
  issuerName: string;
  log: IssueLogger;
}

export class TokenVerifier {
  private readonly issuerName: string;
  private readonly log: IssueLogger;

  constructor(options: TokenVerifierOptions) {
    this.issuerName = options.issuerName;
    this.log = options.log;
  }

  async verify(
    sql: postgres.Sql,
    tokenBytes: Uint8Array,
    publicContext: PublicContext,
    nowIso: string
  ): Promise<boolean> {
    const purpose = publicContextString(publicContext);
    const tokenHash = Buffer.from(
      await globalThis.crypto.subtle.digest("SHA-256", tokenBytes as BufferSource)
    ).toString("hex");

    const inserted = await sql<{ token_hash: string }[]>`
      INSERT INTO conditions.spent_token (token_hash, purpose, spent_at)
      VALUES (${tokenHash}, ${purpose}, ${new Date(nowIso)})
      ON CONFLICT (token_hash) DO NOTHING
      RETURNING token_hash
    `;
    if (inserted.length === 0) {
      this.log.info({ purpose, outcome: "already-spent" }, "token redemption refused");
      return false;
    }

    let token: Token;
    try {
      token = Token.deserialize(BLIND_RSA, tokenBytes);
    } catch {
      this.log.info({ purpose, outcome: "malformed" }, "token redemption refused");
      return false;
    }

    const origin = new Origin(BlindRSAMode.PSS);
    const expectedChallenge = origin.createTokenChallenge(
      this.issuerName,
      await redemptionContext(publicContext)
    );
    const expectedDigest = new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        expectedChallenge.serialize() as BufferSource
      )
    );
    const actualDigest = token.authInput.challengeDigest;
    if (
      actualDigest.length !== expectedDigest.length ||
      !timingSafeEqual(actualDigest, expectedDigest)
    ) {
      this.log.info({ purpose, outcome: "wrong-context" }, "token redemption refused");
      return false;
    }

    const keys = await loadActiveIssuerKeys(sql, nowIso, this.issuerName);
    const issuerKey = keys.find(
      (k) =>
        k.tokenKeyId.length === token.authInput.tokenKeyId.length &&
        timingSafeEqual(k.tokenKeyId, token.authInput.tokenKeyId)
    );
    if (issuerKey === undefined) {
      this.log.info({ purpose, outcome: "unknown-key" }, "token redemption refused");
      return false;
    }

    const valid = await origin.verify(token, issuerKey.publicKey);
    this.log.info(
      { purpose, outcome: valid ? "redeemed" : "bad-signature" },
      valid ? "token redeemed" : "token redemption refused"
    );
    return valid;
  }
}
