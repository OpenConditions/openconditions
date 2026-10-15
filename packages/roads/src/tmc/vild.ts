/** VILD is not Dutch RDS-TMC/LCL. Its release/version/subversion wire identity
 * is matched literally; no fabricated TABCD or cross-edition road fallback. */
import type { PointGeometry } from "@openconditions/core";
import type { RoadEvent } from "../model.js";
import type { AlertCReference, TmcUnresolvedReason } from "./resolve.js";
import snapshot from "./snapshots/vild-nl-6.13.A.json" with { type: "json" };

export type VildReference = AlertCReference & {
  type?: string;
  hasOffsets?: boolean;
  hasSecondary?: boolean;
};
export type VildResolution =
  | { ok: true; geometry: PointGeometry; locationTable: NonNullable<RoadEvent["locationTable"]> }
  | { ok: false; reason: TmcUnresolvedReason | "unsupported-reference" };

let points: Map<number, [number, number]> | undefined;

/** Only the zero-offset Method2 point form measured in the NDW feed is enabled.
 * A coded point is a coarse location, never a calibrated closure extent. */
export function resolveVild(ref: VildReference): VildResolution {
  if (
    ref.country?.trim() !== snapshot.reference.country ||
    ref.table?.trim() !== snapshot.reference.table
  )
    return { ok: false, reason: "no-table" };
  if (!ref.version?.trim()) return { ok: false, reason: "version-missing" };
  if (ref.version.trim() !== snapshot.reference.version)
    return { ok: false, reason: "version-mismatch" };
  if (
    ref.type !== "AlertCMethod2Point" ||
    ref.hasOffsets ||
    ref.hasSecondary ||
    ref.secondary !== undefined
  )
    return { ok: false, reason: "unsupported-reference" };
  if (!Number.isSafeInteger(ref.primary) || (ref.primary ?? 0) <= 0)
    return { ok: false, reason: "no-reference" };
  points ??= new Map(
    snapshot.points.map(([code, lon, lat]) => [code as number, [lon as number, lat as number]]),
  );
  const coordinate = points.get(ref.primary!);
  if (!coordinate) return { ok: false, reason: "unknown-code" };
  return {
    ok: true,
    geometry: { type: "Point", coordinates: [...coordinate] },
    locationTable: {
      ref: "VILD",
      version: snapshot.edition,
      attribution: snapshot.attribution,
      license: snapshot.license,
    },
  };
}
