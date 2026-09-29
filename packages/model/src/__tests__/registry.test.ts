import { describe, expect, it } from "vitest";
import { z } from "zod";
import { kernelModule } from "../kernel/module.js";
import { buildRegistry, RegistryError } from "../registry/build.js";
import {
  defineChangeKind,
  defineDomain,
  defineKind,
  defineProperty,
  extendVocabulary,
} from "../registry/define.js";
import {
  closure,
  draftBase,
  incidentDraft,
  registry,
  stored,
  testModule,
  withObservationId,
} from "./fixtures.js";

const issueCodes = (r: { ok: boolean; issues?: { code: string }[] }) =>
  r.ok ? [] : r.issues!.map((i) => i.code);
const issuePaths = (r: { ok: boolean; issues?: { path: (string | number)[] }[] }) =>
  r.ok ? [] : r.issues!.map((i) => i.path.join("."));

describe("buildRegistry", () => {
  it("merges vocabulary extensions and records who contributed each value", () => {
    const formats = registry.vocabulary("source_format")!;
    expect(formats.values).toEqual(["crowd", "derived", "datex2"]);
    expect(formats.contributedBy["datex2"]).toBe("test");
  });

  it.each([
    [
      "an extension of a closed vocabulary",
      [extendVocabulary({ vocabulary: "road_class", values: ["autobahn"] })],
      /closed vocabulary "road_class"/,
    ],
    [
      "a duplicate vocabulary value",
      [extendVocabulary({ vocabulary: "source_format", values: ["crowd"] })],
      /already contributed by kernel/,
    ],
    [
      "a kind in an unknown domain",
      [
        defineKind({
          class: "offer",
          code: "fare",
          domain: "maritime",
          version: "1.0",
          description: "x",
        }),
      ],
      /unknown domain "maritime"/,
    ],
    [
      "a situation kind without types",
      [
        defineDomain({ code: "roads", description: "x" }),
        defineKind({
          class: "situation",
          code: "other",
          domain: "roads",
          version: "1.0",
          description: "x",
          details: () => ({}),
        }),
      ],
      /declare their types/,
    ],
    [
      "a property over an unknown vocabulary",
      [
        defineDomain({ code: "roads", description: "x" }),
        defineProperty({
          code: "x.state",
          domain: "roads",
          version: "1.0",
          description: "x",
          result: { type: "category", vocabulary: "nope" },
          subjects: [{ kind: "location" }],
        }),
      ],
      /unknown vocabulary "nope"/,
    ],
    [
      "a malformed version",
      [
        defineKind({
          class: "offer",
          code: "fare",
          domain: "roads",
          version: "1" as "1.0",
          description: "x",
        }),
      ],
      /not major\.minor/,
    ],
    [
      "a change kind with a reserved code",
      [
        defineChangeKind({
          code: "created",
          description: "x",
          classes: ["situation"],
          select: () => null,
        }),
      ],
      /"created" is reserved/,
    ],
    [
      "a severity rule on a feature kind",
      [
        defineDomain({ code: "roads", description: "x" }),
        defineKind({
          class: "feature",
          code: "camera",
          domain: "roads",
          version: "1.0",
          description: "x",
          details: () => ({}),
          deriveSeverity: () => "minor",
        }),
      ],
      /only situation kinds derive severity/,
    ],
    [
      "a type mapping for an unregistered subtype",
      [
        defineDomain({ code: "roads", description: "x" }),
        defineKind({
          class: "situation",
          code: "incident",
          domain: "roads",
          version: "1.0",
          description: "x",
          types: { accident: [] },
          details: () => ({}),
          typeMappings: { "accident.overturned": { datex2_v3: ["Accident:overturnedVehicle"] } },
        }),
      ],
      /"accident\.overturned" is not a registered type/,
    ],
    [
      "an unregistered feature trait",
      [
        defineDomain({ code: "roads", description: "x" }),
        defineKind({
          class: "feature",
          code: "camera",
          domain: "roads",
          version: "1.0",
          description: "x",
          details: () => ({}),
          traits: ["flying"],
        }),
      ],
      /"flying" is not a registered feature_trait/,
    ],
    [
      "a trait on a component kind",
      [
        defineKind({
          class: "component",
          code: "lens",
          version: "1.0",
          description: "x",
          details: () => ({}),
          traits: ["field_device"],
        }),
      ],
      /only feature kinds have traits/,
    ],
    [
      "a histogram rollup of a category",
      [
        defineDomain({ code: "roads", description: "x" }),
        defineProperty({
          code: "x.state",
          domain: "roads",
          version: "1.0",
          description: "x",
          result: { type: "category", vocabulary: "los" },
          subjects: [{ kind: "location" }],
          retention: { rollup: { period: "hourly", histogram: { binWidth: 2 } } },
        }),
      ],
      /category results have no rollup/,
    ],
    [
      "a latest-only property with history",
      [
        defineDomain({ code: "roads", description: "x" }),
        defineProperty({
          code: "x.image",
          domain: "roads",
          version: "1.0",
          description: "x",
          result: { type: "text" },
          subjects: [{ kind: "location" }],
          retention: { latestOnly: true, rawDays: 1 },
        }),
      ],
      /latest-only property keeps no history/,
    ],
  ])("rejects %s", (_label, entries, message) => {
    expect(() => buildRegistry([kernelModule, { name: "bad", entries }])).toThrow(message);
  });

  it("accepts crosswalks on a closed vocabulary but no new values", () => {
    const mapped = buildRegistry([
      kernelModule,
      {
        name: "crosswalks",
        entries: [
          extendVocabulary({
            vocabulary: "severity",
            values: [],
            valueMappings: { major: { open511: ["MAJOR"] } },
          }),
        ],
      },
    ]);
    expect(mapped.crosswalk.value("severity", "open511", "MAJOR")).toBe("major");
  });

  it("ships the shared infrastructure building blocks in the kernel", () => {
    const kernelOnly = buildRegistry([kernelModule]);
    expect(kernelOnly.kind("component", "sensor_channel")).toBeDefined();
    expect(kernelOnly.vocabulary("surface_state")?.extensible).toBe(false);
    expect(kernelOnly.vocabulary("feature_trait")?.values).toEqual([
      "field_device",
      "weather_sensing",
      "operated_site",
    ]);
  });

  it("rejects a duplicate module name", () => {
    expect(() => buildRegistry([kernelModule, testModule, testModule])).toThrow(RegistryError);
  });
});

describe("validate", () => {
  it("accepts a stored situation and a draft of it", () => {
    const draft = incidentDraft();
    expect(registry.validateDraft(draft)).toMatchObject({ ok: true });
    expect(registry.validate(stored(draft))).toMatchObject({ ok: true });
  });

  it("rejects a draft that asserts derived fields", () => {
    const draft = { ...incidentDraft(), canonicalId: "0".repeat(64) };
    expect(issuePaths(registry.validateDraft(draft))).toContain("canonicalId");
    const withInstance = incidentDraft();
    (withInstance.provenance as Record<string, unknown>)["instanceId"] = "local";
    expect(issuePaths(registry.validateDraft(withInstance))).toContain("provenance.instanceId");
  });

  it("dispatches on kind and reports unknown kinds and versions", () => {
    expect(issueCodes(registry.validate({ ...stored(incidentDraft()), kind: "nope" }))).toEqual([
      "unknown_kind",
    ]);
    const v2 = stored({ ...incidentDraft(), details: { kind: "incident", v: 2 } });
    expect(issueCodes(registry.validate(v2))).toEqual(["unsupported_version"]);
    expect(issueCodes(registry.validate({ class: "event" }))).toEqual(["unknown_class"]);
  });

  it("closes type and subtype per kind", () => {
    expect(issuePaths(registry.validate(stored({ ...incidentDraft(), type: "fire" })))).toContain(
      "type",
    );
    expect(
      issuePaths(registry.validate(stored({ ...incidentDraft(), subtype: "jackknifed" }))),
    ).toContain("subtype");
  });

  it("rejects unknown keys anywhere (strict)", () => {
    const extra = { ...incidentDraft(), details: { kind: "incident", v: 1, colour: "red" } };
    expect(issueCodes(registry.validateDraft(extra))).toContain("unrecognized_keys");
  });

  it("ties severity.source to a known label", () => {
    const unknownWithSource = {
      ...incidentDraft(),
      severity: { label: "unknown", source: "derived" },
    };
    expect(issuePaths(registry.validateDraft(unknownWithSource))).toContain("severity.source");
    const knownWithout = { ...incidentDraft(), severity: { label: "minor" } };
    expect(issuePaths(registry.validateDraft(knownWithout))).toContain("severity.source");
    expect(
      registry.validateDraft({ ...incidentDraft(), severity: { label: "unknown" } }),
    ).toMatchObject({ ok: true });
  });

  it("checks the stored canonical id and domain against the id and kind", () => {
    const rec = stored(incidentDraft());
    expect(issuePaths(registry.validate({ ...rec, canonicalId: "f".repeat(64) }))).toContain(
      "canonicalId",
    );
    expect(issuePaths(registry.validate({ ...rec, domain: "fuel" }))).toContain("domain");
    expect(issuePaths(registry.validate({ ...rec, id: "oc:feature:de-ndw:SIT-1" }))).toContain(
      "id",
    );
  });

  it("keeps effect ids unique across top-level and nested phase effects", () => {
    const works = {
      ...draftBase("situation", "W-1"),
      class: "situation",
      kind: "roadworks",
      type: "works",
      planned: true,
      certainty: "observed",
      severity: { label: "unknown" },
      validity: { status: "planned" },
      effects: [closure("W-1/closure")],
      details: {
        kind: "roadworks",
        v: 1,
        phases: [{ id: "p1", validity: { status: "planned" }, effects: [closure("W-1/closure")] }],
      },
    };
    expect(registry.validateDraft(works)).toMatchObject({ ok: false });
    works.details.phases[0]!.effects[0]!.id = "W-1/p1/closure";
    expect(registry.validateDraft(works)).toMatchObject({ ok: true });
  });

  it("validates feature components against the kinds the feature allows", () => {
    const site = {
      ...draftBase("feature", "SITE-1"),
      class: "feature",
      kind: "measurement_site",
      type: "traffic",
      lifecycle: "operational",
      components: [
        {
          key: "1",
          kind: "sensor_channel",
          details: { kind: "sensor_channel", v: 1, index: 1, property: "traffic.speed" },
        },
        {
          key: "1a",
          parentKey: "1",
          kind: "sensor_channel",
          details: { kind: "sensor_channel", v: 1, index: 2, property: "traffic.speed" },
        },
      ],
      details: { kind: "measurement_site", v: 1, measuredProperties: ["traffic.speed"] },
    };
    expect(registry.validateDraft(site)).toMatchObject({ ok: true });
    site.components.push({
      key: "2",
      parentKey: "1a",
      kind: "sensor_channel",
      details: { kind: "sensor_channel", v: 1, index: 3, property: "traffic.speed" },
    });
    expect(issuePaths(registry.validateDraft(site))).toContain("components.2.parentKey");
  });

  it("narrows an observation result to the property's declared form", () => {
    const speed = withObservationId({
      ...draftBase("observation", "S-1:speed"),
      class: "observation",
      kind: "observation",
      property: "traffic.speed",
      subject: { kind: "feature", featureId: "oc:feature:de-ndw:SITE-1", componentKey: "1" },
      result: { type: "quantity", value: 87, unit: "km/h" },
      phenomenonTime: { instant: "2026-09-18T09:59:00Z" },
      aggregation: "mean",
    });
    expect(registry.validateDraft(speed)).toMatchObject({ ok: true });
    expect(
      registry.validateDraft({ ...speed, result: { type: "quantity", value: 24, unit: "m/s" } }),
    ).toMatchObject({ ok: false });
    expect(registry.validateDraft({ ...speed, result: { type: "unknown" } })).toMatchObject({
      ok: true,
    });
    expect(registry.validateDraft({ ...speed, subject: { kind: "location" } })).toMatchObject({
      ok: false,
    });
    expect(registry.validateDraft({ ...speed, qualifiers: { lane: 1 } })).toMatchObject({
      ok: false,
    });
    expect(registry.validateDraft({ ...speed, temporality: "forecast" })).toMatchObject({
      ok: false,
    });
  });

  it("closes category results over the vocabulary and structured results over their schema", () => {
    const los = withObservationId({
      ...draftBase("observation", "S-1:los"),
      class: "observation",
      kind: "observation",
      property: "traffic.los",
      subject: { kind: "feature", featureId: "oc:feature:de-ndw:SITE-1" },
      result: { type: "category", value: "queuing", vocabulary: "los" },
      phenomenonTime: { instant: "2026-09-18T09:59:00Z" },
      aggregation: "instantaneous",
    });
    expect(registry.validateDraft(los)).toMatchObject({ ok: true });
    expect(
      registry.validateDraft({ ...los, result: { ...los.result, value: "jammed" } }),
    ).toMatchObject({ ok: false });
    const wait = withObservationId({
      ...los,
      property: "border.wait",
      result: { type: "structured", schema: "border_wait", v: 1, value: { v: 1, waitMinutes: 20 } },
    });
    expect(registry.validateDraft(wait)).toMatchObject({ ok: true });
    expect(registry.validateDraft({ ...wait, result: { ...wait.result, v: 2 } })).toMatchObject({
      ok: false,
    });
  });

  it("requires an identifiable location for location-subject observations", () => {
    const price = withObservationId({
      ...draftBase("observation", "PADD1:e5"),
      class: "observation",
      kind: "observation",
      property: "fuel.price",
      subject: { kind: "location" },
      qualifiers: { product: "e5" },
      result: { type: "money", amount: "1.799", currency: "EUR", per: "L" },
      phenomenonTime: { instant: "2026-09-18T09:00:00Z" },
      aggregation: "mean",
    });
    expect(registry.validateDraft(price)).toMatchObject({ ok: true });
    const { qualifiers: _q, ...unqualified } = price;
    expect(issuePaths(registry.validateDraft(unqualified))).toContain("qualifiers");
    const nowhere = {
      ...price,
      location: { geometry: null, extent: "area", geometryOrigin: "none", fuzziness: "exact" },
    };
    expect(issuePaths(registry.validateDraft(nowhere))).toContain("location");
  });

  it("keeps every money in an offer in the offer's currency", () => {
    const toll = {
      ...draftBase("offer", "T-1"),
      class: "offer",
      kind: "toll",
      subject: { class: "feature", id: "oc:feature:de-ndw:TS-1" },
      currency: "EUR",
      elements: [{ components: [{ type: "flat", price: { amount: "2.50", currency: "EUR" } }] }],
      validity: { status: "active" },
    };
    expect(registry.validateDraft(toll)).toMatchObject({ ok: true });
    toll.elements[0]!.components[0]!.price.currency = "USD";
    expect(issuePaths(registry.validateDraft(toll))).toContain(
      "elements.0.components.0.price.currency",
    );
  });
});

describe("recordSchema", () => {
  it("returns undefined for unregistered codes and caches per stage", () => {
    expect(registry.recordSchema("situation", "nope", "stored")).toBeUndefined();
    expect(registry.recordSchema("situation", "incident", "stored")).toBe(
      registry.recordSchema("situation", "incident", "stored"),
    );
    expect(registry.recordSchema("situation", "incident", "draft")).not.toBe(
      registry.recordSchema("situation", "incident", "stored"),
    );
    expect(registry.recordSchema("situation", "incident", "stored")).toBeInstanceOf(z.ZodType);
  });
});

describe("linking rules", () => {
  const site = (linking: Record<string, unknown>) =>
    defineKind({
      class: "feature",
      code: "linked_site",
      domain: "roads",
      version: "1.0",
      description: "a kind with linking rules",
      details: () => ({}),
      linking: linking as never,
    });
  const build = (linking: Record<string, unknown>) =>
    buildRegistry([kernelModule, testModule, { name: "linking-test", entries: [site(linking)] }]);
  const sane = { idSchemes: ["ocpi:location"], alwaysMetres: 20, neverMetres: 150, attribute: {} };

  it("accepts a window a match can fall in", () => {
    expect(build(sane).kind("feature", "linked_site")?.linking?.alwaysMetres).toBe(20);
  });

  it("rejects a window with no room between its bounds", () => {
    expect(() => build({ ...sane, alwaysMetres: 200 })).toThrow(RegistryError);
    expect(() => build({ ...sane, alwaysMetres: 0 })).toThrow(RegistryError);
  });

  it("rejects an id scheme nothing registers", () => {
    expect(() => build({ ...sane, idSchemes: ["made:up"] })).toThrow(RegistryError);
  });

  it("rejects a similarity outside the unit interval", () => {
    expect(() => build({ ...sane, attribute: { name: 1.5 } })).toThrow(RegistryError);
  });

  it("rejects a pending threshold that is not below the accepting one", () => {
    expect(() =>
      build({ ...sane, attribute: { name: 0.5 }, pendingAttribute: { name: 0.5 } }),
    ).toThrow(RegistryError);
  });

  it("rejects an OSM filter that is not a tag", () => {
    expect(() => build({ ...sane, osm: { tags: ["amenity"] } })).toThrow(RegistryError);
  });

  it("rejects linking rules on anything but a feature kind", () => {
    expect(() =>
      buildRegistry([
        kernelModule,
        testModule,
        {
          name: "linking-test",
          entries: [
            defineKind({
              class: "component",
              code: "linked_part",
              version: "1.0",
              description: "a component with linking rules",
              details: () => ({}),
              linking: sane as never,
            }),
          ],
        },
      ]),
    ).toThrow(RegistryError);
  });
});
