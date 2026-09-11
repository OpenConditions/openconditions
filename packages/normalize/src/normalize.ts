import {
  canonicalId,
  observedKey,
  phenomenonFingerprint,
  validateObserved,
  type ConditionEvent,
  type Measurement,
  type Observation,
  type PrivacyClass,
} from "@openconditions/core";

/**
 * Identifies the trusted writer stamping provenance onto an observation. This
 * is the ONLY authority for the commons federation/privacy fields — parsers and
 * untrusted payloads must never set them.
 *
 * The `"feed"`/`"crowd"` kinds DERIVE local provenance (instanceId,
 * canonicalId, privacyClass). The `"federation"` kind is the opposite: a
 * federated event arrives ALREADY normalized by its origin instance and its
 * signature-verified origin fields are PRESERVED, never re-stamped —
 * `peerInstanceId` (the authenticated sending peer) is what the incoming
 * `instanceId` is validated against.
 */
export type WriterContext =
  | {
      kind: "feed" | "crowd";
      /** This instance's stable id, stamped onto every row it writes. */
      instanceId: string;
    }
  | {
      kind: "federation";
      /** This instance's stable id (NOT stamped — the origin's is preserved). */
      instanceId: string;
      /** The RFC-9421-authenticated sending peer's instance id. */
      peerInstanceId: string;
    };

/** Privacy tier each DERIVING writer kind produces (federation preserves instead). */
const PRIVACY_BY_KIND: Record<"feed" | "crowd", PrivacyClass> = {
  feed: "authoritative",
  crowd: "crowd_pseudonym",
};

/** The privacy classes a federated event may carry (the origin's published tier). */
const KNOWN_PRIVACY_CLASSES: ReadonlySet<string> = new Set([
  "authoritative",
  "aggregate",
  "k_anon",
  "dp_noised",
  "crowd_pseudonym",
]);

/** Evidence lifecycle states a federated event may carry (core's EvidenceState). */
const KNOWN_EVIDENCE_STATES: ReadonlySet<string> = new Set([
  "self_reported",
  "corroborated",
  "externally_resolved",
  "negated",
  "expired",
]);

/** A permanent rejection of a peer's observation, distinct from local failures. */
export class FederatedObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederatedObservationError";
  }
}

/**
 * Fields each writer kind must never carry inbound. For a feed row that is the
 * DP/k-anon privacy accounting (semantically nonsense outside an aggregate
 * writer) plus the derived evidence-policy outputs evidenceState/
 * routingEligible, which only the contributions service's recompute may write
 * — a feed asserting evidence state is a parser bug. A future federation/
 * collector context may legitimately carry some of these, which is why the
 * rule is per-kind rather than absolute.
 */
const REJECTED_BY_KIND: Record<"feed" | "crowd", readonly (keyof Observation)[]> = {
  feed: ["kAnonymity", "dpEpsilon", "dpDelta", "evidenceState", "routingEligible"],
  // A crowd report is UNTRUSTED input: it may never assert the DP/k-anon
  // privacy accounting, the derived evidence-policy outputs
  // (evidenceState/routingEligible/confidenceScore — the contributions
  // service's recompute owns them), or the provenance identity fields
  // (instanceId/privacyClass — stamped centrally here). It MAY carry the
  // content axis (replaces/corroborations/informed/severityLevel/fuzziness/
  // attributes), which is not listed.
  crowd: [
    "kAnonymity",
    "dpEpsilon",
    "dpDelta",
    "confidenceScore",
    "evidenceState",
    "routingEligible",
    "instanceId",
    "privacyClass",
  ],
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
 * Per-(source, observed-property-key) set of soft-validation warnings already
 * logged this process run, so one misbehaving feed logs a given warning once per
 * key rather than once per row. Process-lifetime and never cleared: the warning
 * is a "fix your registry/mapper" signal, not a per-cycle metric.
 */
const warnedObservedKeys = new Set<string>();

/**
 * Soft-validate an observation against the ObservedProperty registry and log any
 * warnings at WARN level, rate-limited to once per (source, key) per process run.
 * Purely advisory — the normalization result is UNAFFECTED (validateObserved
 * never throws or mutates); an unknown/mis-keyed type still ingests. This is the
 * key-sprawl guard's only runtime touch.
 */
function warnOnObserved(obs: Observation): void {
  let warnings: string[];
  try {
    ({ warnings } = validateObserved(obs));
  } catch (err) {
    // validateObserved is documented never to throw; if a future core regression
    // breaks that, an advisory key-sprawl check must NEVER abort a source swap.
    // Log once (reusing the dedup set under a distinct key) and continue.
    const failKey = `validateObserved-threw ${obs.source}`;
    if (!warnedObservedKeys.has(failKey)) {
      warnedObservedKeys.add(failKey);
      console.warn(
        `[ingest] ${obs.source}: validateObserved threw unexpectedly, skipping soft validation: ${String(err)}`
      );
    }
    return;
  }
  if (warnings.length === 0) return;
  const dedupeKey = `${obs.source}\u0000${observedKey(obs)}`;
  if (warnedObservedKeys.has(dedupeKey)) return;
  warnedObservedKeys.add(dedupeKey);
  for (const warning of warnings) {
    console.warn(`[ingest] ${obs.source}: ${warning}`);
  }
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
  if (ctx.kind === "federation") {
    return normalizeFederatedObservation(obs, ctx);
  }
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
        `observation ${obs.id} carries ${field} but a ${ctx.kind}-origin row never ` +
          `asserts it — this field is derived by a trusted writer, never by a parser`
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

  stampPhenomenonFingerprint(next);

  // Content-bearing provenance: promote the origin attribution's url/license when
  // the observation doesn't already carry them. Unlike the derived fields above,
  // these ARE folded into content_hash when present, so stamping them changes an
  // existing feed row's hash exactly ONCE — a deliberate one-time diff-upsert
  // rewrite on the first poll after deploy, because these fields genuinely became
  // hashed content. `fuzziness` is intentionally NOT defaulted here: the DB column
  // default fills 'exact', and materializing it would flip every existing row's hash.
  next.sourceUri = obs.sourceUri ?? obs.origin.attribution?.url;
  next.sourceLicense = obs.sourceLicense ?? obs.origin.attribution?.license;

  // Soft key-sprawl guard: advisory only, never changes `next`.
  warnOnObserved(next);

  return next;
}

/**
 * Derives `phenomenonFingerprint` in place: stamped for events with a usable
 * `validFrom`, cleared otherwise (measurements are never phenomenon-collapsed —
 * distinct sensors would share a key). Applied on EVERY writer path, federation
 * included: the fingerprint is derived from already-validated content, so a
 * peer-supplied value is never trusted — a deliberately colliding fingerprint
 * is simply recomputed away.
 */
function stampPhenomenonFingerprint(next: Observation): void {
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
    delete next.phenomenonFingerprint;
  }
}

/** Guard for a preserved numeric origin field: present values must sit inside
 *  the DB check-constraint range, or the event is rejected with a named reason
 *  instead of a raw constraint violation. */
function requireRange(
  id: string,
  field: string,
  value: number | undefined,
  ok: (v: number) => boolean,
  range: string
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || !ok(value)) {
    throw new FederatedObservationError(
      `federated observation ${id} carries ${field} ${JSON.stringify(value)} outside ${range}`
    );
  }
}

/**
 * The federation writer path: a federated event arrives ALREADY normalized by
 * its origin instance, so the signature-verified origin fields — instanceId,
 * canonicalId, privacyClass, evidenceState, confidenceScore, dpEpsilon/dpDelta/
 * kAnonymity — are PRESERVED, never re-stamped or rejected (unlike feed/crowd,
 * which derive or refuse them).
 *
 * Validation (a peer must send fully-normalized published views; anything else
 * throws so the caller can skip-and-report the event):
 * - `instanceId` must be present AND equal the authenticated peer's own
 *   instance id — a peer relaying a THIRD instance's events is a later
 *   capability, rejected for now;
 * - `canonicalId` must be present (exact-resupply dedup keys on it);
 * - `privacyClass` must be a known class; `evidenceState`, when present, a
 *   known state; the numeric privacy-accounting fields must sit in range.
 *
 * Local-only fields are handled here, not preserved:
 * - `origin.reporter` must already be stripped by the peer; if present it is
 *   STRIPPED again — another instance's reporter identity is never stored;
 * - `routingEligible` is stripped: routing eligibility never federates (only a
 *   LOCAL external resolution sets it). It is stripped silently rather than
 *   rejected because peers' crowd snapshots routinely carry `false`;
 * - `flaggedAt` is stripped (reviewer-queue state is per-instance);
 * - `phenomenonFingerprint` is re-derived from content, never trusted.
 */
function normalizeFederatedObservation(
  obs: Observation,
  ctx: { instanceId: string; peerInstanceId: string }
): Observation {
  for (const field of ["id", "source", "sourceFormat", "domain", "kind", "status"] as const) {
    if (typeof obs[field] !== "string" || obs[field].length === 0) {
      throw new FederatedObservationError(`federated observation requires a non-empty ${field}`);
    }
  }
  if (obs.kind !== "event" && obs.kind !== "measurement") {
    throw new FederatedObservationError(`federated observation ${obs.id} has an invalid kind`);
  }
  if (!["active", "inactive", "archived", "cancelled"].includes(obs.status)) {
    throw new FederatedObservationError(`federated observation ${obs.id} has an invalid status`);
  }
  if (
    obs.fuzziness !== undefined &&
    !["exact", "low_res", "medium_res", "end_unknown", "start_unknown", "extent_unknown"].includes(
      obs.fuzziness
    )
  ) {
    throw new FederatedObservationError(`federated observation ${obs.id} has invalid fuzziness`);
  }
  for (const field of ["isStale", "isForecast"] as const) {
    if (obs[field] !== undefined && typeof obs[field] !== "boolean") {
      throw new FederatedObservationError(
        `federated observation ${obs.id} requires boolean ${field}`
      );
    }
  }
  for (const field of ["replaces", "corroborations", "relatedIds"] as const) {
    const value = obs[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) || !value.every((id) => typeof id === "string"))
    ) {
      throw new FederatedObservationError(
        `federated observation ${obs.id} requires an array of ${field} ids`
      );
    }
  }
  if (!obs.instanceId) {
    throw new FederatedObservationError(
      `federated observation ${obs.id} carries no instanceId — a peer must send ` +
        `fully-normalized published views`
    );
  }
  if (obs.instanceId !== ctx.peerInstanceId) {
    throw new FederatedObservationError(
      `federated observation ${obs.id} carries instanceId "${obs.instanceId}" but the ` +
        `authenticated peer is "${ctx.peerInstanceId}" — relaying another instance's ` +
        `events is not supported`
    );
  }
  if (typeof obs.canonicalId !== "string" || obs.canonicalId.length === 0) {
    throw new FederatedObservationError(
      `federated observation ${obs.id} carries no canonicalId — a peer must send ` +
        `fully-normalized published views`
    );
  }
  if (obs.privacyClass === undefined || !KNOWN_PRIVACY_CLASSES.has(obs.privacyClass)) {
    throw new FederatedObservationError(
      `federated observation ${obs.id} carries privacyClass ` +
        `${JSON.stringify(obs.privacyClass)} which is not a known privacy class`
    );
  }
  if (obs.evidenceState !== undefined && !KNOWN_EVIDENCE_STATES.has(obs.evidenceState)) {
    throw new FederatedObservationError(
      `federated observation ${obs.id} carries evidenceState ` +
        `${JSON.stringify(obs.evidenceState)} which is not a known evidence state`
    );
  }
  if (obs.origin == null || (obs.origin.kind !== "feed" && obs.origin.kind !== "crowd")) {
    throw new FederatedObservationError(
      `federated observation ${obs.id} carries no feed/crowd origin provenance`
    );
  }
  const wire: Record<string, unknown> = {
    ...obs,
    sourceUri: obs.sourceUri ?? obs.origin.attribution?.url,
    sourceLicense: obs.sourceLicense ?? obs.origin.attribution?.license,
  };
  for (const field of [
    "type",
    "subtype",
    "category",
    "severity",
    "severitySource",
    "headline",
    "description",
    "label",
    "metric",
    "level",
    "unit",
    "aggregation",
    "confidence",
    "sourceUri",
    "sourceLicense",
  ]) {
    if (wire[field] !== undefined && typeof wire[field] !== "string") {
      throw new FederatedObservationError(
        `federated observation ${obs.id} requires string ${field}`
      );
    }
  }
  requireRange(obs.id, "value", (obs as Measurement).value, () => true, "finite number");
  requireRange(obs.id, "confidenceScore", obs.confidenceScore, (v) => v >= 0 && v <= 1, "[0, 1]");
  requireRange(obs.id, "dpEpsilon", obs.dpEpsilon, (v) => v >= 0, "[0, ∞)");
  requireRange(obs.id, "dpDelta", obs.dpDelta, (v) => v >= 0 && v < 1, "[0, 1)");
  requireRange(
    obs.id,
    "kAnonymity",
    obs.kAnonymity,
    (v) => Number.isInteger(v) && v > 0 && v <= 2_147_483_647,
    "positive 32-bit integer"
  );
  requireRange(
    obs.id,
    "severityLevel",
    (obs as ConditionEvent).severityLevel,
    (v) => Number.isInteger(v) && v >= 1 && v <= 5,
    "integer [1, 5]"
  );

  const next: Observation = { ...obs };
  // UNCONDITIONAL reporter strip: another instance's reporter identity is never
  // stored, feed-origin or crowd-origin. A peer could otherwise smuggle a
  // `reporter` onto a FEED origin (where it is semantically nonsense) to plant
  // a foreign key in our provenance — rebuild origin without the key for ANY
  // federated event.
  if ("reporter" in next.origin) {
    const { reporter: _reporter, ...rest } = next.origin as { reporter?: unknown };
    next.origin = rest as typeof next.origin;
  }
  delete next.routingEligible;
  delete next.flaggedAt;

  stampPhenomenonFingerprint(next);

  next.sourceUri = obs.sourceUri ?? obs.origin.attribution?.url;
  next.sourceLicense = obs.sourceLicense ?? obs.origin.attribution?.license;

  warnOnObserved(next);

  return next;
}
