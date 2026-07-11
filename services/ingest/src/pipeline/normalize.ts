import {
  canonicalId,
  phenomenonFingerprint,
  type ConditionEvent,
  type Observation,
  type PrivacyClass,
} from "@openconditions/core";

/**
 * Identifies the trusted writer stamping provenance onto an observation. This
 * is the ONLY authority for the commons federation/privacy fields — parsers and
 * untrusted payloads must never set them. Designed to extend: a later crowd
 * writer adds `"crowd"` and a federation writer adds `"federation"`, each with
 * its own derived privacy class.
 */
export interface WriterContext {
  kind: "feed";
  /** This instance's stable id, stamped onto every row it writes. */
  instanceId: string;
}

/** Privacy tier each writer kind produces. Extending `kind` forces a mapping here. */
const PRIVACY_BY_KIND: Record<WriterContext["kind"], PrivacyClass> = {
  feed: "authoritative",
};

/**
 * Privacy-accounting fields each writer kind must never carry inbound. A
 * feed-origin row asserting DP/k-anon accounting is semantically nonsense and
 * always a parser bug; a future federation/collector context may legitimately
 * carry these, which is why the rule is per-kind rather than absolute.
 */
const REJECTED_BY_KIND: Record<WriterContext["kind"], readonly (keyof Observation)[]> = {
  feed: ["kAnonymity", "dpEpsilon", "dpDelta"],
};

/**
 * Resolves this instance's stable id from the environment. Federation (a later
 * plan) makes a real, unique instance id operationally required; until then
 * `"local"` keeps a single-instance deployment zero-config.
 */
export function resolveInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["OPENCONDITIONS_INSTANCE_ID"]?.trim();
  return raw ? raw : "local";
}

/**
 * The single defaulting seam that stamps the commons federation/privacy
 * provenance fields onto an observation. Invoked once per row at the write
 * choke point (`atomicSwap`), so every persisted row is normalized and no
 * parser can claim these fields. Returns a NEW object; the input is not mutated.
 *
 * A parser (or replayed payload) that carries a `privacyClass`/`instanceId`
 * DIFFERENT from what the trusted context derives is a bug, never silently
 * accepted — it throws. Equal values pass, so re-normalizing an already-stamped
 * row is idempotent.
 */
export function normalizeObservation(obs: Observation, ctx: WriterContext): Observation {
  const derivedPrivacy = PRIVACY_BY_KIND[ctx.kind];
  if (obs.privacyClass !== undefined && obs.privacyClass !== derivedPrivacy) {
    throw new Error(
      `observation ${obs.id} carries privacyClass "${obs.privacyClass}" but the ${ctx.kind} ` +
        `writer derives "${derivedPrivacy}" — provenance is set centrally in normalizeObservation, never by a parser`
    );
  }
  if (obs.instanceId !== undefined && obs.instanceId !== ctx.instanceId) {
    throw new Error(
      `observation ${obs.id} carries instanceId "${obs.instanceId}" but this instance is ` +
        `"${ctx.instanceId}" — provenance is set centrally in normalizeObservation, never by a parser`
    );
  }
  for (const field of REJECTED_BY_KIND[ctx.kind]) {
    if (obs[field] !== undefined) {
      throw new Error(
        `observation ${obs.id} carries ${field} but a ${ctx.kind}-origin row never does ` +
          `privacy accounting — set centrally in normalizeObservation, never by a parser`
      );
    }
  }

  const next: Observation = { ...obs };
  // confidenceScore is a derived presentation value owned by the (future)
  // evidence policy — same class as the canonicalId overwrite, so strip it
  // silently rather than trusting a parser's number.
  delete next.confidenceScore;
  next.instanceId = ctx.instanceId;
  // Derived identity fields: any incoming value is overwritten (they are excluded
  // from content_hash, so re-deriving them never forces a row rewrite).
  next.canonicalId = canonicalId(next);
  next.privacyClass = derivedPrivacy;

  if (next.kind === "event") {
    // phenomenonFingerprint needs a validFrom; some events legitimately lack one
    // (or carry a malformed value). A missing candidate key only reduces grouping,
    // so leave the fingerprint unset for that row rather than throwing the whole
    // batch away. Only TypeError (core's malformed-input signal) is swallowed —
    // anything else propagates so a future core regression cannot silently
    // produce fingerprint-less rows.
    if (next.validFrom == null) {
      delete next.phenomenonFingerprint;
    } else {
      try {
        next.phenomenonFingerprint = phenomenonFingerprint(next as ConditionEvent);
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
        delete next.phenomenonFingerprint;
      }
    }
  } else {
    // Measurements are never phenomenon-collapsed: distinct sensors would share a
    // key. Strip any value a parser set.
    delete next.phenomenonFingerprint;
  }

  // Content-bearing provenance: promote the origin attribution's url/license when
  // the observation doesn't already carry them. Unlike the derived fields above,
  // these ARE folded into content_hash when present, so stamping them changes an
  // existing feed row's hash exactly ONCE — a deliberate one-time diff-upsert
  // rewrite on the first poll after deploy, because these fields genuinely became
  // hashed content. `fuzziness` is intentionally NOT defaulted here: the DB column
  // default fills 'exact', and materializing it would flip every existing row's hash.
  next.sourceUri = obs.sourceUri ?? obs.origin.attribution?.url;
  next.sourceLicense = obs.sourceLicense ?? obs.origin.attribution?.license;

  return next;
}
