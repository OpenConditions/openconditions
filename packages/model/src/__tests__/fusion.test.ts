import { describe, expect, it } from "vitest";
import {
  type FusableObservation,
  type FusionCandidate,
  fuse,
  fusedObservation,
  fusionTierOf,
  mostRestrictiveRights,
} from "../fusion/fuse.js";
import { crowdRegistry, NOW } from "./crowd-fixtures.js";

const status = (
  id: string,
  value: string,
  at: string,
  provenance: Partial<FusableObservation["provenance"]> = {},
): FusableObservation => ({
  id,
  property: "charging.evse_status",
  result: { type: "category", value, vocabulary: "los" },
  phenomenonTime: { instant: at },
  aggregation: "instantaneous",
  temporality: "live",
  provenance: {
    origin: "feed",
    sourceId: "de-bw-ocpdb",
    accessMode: "bulk",
    attribution: { provider: "MobiData BW", license: "CC-BY-4.0" },
    privacy: { class: "authoritative" },
    ...provenance,
  },
  freshness: {},
});

const feed = (value: string, at: string, stale = false): FusionCandidate => ({
  observation: status(`oc:observation:de-bw-ocpdb:${value}`, value, at),
  sourceTier: "authoritative",
  stale,
});

const crowd = (
  value: string,
  at: string,
  state: "self_reported" | "corroborated" | "negated",
): FusionCandidate => ({
  observation: status(`oc:observation:oc.example.org:${value}${state}`, value, at, {
    origin: "crowd",
    sourceId: "crowd",
    attribution: { provider: "oc.example.org", license: "CC0-1.0" },
    privacy: { class: "crowd_pseudonym" },
  }),
  evidence: { state },
  stale: false,
});

const winner = (candidates: FusionCandidate[]) =>
  (
    fuse(crowdRegistry, "charging.evse_status", candidates, NOW)?.winner.observation.result as
      | { value: string }
      | undefined
  )?.value;

describe("fusion", () => {
  it("ranks crowd rows by evidence and other rows by their source's tier", () => {
    expect(fusionTierOf(crowd("blocked", NOW, "corroborated"))).toBe("crowd_corroborated");
    expect(fusionTierOf(crowd("blocked", NOW, "negated"))).toBeUndefined();
    expect(fusionTierOf(feed("free_flow", NOW))).toBe("authoritative");
    expect(() => fusionTierOf({ ...feed("free_flow", NOW), sourceTier: undefined })).toThrow(
      /tier of source de-bw-ocpdb/,
    );
  });

  it("never fuses a crowd report past its life, whatever its evidence still says", () => {
    const lapsed = crowd("blocked", "2026-10-01T08:00:00Z", "corroborated");
    lapsed.observation.freshness = { expiresAt: "2026-10-01T10:00:00Z" };
    expect(winner([feed("free_flow", "2026-10-01T07:00:00Z", true), lapsed])).toBe("free_flow");
    expect(winner([lapsed])).toBeUndefined();
  });

  it("never lets a crowd report override a fresh authoritative status", () => {
    expect(
      winner([
        feed("free_flow", "2026-10-01T11:00:00Z"),
        crowd("blocked", "2026-10-01T11:59:00Z", "corroborated"),
      ]),
    ).toBe("free_flow");
  });

  it("surfaces the crowd when the feed is stale or silent, never a negated report", () => {
    expect(
      winner([
        feed("free_flow", "2026-10-01T11:00:00Z", true),
        crowd("blocked", "2026-10-01T11:59:00Z", "self_reported"),
      ]),
    ).toBe("blocked");
    expect(winner([crowd("blocked", "2026-10-01T11:59:00Z", "self_reported")])).toBe("blocked");
    expect(
      winner([
        feed("free_flow", "2026-10-01T11:00:00Z", true),
        crowd("blocked", "2026-10-01T11:59:00Z", "negated"),
      ]),
    ).toBe("free_flow");
    expect(winner([crowd("blocked", NOW, "negated")])).toBeUndefined();
  });

  it("takes the latest reading of the best tier, ignoring rows not yet or no longer in effect", () => {
    expect(
      winner([feed("slow", "2026-10-01T11:00:00Z"), feed("heavy", "2026-10-01T11:30:00Z")]),
    ).toBe("heavy");
    expect(
      winner([feed("slow", "2026-10-01T11:00:00Z"), feed("heavy", "2026-10-01T13:00:00Z")]),
    ).toBe("slow");
    const expired = feed("heavy", "2026-10-01T11:30:00Z");
    expired.observation.validUntil = "2026-10-01T11:45:00Z";
    expect(winner([feed("slow", "2026-10-01T11:00:00Z"), expired])).toBe("slow");
  });

  it("credits every source of the winning tier that published the winning value", () => {
    const other: FusionCandidate = {
      observation: status("oc:observation:de-aggregator:x", "free_flow", "2026-10-01T10:00:00Z", {
        sourceId: "de-aggregator",
        attribution: { provider: "Aggregator", license: "CC-BY-SA-4.0" },
      }),
      sourceTier: "authoritative",
      stale: false,
    };
    const fusion = fuse(
      crowdRegistry,
      "charging.evse_status",
      [feed("free_flow", "2026-10-01T11:00:00Z"), other, feed("slow", "2026-10-01T09:00:00Z")],
      NOW,
    )!;
    expect(fusion.contributors.map((c) => c.observation.id)).toEqual([
      "oc:observation:de-bw-ocpdb:free_flow",
      "oc:observation:de-aggregator:x",
    ]);
  });

  it("combines rights by the most restrictive grant", () => {
    const rights = (grant: "yes" | "no" | "unknown", attribution: "yes" | "no" | "unknown") => ({
      source_redistribution: grant,
      derived_redistribution: grant,
      commercial_use: grant,
      attribution_required: attribution,
      retention: grant,
      evidence_origin: null,
      evidence_version: null,
      reviewed_at: null,
    });
    const combined = mostRestrictiveRights([
      { provider: "a", license: "CC0-1.0", rights: rights("yes", "no") },
      { provider: "b", license: "CC-BY-4.0", rights: rights("no", "yes") },
      { provider: "c", license: "x" },
    ]);
    expect(combined).toMatchObject({
      source_redistribution: "no",
      commercial_use: "no",
      attribution_required: "yes",
    });
    expect(mostRestrictiveRights([{ provider: "c", license: "x" }])).toBeUndefined();
  });

  it("writes the fused row on the canonical subject, credited and derived from its contributors", () => {
    const fusion = fuse(
      crowdRegistry,
      "charging.evse_status",
      [feed("free_flow", "2026-10-01T11:00:00Z")],
      NOW,
    )!;
    const fused = fusedObservation(crowdRegistry, fusion, {
      subject: { kind: "feature", featureId: "oc:feature:oc.example.org:c1", componentKey: "2" },
      location: {
        geometry: { type: "Point", coordinates: [8.4, 49] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      instanceId: "oc.example.org",
      now: NOW,
    });
    expect(fused.ok).toBe(true);
    if (!fused.ok) return;
    expect(fused.value).toMatchObject({
      subject: { featureId: "oc:feature:oc.example.org:c1", componentKey: "2" },
      result: { value: "free_flow" },
      provenance: {
        origin: "derived",
        sourceId: "@fused",
        accessMode: "bulk",
        attribution: { provider: "MobiData BW" },
        derivedFrom: {
          method: "fusion",
          records: [{ class: "observation", id: "oc:observation:de-bw-ocpdb:free_flow" }],
        },
      },
    });
    expect((fused.value["id"] as string).startsWith("oc:observation:oc.example.org:")).toBe(true);
  });

  it("keeps a value fused from an on-demand source on demand", () => {
    const onDemand = feed("free_flow", "2026-10-01T11:00:00Z");
    onDemand.observation.provenance.accessMode = "on_demand";
    onDemand.observation.freshness = { expiresAt: "2026-10-01T12:10:00Z" };
    const fusion = fuse(crowdRegistry, "charging.evse_status", [onDemand], NOW)!;
    const fused = fusedObservation(crowdRegistry, fusion, {
      subject: { kind: "feature", featureId: "oc:feature:oc.example.org:c1", componentKey: "2" },
      location: { geometry: null, extent: "none", geometryOrigin: "none", fuzziness: "exact" },
      instanceId: "oc.example.org",
      now: NOW,
    });
    expect(fused.ok && fused.value["provenance"]).toMatchObject({ accessMode: "on_demand" });
    expect(fused.ok && fused.value["freshness"]).toMatchObject({
      expiresAt: "2026-10-01T12:10:00.000Z",
    });
  });
});
