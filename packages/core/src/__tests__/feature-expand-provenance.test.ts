import { expect, it } from "vitest";
import { latestOfFeatures } from "../feature-expand.js";
import type { QueryRunner } from "../query-runner.js";

it("publishes cloned captured reading credits while excluding private provenance and applying egress first", async () => {
  const attribution = {
    provider: "Captured A",
    license: "CC-BY-4.0",
    publisher: { name: "Original author" },
  };
  const upstream = [
    { publisher: "Original upstream", license: "CC0-1.0", attribution: "Keep this notice" },
  ];
  const mergedSources = [
    {
      source: "camera-feed",
      recordId: "oc:observation:camera-feed:1",
      attribution,
      upstream,
      link: "same_record",
    },
  ];
  const provenance = {
    sourceId: "@fused",
    attribution,
    upstream,
    mergedSources,
    reporter: { keyId: "private-key" },
    rawRef: { hash: "private-raw" },
    derivedFrom: { records: ["private-input"] },
    privacy: { class: "crowd_pseudonym" },
  };
  const record = {
    id: "reading",
    property: "camera.image",
    result: { type: "text", value: "captured.jpg" },
    phenomenonTime: { instant: "2026-10-01T10:00:00Z" },
    provenance,
  };
  const row = {
    feature_id: "feature",
    component_key: null,
    qualifier_key: "",
    source_id: "@fused",
    fused_sources: ["camera-feed", "crowd"],
    record,
  };
  const db: QueryRunner = {
    async execute<T>() {
      return [row] as T;
    },
  };
  const query = {
    registry: { property: () => undefined },
    features: [{ id: "feature", components: [] }],
    canonical: true,
    scope: "public" as const,
    at: new Date("2026-10-01T10:00:00Z"),
  };
  const readings = (await latestOfFeatures(db, query)).get("feature")!;
  const serialized = JSON.parse(JSON.stringify(readings[0]));
  expect(serialized.contributors).toEqual(["camera-feed", "crowd"]);
  expect(serialized.provenance).toEqual({
    sourceId: "@fused",
    attribution,
    upstream,
    mergedSources: mergedSources.map(({ link: _link, ...credit }) => credit),
  });
  expect(JSON.stringify(serialized)).not.toMatch(/private-|derivedFrom|privacy|same_record/);
  attribution.publisher.name = "Later B";
  upstream[0]!.publisher = "Later upstream";
  expect(JSON.stringify(readings)).not.toMatch(/Later B|Later upstream/);
  const rights = {
    redistribution: true,
    derived_redistribution: true,
    commercial_use: true,
    attribution_required: true,
    retention: true,
    evidence_origin: "private-clearance",
    evidence_version: "internal-review",
    reviewed_at: "2026-10-01",
  };
  Object.assign(attribution, { rights, internalFutureField: "private-future" });
  const [publicReading] = (await latestOfFeatures(db, query)).get("feature")!;
  expect(JSON.stringify(publicReading)).not.toMatch(
    /rights|evidence_origin|private-clearance|internalFutureField/,
  );
  const withheld = await latestOfFeatures(db, { ...query, egress: () => [] });
  expect(withheld.get("feature")).toEqual([]);
});
