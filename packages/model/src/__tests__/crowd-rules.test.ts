import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crowdRulesFor } from "../crowd/rules.js";
import { kernelModule } from "../kernel/module.js";
import { buildRegistry } from "../registry/build.js";
import { defineKind, defineProperty, type RegistryEntry } from "../registry/define.js";
import { crowdRegistry, crowdTestModule } from "./crowd-fixtures.js";

const withEntry = (entry: RegistryEntry) => () =>
  buildRegistry([
    kernelModule,
    { ...crowdTestModule, entries: [...crowdTestModule.entries, entry] },
  ]);

const situation = (crowd: object, extra: object = {}) =>
  defineKind({
    class: "situation",
    code: "probe",
    domain: "roads",
    version: "1.0",
    description: "probe",
    types: { probe: [] },
    details: () => ({}),
    crowd: crowd as never,
    ...extra,
  });

describe("crowd rules", () => {
  it("resolves a kind's rules with defaults, and a type's own lifetime", () => {
    expect(
      crowdRulesFor(crowdRegistry, { class: "situation", kind: "incident", type: "accident" }),
    ).toEqual({
      ttlSec: 1800,
      maxLifetimeSec: 14400,
      corroborationKeys: 2,
      negationKeys: 2,
      matchMetres: 250,
    });
    expect(
      crowdRulesFor(crowdRegistry, { class: "situation", kind: "incident", type: "obstruction" }),
    ).toMatchObject({ ttlSec: 900, maxLifetimeSec: 7200 });
    expect(crowdRulesFor(crowdRegistry, { class: "observation", property: "fuel.price" })).toEqual({
      ttlSec: 10800,
      maxLifetimeSec: 43200,
      corroborationKeys: 2,
      negationKeys: 2,
      tolerance: 0.01,
      reachMetres: 300,
    });
  });

  it("has no rules for what the crowd cannot report", () => {
    expect(
      crowdRulesFor(crowdRegistry, { class: "situation", kind: "restriction", type: "dimension" }),
    ).toBeUndefined();
    expect(
      crowdRulesFor(crowdRegistry, { class: "observation", property: "traffic.speed" }),
    ).toBeUndefined();
  });

  it("refuses rules a report could not live or be judged by", () => {
    expect(withEntry(situation({ ttlSec: 0, maxLifetimeSec: 10 }))).toThrow(/ttlSec/);
    expect(withEntry(situation({ ttlSec: 600, maxLifetimeSec: 300 }))).toThrow(/maxLifetimeSec/);
    expect(withEntry(situation({ ttlSec: 60, maxLifetimeSec: 60, corroborationKeys: 1 }))).toThrow(
      /two distinct reporters/,
    );
    expect(
      withEntry(
        situation({
          ttlSec: 60,
          maxLifetimeSec: 60,
          types: { nonsense: { ttlSec: 60, maxLifetimeSec: 60 } },
        }),
      ),
    ).toThrow(/unregistered type "nonsense"/);
    expect(
      withEntry(
        defineKind({
          class: "feature",
          code: "site",
          domain: "roads",
          version: "1.0",
          description: "a feature",
          details: () => ({}),
          crowd: { ttlSec: 60, maxLifetimeSec: 60 },
        }),
      ),
    ).toThrow(/only situation kinds take crowd reports/);
  });

  it("only lets the crowd report properties it can name a subject of", () => {
    expect(
      withEntry(
        defineProperty({
          code: "traffic.flow",
          domain: "roads",
          version: "1.0",
          description: "segments only",
          result: { type: "count" },
          subjects: [{ kind: "segments" }],
          crowd: { ttlSec: 60, maxLifetimeSec: 60 },
        }),
      ),
    ).toThrow(/about a feature or a location/);
    expect(
      withEntry(
        defineProperty({
          code: "traffic.state",
          domain: "roads",
          version: "1.0",
          description: "a category with a tolerance",
          result: { type: "category", vocabulary: "los" },
          subjects: [{ kind: "location" }],
          crowd: { ttlSec: 60, maxLifetimeSec: 60, agreement: { tolerance: 1 } },
        }),
      ),
    ).toThrow(/quantities and prices/);
    expect(
      withEntry(
        defineProperty({
          code: "traffic.state",
          domain: "roads",
          version: "1.0",
          description: "crowd rows never fuse",
          result: { type: "category", vocabulary: "los" },
          subjects: [{ kind: "location" }],
          fusionTiers: ["authoritative"],
          crowd: { ttlSec: 60, maxLifetimeSec: 60 },
        }),
      ),
    ).toThrow(/fuses crowd rows/);
  });

  it("checks component identities against the kind's details and the id schemes", () => {
    const component = (identity: object) =>
      defineKind({
        class: "component",
        code: "probe_part",
        version: "1.0",
        description: "probe",
        details: () => ({ grade: z.string() }),
        identity: identity as never,
      });
    expect(withEntry(component({}))).toThrow(/names id schemes or fields/);
    expect(withEntry(component({ fields: ["colour"] }))).toThrow(/"colour" is not a detail/);
    expect(withEntry(component({ idSchemes: ["no:such"] }))).toThrow(/external_id_scheme/);
    expect(withEntry(component({ fields: ["grade"], withinParent: true }))).toThrow(
      /needs id schemes/,
    );
    expect(withEntry(component({ fields: ["grade"] }))).not.toThrow();
  });
});
