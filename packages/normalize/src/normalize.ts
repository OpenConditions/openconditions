import { canonicalId, type Observation, type PrivacyClass } from "@openconditions/core";
import { isInstanceId } from "@openconditions/model";

/**
 * Identifies the trusted writer stamping provenance onto an observation. This
 * is the ONLY authority for the commons provenance/privacy fields — parsers
 * must never set them.
 */
export interface WriterContext {
  kind: "feed";
  /** This instance's stable id, stamped onto every row it writes. */
  instanceId: string;
}

/** Privacy tier a feed writer produces. */
const FEED_PRIVACY: PrivacyClass = "authoritative";

/**
 * Fields a feed row must never carry inbound: the DP/k-anon privacy
 * accounting, semantically nonsense outside an aggregate writer.
 */
const REJECTED_FEED_FIELDS: readonly (keyof Observation)[] = ["kAnonymity", "dpEpsilon", "dpDelta"];

/**
 * Resolves this instance's stable id from the environment. Federation (a later
 * plan) makes a real, unique instance id operationally required; until then
 * `"local"` keeps a single-instance deployment zero-config. The id is the
 * record-id namespace of everything this instance originates
 * (`oc:<class>:<instanceId>:<localId>`), so it must never contain ":" — a
 * hostname works. Services call this at startup, so a bad value stops the
 * service instead of the first write.
 */
export function resolveInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["OPENCONDITIONS_INSTANCE_ID"]?.trim();
  const id = raw ? raw : "local";
  if (!isInstanceId(id)) {
    throw new Error(
      `OPENCONDITIONS_INSTANCE_ID "${id}" is not a valid instance id: use lower-case letters, digits, dots and dashes, starting and ending with a letter or digit (e.g. maps.example.org)`,
    );
  }
  return id;
}

/**
 * The single defaulting seam that stamps the commons provenance/privacy fields
 * onto an observation. Invoked once per row at the write choke point
 * (`atomicSwap`), so every persisted row is normalized and no parser can claim
 * these fields. Returns a NEW object; the input is not mutated.
 *
 * A parser (or replayed payload) that carries a `privacyClass`/`instanceId`
 * DIFFERENT from what the trusted context derives is a bug, never silently
 * accepted — it throws. Equal values pass, so re-normalizing an already-stamped
 * row is idempotent.
 */
export function normalizeObservation(obs: Observation, ctx: WriterContext): Observation {
  if (obs.privacyClass !== undefined && obs.privacyClass !== FEED_PRIVACY) {
    throw new Error(
      `observation ${obs.id} carries privacyClass "${obs.privacyClass}" but the ${ctx.kind} ` +
        `writer derives "${FEED_PRIVACY}" — provenance is set centrally in normalizeObservation, never by a parser`,
    );
  }
  if (obs.instanceId !== undefined && obs.instanceId !== ctx.instanceId) {
    throw new Error(
      `observation ${obs.id} carries instanceId "${obs.instanceId}" but this instance is ` +
        `"${ctx.instanceId}" — provenance is set centrally in normalizeObservation, never by a parser`,
    );
  }
  for (const field of REJECTED_FEED_FIELDS) {
    if (obs[field] !== undefined) {
      throw new Error(
        `observation ${obs.id} carries ${field} but a ${ctx.kind}-origin row never ` +
          `asserts it — this field is derived by a trusted writer, never by a parser`,
      );
    }
  }

  const next: Observation = { ...obs };
  next.instanceId = ctx.instanceId;
  // Derived identity fields: any incoming value is overwritten (they are excluded
  // from content_hash, so re-deriving them never forces a row rewrite).
  next.canonicalId = canonicalId(next);
  next.privacyClass = FEED_PRIVACY;

  // Content-bearing provenance: promote the origin attribution's url/license when
  // the observation doesn't already carry them. Unlike the derived fields above,
  // these ARE folded into content_hash when present. `fuzziness` is intentionally
  // NOT defaulted here: the DB column default fills 'exact', and materializing it
  // would flip every existing row's hash.
  next.sourceUri = obs.sourceUri ?? obs.origin.attribution?.url;
  next.sourceLicense = obs.sourceLicense ?? obs.origin.attribution?.license;

  return next;
}
