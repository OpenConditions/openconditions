import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectFeed } from "../ops/feed-inspect.js";
import { repoFeed } from "./helpers/catalog.js";

const at = "2026-06-28T10:00:00Z";
const payload = readFileSync(
  new URL("../../../../packages/roads/src/__tests__/fixtures/lta/incidents.json", import.meta.url),
);
const feed = repoFeed("sg-lta-events");

describe("offline feed inspection", () => {
  it("links captured bytes to validated canonical previews and actual exports deterministically", () => {
    const report = inspectFeed(feed, [payload], at);
    expect(report).toEqual(inspectFeed(feed, [payload], at));
    expect(report.inputs).toEqual([
      { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: payload.length },
    ]);
    expect(report.counts).toMatchObject({ parsed: 3, selected: 3, valid: 3 });
    expect(report.records[0]).toMatchObject({
      validation: { ok: true },
      canonicalPreview: { revision: 1, provenance: { instanceId: "inspect.local" } },
    });
    expect(report.exports.geojson.features).toHaveLength(3);
    expect(report.exports.traff).toContain("<message ");
    expect(report.exports.datex).toContain("sit:situation");
    expect(report.records[0]!.projection.traff.messages).toBeGreaterThan(0);
  });

  it("keeps local drafts visible while explaining public source and licence withholding", () => {
    for (const over of [{ restricted: true }, { license: "NOASSERTION" }]) {
      const report = inspectFeed({ ...feed, ...over }, [payload], at);
      expect(report.records).toHaveLength(3);
      expect(report.records[0]!.canonicalPreview).toBeDefined();
      expect(report.records[0]!.projection.public.reason).toBe(
        over.restricted ? "restricted_source" : "non_public_license",
      );
      expect(report.exports.geojson.features).toHaveLength(0);
      expect(report.exports.traff).not.toContain("<message ");
    }
  });

  it("reports model validation failures without passing bad geometry to exporters", () => {
    const invalid = JSON.parse(payload.toString());
    invalid.value[0].Latitude = 1000;
    const report = inspectFeed(feed, [Buffer.from(JSON.stringify(invalid))], at);
    expect(report.counts).toMatchObject({ parsed: 3, valid: 2 });
    const rejected = report.records.find((r) => !r.validation.ok)!;
    expect(rejected.validation).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: expect.any(Array), message: expect.any(String) }),
      ]),
    });
    expect(rejected.canonicalPreview).toBeNull();
    expect(rejected.projection.public.reason).toBe("invalid_draft");
    expect(report.exports.geojson.features).toHaveLength(2);
  });

  it("shows vehicle restriction evidence that XML publishers refuse without losing the canonical location", () => {
    const bytes = readFileSync(
      new URL(
        "../../../../packages/roads/src/__tests__/fixtures/digitraffic/weight-restriction.json",
        import.meta.url,
      ),
    );
    const report = inspectFeed(repoFeed("fi-digitraffic-events"), [bytes], at);
    expect(report.counts).toMatchObject({ parsed: 1, valid: 1, publicEligible: 1 });
    expect(report.records[0]!.projection).toMatchObject({
      traff: { messages: 0, reason: "vehicle_specific_effect" },
      datex: { records: 0, reason: "vehicle_specific_effect" },
    });
    expect(report.exports.geojson.features[0]!.geometry).not.toBeNull();
    expect(report.records[0]!.effectStates).not.toBeNull();
  });

  it("keeps DATEX snapshot accounting and the source record identity alongside exports", () => {
    const bytes = readFileSync(
      new URL(
        "../../../../packages/roads/src/__tests__/fixtures/cita-lu/situations.xml",
        import.meta.url,
      ),
    );
    const report = inspectFeed(repoFeed("lu-cita-events"), [bytes], at);
    expect(report.snapshot.complete).toBe(true);
    expect(report.snapshot.inputRecords).toBeGreaterThan(0);
    expect(report.accounting?.inputCount).toBe(report.snapshot.inputRecords);
    expect(report.counts.valid).toBeGreaterThan(0);
    expect(report.records[0]!.canonicalPreview?.["provenance"]).toHaveProperty("recordId");
  });

  it("refuses a large report with an actionable exact-ID example", () => {
    const sample = JSON.parse(payload.toString());
    sample.value = Array.from({ length: 101 }, (_, i) => ({
      ...sample.value[0],
      Message: `Example ${i}`,
      Latitude: 1.0 + i * 0.01,
    }));
    expect(() => inspectFeed(feed, [Buffer.from(JSON.stringify(sample))], at)).toThrow(
      /select --id.*oc:situation:/,
    );
    expect(() => inspectFeed(feed, [], at)).toThrow("payload");
  });

  it("selects a record by exact ID without pretending the subset is the full parse", () => {
    const all = inspectFeed(feed, [payload], at);
    const id = String(all.records[1]!.draft["id"]);
    const selected = inspectFeed(feed, [payload], at, { id });
    expect(selected.counts).toMatchObject({ parsed: 3, selected: 1 });
    expect(selected.records.map((r) => r.draft["id"])).toEqual([id]);
    expect(() => inspectFeed(feed, [payload], at, { id: "missing" })).toThrow("not found");
  });

  it("rejects non-situation formats, ambiguous time and oversized inputs", () => {
    expect(() => inspectFeed(repoFeed("sg-lta-flow"), [payload], at)).toThrow("situation");
    expect(() => inspectFeed(feed, [payload], "2026-06-28")).toThrow("offset");
    expect(() => inspectFeed(feed, [Buffer.alloc(32 * 1024 * 1024 + 1)], at)).toThrow("32 MiB");
    expect(inspectFeed(feed, [Buffer.from("broken JSON")], at).warnings).toContain(
      "empty_parse_is_not_proof_of_empty_source",
    );
    expect(() =>
      inspectFeed(repoFeed("lu-cita-events"), [Buffer.from("broken XML")], at),
    ).toThrow();
  });
});
