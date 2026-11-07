import type { RecordDraft } from "@openconditions/ingest-framework";
import { sha256Hex } from "@openconditions/model";
import {
  freshness,
  type HazardsFeed,
  pointLocation,
  provenance,
  situationId,
  UNLOCATED,
} from "../records.js";
import type { JmaReport, JmaWarning } from "./report.js";
import type { JmaAreaState } from "./state.js";

/** Conservative subset of JMA offices present in the pinned official fixtures; no co-publishers. */
const OFFICES = new Set(["気象庁", "気象庁本庁", "札幌管区気象台", "横浜地方気象台"]);
function details(r: JmaReport, w?: JmaWarning): Record<string, unknown> {
  if (!OFFICES.has(r.publishingOffice) || !OFFICES.has(r.editorialOffice))
    throw new Error("JMA: unreviewed publishing/editorial office");
  if (!r.messageUrl) throw new Error("JMA: missing immutable message URL");
  return {
    messageUrl: r.messageUrl,
    family: r.family,
    controlAt: r.controlAt,
    reportAt: r.reportAt,
    ...(r.targetAt ? { targetAt: r.targetAt } : {}),
    ...(r.validAt ? { validAt: r.validAt } : {}),
    eventId: r.eventId,
    serial: r.serial,
    infoType: r.infoType,
    infoKindVersion: r.infoKindVersion,
    publishingOffice: r.publishingOffice,
    editorialOffice: r.editorialOffice,
    nativeXml: r.nativeXml,
    ...(r.earthquake?.intensity ? { intensity: r.earthquake.intensity } : {}),
    ...(r.earthquake?.coordinateRaw ? { coordinateRaw: r.earthquake.coordinateRaw } : {}),
    ...(r.earthquake?.coordinateDescription
      ? { coordinateDescription: r.earthquake.coordinateDescription }
      : {}),
    ...(r.earthquake?.magnitudeDescription
      ? { magnitudeDescription: r.earthquake.magnitudeDescription }
      : {}),
    ...(w
      ? {
          areaSystem: w.system,
          areaCode: w.area,
          warningCode: w.code || undefined,
          warningWording: w.wording,
          warningStatus: w.status,
        }
      : {}),
  };
}
/** Materializes retained native units; absence in a rolling index is never an all-clear. */
export function jmaSituations(
  feed: HazardsFeed,
  state: JmaAreaState,
  fetchedAt: string,
): RecordDraft[] {
  const drafts: RecordDraft[] = [];
  const draft = (key: string, r: JmaReport, w?: JmaWarning): RecordDraft => {
    const quake = !w;
    const kind = quake ? "natural_hazard" : "alert";
    const type = quake
      ? "earthquake"
      : r.family === "VPWW55"
        ? "rain"
        : r.family === "VPWW57"
          ? "coastal"
          : "geophysical";
    return {
      id: situationId(feed, w ? sha256Hex(key) : key),
      class: "situation",
      kind,
      type,
      ...(!quake
        ? {
            subtype:
              r.family === "VPWW55"
                ? "heavy"
                : r.family === "VPWW57"
                  ? "storm_surge"
                  : r.family === "VFVO50"
                    ? "volcano"
                    : "landslide",
          }
        : {}),
      temporality: "live",
      location:
        quake && r.earthquake?.position
          ? pointLocation(r.earthquake.position, "extent_unknown")
          : UNLOCATED,
      provenance: provenance(feed, key, r.controlAt),
      freshness: freshness(r.acquiredAt ?? fetchedAt, r.validAt),
      planned: false,
      certainty: quake ? "observed" : "unknown",
      severity: { label: "unknown" },
      headline: [{ lang: "ja", text: r.title }],
      ...(r.headline || w?.name
        ? { description: [{ lang: "ja", text: [w?.name, r.headline].filter(Boolean).join("\n") }] }
        : {}),
      validity: {
        status: "active",
        ...(r.earthquake?.originAt ? { start: r.earthquake.originAt } : {}),
        ...(r.validAt ? { end: r.validAt } : {}),
      },
      effects: [],
      details: {
        kind,
        v: 1,
        jma: details(r, w),
        ...(quake && r.earthquake?.magnitude !== undefined
          ? { magnitude: { value: r.earthquake.magnitude, scale: "Mj" } }
          : {}),
        ...(quake && r.earthquake?.depthM !== undefined
          ? { depth: { value: r.earthquake.depthM, unit: "m" } }
          : {}),
      },
    };
  };
  // Families are independent publications: a cancellation does not erase another family's event information.
  const events = new Map<string, JmaReport[]>();
  for (const r of Object.values(state.products)) {
    if (!r.family.startsWith("VXSE") || r.cancelled || !r.operational) continue;
    if (Date.parse(r.controlAt) < Date.parse(fetchedAt) - 30 * 86_400_000) continue;
    const held = events.get(r.eventId) ?? [];
    held.push(r);
    events.set(r.eventId, held);
  }
  for (const [id, reports] of events) {
    reports.sort(
      (a, b) =>
        Date.parse(a.controlAt) - Date.parse(b.controlAt) || a.family.localeCompare(b.family),
    );
    // Undefined fields never erase complementary information from an uncancelled family.
    const earthquake: NonNullable<JmaReport["earthquake"]> = {};
    for (const r of reports) {
      details(r); // Every contributing native publication must pass the same rights gate.
      // A present native field with an unknown value supersedes older precision.
      if (r.earthquake?.magnitudeDescription !== undefined) delete earthquake.magnitude;
      if (r.earthquake?.coordinateRaw !== undefined) {
        delete earthquake.position;
        delete earthquake.depthM;
      }
      for (const [k, v] of Object.entries(r.earthquake ?? {}))
        if (v !== undefined) Object.assign(earthquake, { [k]: v });
    }
    const latest = reports[reports.length - 1]!;
    const d = draft(id, { ...latest, earthquake });
    const native = (d["details"] as Record<string, unknown>)["jma"] as Record<string, unknown>;
    native["contributingReports"] = reports.map((r) => ({
      family: r.family,
      messageUrl: r.messageUrl,
      controlAt: r.controlAt,
      nativeXml: r.nativeXml,
    }));
    drafts.push(d);
  }
  for (const [id, area] of Object.entries(state.areas)) {
    if (
      area.ended ||
      (area.report.validAt && Date.parse(area.report.validAt) <= Date.parse(fetchedAt))
    )
      continue;
    drafts.push(draft(id, area.report, area.warning));
  }
  return drafts;
}
