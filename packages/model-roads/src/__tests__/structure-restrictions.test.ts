import { buildRegistry, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { roadsModule } from "../module.js";
import { type StructureInput, structureRestrictions } from "../structure-restrictions.js";

const registry = buildRegistry([kernelModule, roadsModule]);
const m = (value: number) => ({ value, unit: "m" as const });

const structure = (
  details: StructureInput["details"],
  over: Partial<StructureInput> = {},
): StructureInput => ({
  id: "oc:feature:us-nbi:11-0001",
  type: "bridge",
  name: [{ lang: "en", text: "I-295 over Kenilworth Ave" }],
  lifecycle: "operational",
  location: {
    geometry: { type: "Point", coordinates: [-76.95, 38.9] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  },
  provenance: {
    sourceId: "us-nbi",
    sourceFormat: "datex2",
    accessMode: "bulk",
    recordId: "11-0001",
    attribution: { provider: "FHWA", license: "public-domain" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: "2026-09-29T21:08:00Z" },
  details,
  ...over,
});

const effectsOf = (s: Record<string, unknown>) => s["effects"] as Record<string, unknown>[];

describe("structure restrictions", () => {
  it("makes a signed height the legal limit, whatever was measured", () => {
    const [height, ...rest] = structureRestrictions(
      structure({
        clearances: [
          { road: "carried", height: m(4.6), basis: "measured", position: "left" },
          { road: "carried", height: m(4.2), basis: "calculated" },
          { road: "carried", height: m(4.0), basis: "signed" },
        ],
      }),
    );
    expect(rest).toEqual([]);
    expect(height).toMatchObject({
      kind: "restriction",
      type: "dimension",
      subtype: "height",
      details: { basis: "structural", enforcement: "signed" },
    });
    expect(effectsOf(height!)[0]).toMatchObject({
      kind: "dimension_limit",
      dimension: "height",
      value: { value: 4.0, unit: "m" },
      meaning: "maximum_permitted",
    });
  });

  it("uses the calculated height, which keeps a margin, when nothing is signed", () => {
    const [height] = structureRestrictions(
      structure({
        clearances: [
          { road: "carried", height: m(4.58), basis: "measured" },
          { road: "carried", height: m(4.3), basis: "calculated" },
        ],
      }),
    );
    expect(effectsOf(height!)[0]).toMatchObject({
      value: { value: 4.3, unit: "m" },
      meaning: "physical_limit",
    });
  });

  it("puts the under-clearance on the road beneath, named so binding finds it", () => {
    const [under] = structureRestrictions(
      structure({
        crosses: "KENILWORTH AVE",
        clearances: [{ road: "crossed", height: m(4.39), basis: "measured" }],
      }),
    );
    expect(under!["location"]).toMatchObject({
      roads: [{ name: [{ lang: "en", text: "KENILWORTH AVE" }] }],
    });
    expect(effectsOf(under!)[0]).toMatchObject({ meaning: "physical_limit" });
  });

  it("keeps a load posting without a published weight as withheld evidence", () => {
    const [posted] = structureRestrictions(
      structure({ nbi: { openStatus: "P" } } as StructureInput["details"]),
    );
    expect(posted).toMatchObject({ type: "dimension", subtype: "weight" });
    expect(effectsOf(posted!)[0]).toMatchObject({
      kind: "unsupported",
      normalization: "unsupported",
      issues: [{ code: "value_not_published" }],
    });
  });

  it("turns a closed bridge into a closure of the bridge", () => {
    const [closure] = structureRestrictions(structure({}, { lifecycle: "temporarily_closed" }));
    expect(closure).toMatchObject({ kind: "closure", type: "closure", subtype: "bridge" });
    expect(effectsOf(closure!)[0]).toMatchObject({ kind: "closure", scope: "bridge" });
  });

  it("judges each road on its own: a signed road above, only a measured one below", () => {
    const drafts = structureRestrictions(
      structure({
        clearances: [
          { road: "carried", height: m(5.1), basis: "signed" },
          { road: "crossed", height: m(4.39), basis: "measured" },
        ],
      }),
    );
    expect(drafts.map((d) => effectsOf(d)[0]!["meaning"])).toEqual([
      "maximum_permitted",
      "physical_limit",
    ]);
  });

  it("derives nothing from a structure without limits", () => {
    expect(structureRestrictions(structure({ carries: "SR 7" }))).toEqual([]);
  });

  it("produces valid situation drafts that name the structure they came from", () => {
    const drafts = structureRestrictions(
      structure(
        {
          crosses: "KENILWORTH AVE",
          clearances: [
            { road: "crossed", height: m(4.39), basis: "measured" },
            { road: "carried", height: m(5.1), basis: "signed" },
          ],
          weightLimit: { value: 20000, unit: "kg" },
          nbi: { openStatus: "P" },
        } as StructureInput["details"],
        { lifecycle: "temporarily_closed" },
      ),
    );
    expect(drafts.map((d) => d["id"])).toEqual([
      "oc:situation:us-nbi:11-0001/carried/height",
      "oc:situation:us-nbi:11-0001/crossed/height",
      "oc:situation:us-nbi:11-0001/carried/gross_weight",
      "oc:situation:us-nbi:11-0001/closure",
    ]);
    for (const draft of drafts) {
      const result = registry.validateDraft(draft);
      expect(result.ok ? [] : result.issues).toEqual([]);
      expect(draft["provenance"]).toMatchObject({
        origin: "derived",
        derivedFrom: { records: [{ class: "feature", id: "oc:feature:us-nbi:11-0001" }] },
      });
    }
  });
});
