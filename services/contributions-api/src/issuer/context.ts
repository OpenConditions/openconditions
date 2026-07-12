/**
 * Domain-separated public context for Privacy Pass tokens.
 *
 * The context string `${purpose}:${taskId ?? "-"}:${epoch}` (e.g.
 * "report:-:2026-07-12", later "probe:task-abc:epoch-42") is hashed into the
 * 32-byte `redemptionContext` of the RFC 9577 TokenChallenge. The Token binds
 * a SHA-256 digest of the serialized challenge into its AuthenticatorInput,
 * so a token issued for one context can never redeem in another — the
 * redemptionContext bytes ARE the binding; there is no separate string field.
 *
 * The reporter's admitted keyId NEVER appears in the context, the challenge,
 * or anything the issuer/origin logs — that is the unlinkability boundary.
 */

export interface PublicContext {
  purpose: string;
  taskId?: string;
  epoch: string;
}

const CONTEXT_PART = /^[A-Za-z0-9_-]+$/;

/**
 * True when a purpose/taskId/epoch value is a plain slug. The colon is the
 * context separator, so any part containing one (or whitespace, or nothing)
 * would make two different contexts collide — reject it at the boundary.
 */
export function isValidContextPart(part: string): boolean {
  return CONTEXT_PART.test(part);
}

/** Canonical string form, also recorded as spent_token.purpose. */
export function publicContextString(ctx: PublicContext): string {
  return `${ctx.purpose}:${ctx.taskId ?? "-"}:${ctx.epoch}`;
}

/** SHA-256 of the canonical context string — the TokenChallenge redemptionContext. */
export async function redemptionContext(ctx: PublicContext): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(publicContextString(ctx))
  );
  return new Uint8Array(digest);
}

/** Report epoch v1: the UTC day of the given instant. */
export function reportEpoch(nowIso: string): string {
  return new Date(nowIso).toISOString().slice(0, 10);
}
