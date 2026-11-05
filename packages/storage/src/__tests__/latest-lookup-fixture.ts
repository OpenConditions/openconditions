import { readFileSync } from "node:fs";
import { recordOf } from "@openconditions/core";
import { observationId } from "@openconditions/model";

type Rec = Record<string, unknown>;
const source = "nl-ndw-flow";
const start = Date.parse("2026-11-04T00:00:00.000Z");
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../../scripts/fixtures/ndw-latest-readings.json", import.meta.url),
    "utf8",
  ),
) as { template: Rec; reading: Rec }[];

export function lookupDrafts(
  rows: number,
  cycle: number,
  options: { source?: string; indices?: readonly number[] } = {},
): Rec[] {
  const sourceId = options.source ?? source;
  const indices = options.indices ?? [0];
  return Array.from({ length: rows }, (_, i) => {
    const fixture = fixtures[indices[i % indices.length]!]!;
    const original = recordOf(fixture.template, fixture.reading);
    const {
      canonicalId: _c,
      domain: _d,
      contentHash: _h,
      revision: _r,
      recordedAt: _at,
      sinceAt: _since,
      evidence: _e,
      ...draft
    } = original;
    const end = new Date(start + cycle * 300_000).toISOString();
    const next = {
      ...draft,
      subject: { ...(draft["subject"] as Rec), featureId: `oc:feature:${sourceId}:lookup-${i}` },
      provenance: { ...(draft["provenance"] as Rec), sourceId },
      phenomenonTime: { start: new Date(start + cycle * 300_000 - 60_000).toISOString(), end },
      freshness: { fetchedAt: end },
    };
    return {
      ...next,
      id: observationId(sourceId, next as unknown as Parameters<typeof observationId>[1]),
    };
  });
}
