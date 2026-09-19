import { readFileSync } from "node:fs";
import { buildRegistry, CORE_ISSUE_CODES, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { parseDatexSnapshot } from "../datex.js";
import { parseDigitrafficSnapshot } from "../digitraffic.js";
import { restrictionEffects } from "../restriction-effects.js";
import type { RoadRestrictionDetailsV1 } from "../restriction-types.js";
import { isRoadRestrictionDetails, RESTRICTION_ISSUE_CODES } from "../restrictions.js";
import { reconcileRoadSnapshots } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";
import { restrictionDetails } from "./fixtures/restriction-event.js";

/**
 * The kernel Effect absorbs the restriction contract: every
 * envelope the two restriction parsers produce from their reviewed real-world
 * fixtures maps onto kernel effects that pass hard validation, with every fact
 * and every issue accounted for.
 */
const kernel = buildRegistry([kernelModule]).kernel;

const ndw: SourceDescriptor = {
  id: "nl-ndw",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};
const fintraffic: SourceDescriptor = {
  id: "fi-digitraffic",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};

function envelopes(): RoadRestrictionDetailsV1[] {
  const ndwXml = readFileSync(
    new URL("./fixtures/ndw/restrictions-v3.xml", import.meta.url),
    "utf8",
  );
  const dtJson = JSON.parse(
    readFileSync(new URL("./fixtures/digitraffic/v2-restrictions.json", import.meta.url), "utf8"),
  );
  const observations = [
    ...reconcileRoadSnapshots([parseDatexSnapshot(ndwXml, ndw)]).observations,
    ...reconcileRoadSnapshots([
      parseDigitrafficSnapshot(dtJson, fintraffic, { fetchedAt: "2026-09-12T07:14:00.000Z" }),
    ]).observations,
  ];
  return observations
    .map((o) => (o as { restrictionDetails?: unknown }).restrictionDetails)
    .filter(isRoadRestrictionDetails);
}

describe("restrictionEffects", () => {
  const all = envelopes();

  it("has a kernel issue code for every restriction issue code", () => {
    for (const code of RESTRICTION_ISSUE_CODES) expect(CORE_ISSUE_CODES).toContain(code);
  });

  it("finds restriction envelopes in both source fixtures", () => {
    const sources = new Set(all.map((d) => d.source.sourceId));
    expect(sources).toEqual(new Set(["nl-ndw", "fi-digitraffic"]));
  });

  it("maps every envelope onto kernel effects that pass hard validation", () => {
    for (const details of all) {
      for (const { effect } of restrictionEffects(details, { kind: "closure", scope: "road" })) {
        const parsed = kernel.Effect.safeParse(effect);
        expect(parsed.success, `${effect.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    }
  });

  it("accounts for every fact and every issue", () => {
    for (const details of all) {
      const effects = restrictionEffects(details, { kind: "closure", scope: "road" }).map(
        (p) => p.effect,
      );
      const limits = details.facts.filter((f) => f.meaning === "maximum_permitted").length;
      const scopesWithConditions = new Set(
        details.facts
          .filter((f) => f.meaning === "event_applies_when")
          .map((f) => `${f.scope.kind}:${f.scope.phaseId}`),
      ).size;
      const expected = limits + scopesWithConditions || 1;
      expect(effects).toHaveLength(expected);
      const carried = new Set(
        effects.flatMap((e) => (e.issues ?? []).map((i) => `${i.code}@${i.sourcePath}`)),
      );
      for (const issue of details.issues)
        expect(carried).toContain(`${issue.code}@${issue.sourcePath}`);
      if (details.completeness === "partial") {
        expect(effects.every((e) => e.normalization !== "complete")).toBe(true);
      }
      expect(new Set(effects.map((e) => e.id)).size).toBe(effects.length);
    }
  });

  it("turns a phase weight limit into a dimension_limit in its phase", () => {
    const [placed] = restrictionEffects(restrictionDetails(), { kind: "closure", scope: "road" });
    expect(placed).toMatchObject({
      phaseId: "GUID50469933",
      effect: {
        id: "GUID50465935/dimension_limit",
        kind: "dimension_limit",
        dimension: "gross_weight",
        value: { value: 26000, unit: "kg" },
        operator: "lte",
        applicability: { kind: "all" },
        direction: { value: "both", basis: "road_reference" },
        validity: { start: "2026-07-19T21:00:00.000Z", end: "2026-12-14T21:59:59.999Z" },
        normalization: "complete",
      },
    });
  });

  it("turns applies-when conditions into the base effect's applicability", () => {
    const details = restrictionDetails();
    details.facts = [
      {
        ...details.facts[0]!,
        id: "c1",
        kind: "dimension",
        dimension: "height",
        meaning: "event_applies_when",
        value: 4.5,
        unit: "m",
        operator: "gt",
      },
      {
        ...details.facts[0]!,
        id: "c2",
        kind: "vehicle_class",
        meaning: "event_applies_when",
        value: "truck",
      },
    ] as RoadRestrictionDetailsV1["facts"];
    const [placed] = restrictionEffects(details, { kind: "access", mode: "prohibited" });
    expect(placed!.effect).toMatchObject({
      kind: "access",
      mode: "prohibited",
      applicability: {
        kind: "classes",
        include: [
          {
            class: "truck",
            when: [{ dimension: "height", operator: "gt", value: { value: 4.5, unit: "m" } }],
          },
        ],
      },
    });
  });

  it("keeps an envelope without usable facts as one unsupported effect", () => {
    const details = restrictionDetails();
    details.facts = [];
    details.vehicleScope = "unknown";
    details.completeness = "partial";
    details.issues = [
      { code: "unknown_vehicle", factId: null, sourcePath: "x", sourceText: "tractor" },
    ];
    const effects = restrictionEffects(details, { kind: "closure", scope: "road" });
    expect(effects).toEqual([
      {
        phaseId: null,
        effect: expect.objectContaining({
          id: "GUID50465935/unsupported",
          kind: "unsupported",
          applicability: { kind: "unknown" },
          normalization: "unsupported",
          issues: [{ code: "unknown_vehicle", sourcePath: "x", sourceText: "tractor" }],
        }),
      },
    ]);
    expect(kernel.Effect.safeParse(effects[0]!.effect).success).toBe(true);
  });
});
