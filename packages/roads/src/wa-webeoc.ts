import { recordSkipped } from "@openconditions/ingest-framework";
import { boundRestrictionIssue, registeredClassification } from "@openconditions/model-roads";
import type { RoadEvent } from "./model.js";
import { coarseOf } from "./situation/classes.js";
import { usableGeometry } from "./situation/location.js";
import {
  canonicalSnapshotValue,
  type RoadSnapshotReport,
  reconcileRoadSnapshots,
} from "./snapshot.js";
import type { SourceDescriptor } from "./types.js";

export const WA_WEBEOC_NOTICE =
  "The Commissioner of Main Roads is the creator and owner of the data and Licenced Material, which is accessed pursuant to a Creative Commons (Attribution) Licence, which has a disclaimer of warranties and limitation of liability.";

const CAUSES: Record<string, string> = {
  Flooding: "road_hazard.hazard.flooding",
  Bushfire: "road_hazard.hazard.wildfire_near_road",
  "Animal / Livestock": "incident.obstruction.animal",
  "Reduced Visibility (fog, smoke, dust over road)": "road_hazard.hazard.low_visibility",
  // The combined token does not establish potholes specifically.
  "Pothole / Road Surface Damage": "road_condition.surface",
};
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const numberId = (v: unknown): string | undefined =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? String(v) : undefined;
function identity(p: Record<string, unknown>): string | undefined {
  const guid = str(p["GlobalID"])?.replace(/^\{(.*)\}$/, "$1");
  if (guid && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(guid))
    return guid.toLowerCase();
  const id = numberId(p["Id"]);
  if (id) return `id-${id}`;
  const fid = numberId(p["FID"]);
  return fid ? `fid-${fid}` : undefined;
}

/** Pure WebEOC reader. No inference from access prose or timezone-free string dates. */
export function parseWaWebeocSnapshot(
  input: string | Buffer,
  src: SourceDescriptor,
): RoadSnapshotReport {
  const doc = JSON.parse(input.toString());
  if (
    doc?.type !== "FeatureCollection" ||
    !Array.isArray(doc.features) ||
    doc.error ||
    ((doc.exceededTransferLimit === true || doc.properties?.exceededTransferLimit === true) &&
      doc.features.length < 2000)
  ) {
    throw new Error("wa-webeoc: incomplete or invalid FeatureCollection");
  }
  const report: RoadSnapshotReport = { inputCount: doc.features.length, records: [], errors: [] };
  // This is retrieval time only; never a source publication/occurrence instant.
  const now = new Date().toISOString();
  for (const [index, feature] of doc.features.entries()) {
    const p = feature?.properties;
    const localId = p && typeof p === "object" ? identity(p) : undefined;
    if (!localId || feature.type !== "Feature") {
      report.errors.push({ code: "invalid_identity", id: null, sourcePath: `features[${index}]` });
      continue;
    }
    const id = `${src.id}:${localId}`;
    const base = {
      id,
      version: null,
      versionTime: null,
      fingerprint: canonicalSnapshotValue(feature),
    };
    if (p.publishExt !== "Yes") {
      // Only an explicit publisher exclusion is terminal; absent/unknown flags fail closed.
      if (p.publishExt !== "No")
        report.errors.push({
          code: "unknown_publication_state",
          id,
          sourcePath: `features[${index}].properties.publishExt`,
        });
      report.records.push({ ...base, disposition: "terminal" });
      continue;
    }
    const geometry = usableGeometry(feature.geometry);
    if (!geometry || (geometry.type !== "LineString" && geometry.type !== "MultiLineString")) {
      recordSkipped(src.id, "no_geometry", 1);
      report.records.push({ ...base, disposition: "unlocatable" });
      continue;
    }
    const cause = str(p.IncidentTy);
    const classification = registeredClassification(
      cause && Object.hasOwn(CAUSES, cause) ? (CAUSES[cause] ?? "other.other") : "other.other",
    ) ?? { kind: "other", type: "other" };
    if (cause && !Object.hasOwn(CAUSES, cause)) recordSkipped(src.id, "unknown_value", 1);
    const access = str(p.ClosureTyp);
    const detour = access === "Detour" || access === "Detours";
    const closed = access === "Road closed";
    const caution = access === "Road open with caution";
    const partial = !closed && !caution && !detour;
    const headline = str(p.Location);
    const event: RoadEvent = {
      id,
      source: src.id,
      sourceFormat: "wa-webeoc",
      domain: "roads",
      kind: "event",
      ...coarseOf(classification),
      ...(detour ? { type: "detour" as const } : {}),
      subtype: cause,
      situation: {
        classification,
        externalIds: ["Id", "FID"].flatMap((key) => {
          const value = numberId(p[key]);
          return value === undefined
            ? []
            : [{ scheme: "provider", id: `${key}:${value}`, authority: src.id }];
        }),
        comments: [str(p.IncidentTy), str(p.ClosureTyp)]
          .filter((s): s is string => s !== undefined)
          .map((value) => ({ type: "public" as const, text: [{ lang: "und", text: value }] })),
        ...(headline ? {} : { headlineFromSource: false }),
      },
      severity: "unknown",
      severitySource: "derived",
      status: "active",
      geometry,
      roads: [
        ...new Set([p.Road, p.LocalRoadName].map(str).filter((s): s is string => s !== undefined)),
      ].map((name) => ({ name })),
      regions: [p.Suburb, p.Region].map(str).filter((s): s is string => s !== undefined),
      headline: headline ?? "Road information",
      description: str(p.TrafficImp),
      ...(closed ? { roadState: "closed" as const } : {}),
      ...(partial
        ? {
            restrictionDetails: {
              schemaVersion: 1 as const,
              vehicleScope: "unknown" as const,
              completeness: "partial" as const,
              facts: [],
              issues: [
                boundRestrictionIssue({
                  code: "unsupported_type",
                  factId: null,
                  sourcePath: "properties.ClosureTyp",
                  sourceText: str(p.TrafficImp),
                  sourceTokens: { ClosureTyp: access ?? null },
                }),
              ],
              source: {
                sourceId: src.id,
                recordId: localId,
                recordVersion: null,
                sourceUpdatedAt: null,
                feedUrls: [],
                publisher: src.attribution,
                license: src.license,
                licenseUrl: src.licenseUrl ?? "https://creativecommons.org/licenses/by/4.0/",
                attribution: src.attribution,
                modificationNotice:
                  "Normalized by OpenConditions; source structure may be transformed.",
                notices: [WA_WEBEOC_NOTICE],
              },
            },
          }
        : {}),
      sourceRaw: p,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: now,
      fetchedAt: now,
      isStale: false,
    };
    report.records.push({ ...base, disposition: "accepted", event });
  }
  return report;
}

/** Unknown identities and conflicting duplicate parts invalidate the entire poll. */
export function parseWaWebeoc(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  return reconcileRoadSnapshots([parseWaWebeocSnapshot(input, src)]).observations as RoadEvent[];
}
