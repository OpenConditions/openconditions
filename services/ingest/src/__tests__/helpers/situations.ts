/**
 * Situation drafts for the ingest suites, and a writer that stores them the
 * way a poll does. The default is a full closure of the eastbound A 46 near
 * Düsseldorf, published by the Autobahn feed.
 */
import { productionRegistry } from "@openconditions/model-registry";
import { type WriteSummary, writeSnapshot } from "@openconditions/storage";
import type postgres from "postgres";

type Rec = Record<string, unknown>;

export const registry = productionRegistry();
export const FETCHED_AT = "2026-09-06T10:00:00.000Z";

/** A situation draft of `source` with local id `local`; `over` replaces top-level fields. */
export function situationDraft(local: string, over: Rec = {}, source = "de-autobahn"): Rec {
  return {
    id: `oc:situation:${source}:${local}`,
    class: "situation",
    kind: "closure",
    type: "closure",
    subtype: "full",
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    headline: [{ lang: "de", text: "A 46 gesperrt" }],
    validity: { status: "active", start: "2026-09-06T08:00:00Z" },
    effects: [
      {
        id: `${local}/closure`,
        kind: "closure",
        v: 1,
        scope: "road",
        applicability: { kind: "all" },
        compliance: "mandatory",
        normalization: "complete",
      },
    ],
    details: { kind: "closure", v: 1 },
    location: {
      geometry: {
        type: "LineString",
        coordinates: [
          [6.805, 51.20001],
          [6.818, 51.20001],
        ],
      },
      extent: "linear",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [{ ref: "A 46" }],
      admin: { country: "DE" },
    },
    provenance: {
      origin: "feed",
      sourceId: source,
      sourceFormat: "autobahn",
      accessMode: "bulk",
      recordId: local,
      attribution: { provider: "Autobahn GmbH", license: "DL-DE-BY-2.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: FETCHED_AT },
    ...over,
  };
}

/** One directed span a binding covers. */
export interface TestSpan {
  segmentId: string;
  wayId: number;
  dir?: "f" | "b";
  start: number;
  end: number;
}

/**
 * Stores a binding of a situation's location (`effectId` '') or of one
 * effect's own location, with its spans, as the binder would have written it
 * for `revision` on graph `generation`.
 */
export async function bindSituation(
  sql: postgres.Sql,
  recordId: string,
  binding: {
    status: string;
    confidence?: number;
    spans?: readonly TestSpan[];
    effectId?: string;
    revision?: number;
    generation: string;
    resolverVersion: string;
  },
): Promise<void> {
  const effectId = binding.effectId ?? "";
  await sql`
    INSERT INTO conditions.record_binding
      (record_class, record_id, effect_id, status, confidence, direction_mode, candidate_count,
       resolver_version, geom_hash, record_revision, graph_generation, bound_at)
    VALUES ('situation', ${recordId}, ${effectId}, ${binding.status}, ${binding.confidence ?? null},
      'single', 1, ${binding.resolverVersion}, ${`hash-${recordId}`}, ${binding.revision ?? 1},
      ${binding.generation}, ${FETCHED_AT})`;
  for (const [seq, span] of (binding.spans ?? []).entries()) {
    await sql`
      INSERT INTO conditions.record_segment
        (record_class, record_id, effect_id, seq, segment_id, way_id, dir, start_fraction,
         end_fraction)
      VALUES ('situation', ${recordId}, ${effectId}, ${seq}, ${span.segmentId}, ${span.wayId},
        ${span.dir ?? "f"}, ${span.start}, ${span.end})`;
  }
}

/** Stores `drafts` as one poll of `source`; a complete poll withdraws what it does not hold. */
export async function writeSituations(
  sql: postgres.Sql,
  source: string,
  drafts: readonly Rec[],
  now = FETCHED_AT,
  complete = true,
): Promise<WriteSummary> {
  const summary = await writeSnapshot(
    sql,
    source,
    { situations: drafts },
    { registry, instanceId: "test.local", now, complete },
  );
  if (summary.rejected.length > 0) {
    throw new Error(`rejected drafts: ${JSON.stringify(summary.rejected)}`);
  }
  return summary;
}
