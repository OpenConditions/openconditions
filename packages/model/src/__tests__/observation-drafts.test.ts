import { describe, expect, it } from "vitest";
import { contentHash, contentHasher } from "../content-hash.js";
import type { ValidationResult } from "../registry/build.js";
import { observationSealer, sealRecord } from "../registry/seal.js";
import { draftBase, registry, withObservationId } from "./fixtures.js";

type Rec = Record<string, unknown>;

const location = () => ({
  geometry: { type: "Point", coordinates: [4.9, 52.37] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
});
const attribution = () => ({ provider: "NDW", license: "CC0-1.0" });

function speed(local: string, over: Rec = {}, provenance: Rec = {}): Rec {
  const base = draftBase("observation", local);
  return withObservationId({
    ...base,
    class: "observation",
    kind: "observation",
    property: "traffic.speed",
    subject: { kind: "feature", featureId: `oc:feature:de-ndw:${local}`, componentKey: "1" },
    result: { type: "quantity", value: 87, unit: "km/h" },
    phenomenonTime: { instant: "2026-09-18T09:59:00Z" },
    aggregation: "mean",
    provenance: { ...base.provenance, ...provenance },
    ...over,
  }) as Rec;
}

const los = (value: string) =>
  withObservationId({
    ...draftBase("observation", "S-1:los"),
    class: "observation",
    kind: "observation",
    property: "traffic.los",
    subject: { kind: "feature", featureId: "oc:feature:de-ndw:SITE-1" },
    result: { type: "category", value, vocabulary: "los" },
    phenomenonTime: { instant: "2026-09-18T09:59:00Z" },
    aggregation: "instantaneous",
  }) as Rec;

const price = (over: Rec = {}) =>
  withObservationId({
    ...draftBase("observation", "PADD1:e5"),
    class: "observation",
    kind: "observation",
    property: "fuel.price",
    subject: { kind: "location" },
    qualifiers: { product: "e5" },
    result: { type: "money", amount: "1.799", currency: "EUR", per: "L" },
    phenomenonTime: { instant: "2026-09-18T09:00:00Z" },
    aggregation: "mean",
    ...over,
  }) as Rec;

/**
 * Drafts of every outcome the draft validator has: valid ones, in parser key
 * orders that differ from the schema's, and one of each way it rejects. Some
 * share a location or an attribution, as a site's readings and a feed's
 * readings do, valid or not.
 */
function cases(): [string, unknown][] {
  const sharedLocation = location();
  const sharedAttribution = attribution();
  const badAttribution = { license: "CC0-1.0" };
  const badLocation = { ...location(), geometry: { type: "Point", coordinates: [4.9] } };
  const reordered = speed(
    "S-2",
    {
      location: {
        fuzziness: "exact",
        geometryOrigin: "source",
        extent: "point",
        geometry: { coordinates: [4.9, 52.37], type: "Point" },
      },
    },
    { attribution: { license: "CC0-1.0", provider: "NDW" } },
  );
  const proto = Object.assign(Object.create({ inherited: true }), speed("S-3")) as Rec;
  return [
    ["a speed", speed("S-1")],
    ["a speed sharing a site's location", speed("S-4", { location: sharedLocation })],
    ["another speed at that site", speed("S-5", { location: sharedLocation })],
    [
      "a speed sharing the feed's attribution",
      speed("S-6", {}, { attribution: sharedAttribution }),
    ],
    ["another speed of that feed", speed("S-7", {}, { attribution: sharedAttribution })],
    ["a speed whose parts are in another key order", reordered],
    ["a speed stating an absent optional field", speed("S-8", { quality: undefined })],
    [
      "a speed with quality and baseline",
      speed("S-9", {
        quality: { sampleCount: 3, trend: "rising" },
        baseline: { source: "native", ratio: 0.8 },
      }),
    ],
    [
      "a speed with upstream publishers",
      speed("S-10", {}, { upstream: [{ publisher: "Upstream", recordId: "u1" }] }),
    ],
    ["a level of service", los("queuing")],
    ["a price about a location", price()],
    ["an unknown result", speed("S-11", { result: { type: "unknown" } })],
    ["not an object", null],
    ["an array", [speed("S-12")]],
    ["a string", "observation"],
    ["no class", { ...speed("S-13"), class: undefined }],
    ["an unknown class", { ...speed("S-14"), class: "reading" }],
    ["an unknown property", { ...speed("S-15"), property: "traffic.unknown" }],
    ["a property that is not a string", { ...speed("S-16"), property: 7 }],
    ["an inherited key", proto],
    ["an unrecognized key", { ...speed("S-17"), colour: "red" }],
    ["a derived field", { ...speed("S-18"), contentHash: "0".repeat(64) }],
    ["no location", { ...speed("S-19"), location: undefined }],
    ["a location that is not an object", speed("S-20", { location: "here" })],
    ["a malformed location", speed("S-21", { location: badLocation })],
    ["another reading at that malformed location", speed("S-22", { location: badLocation })],
    [
      "a malformed location of a malformed reading",
      speed("S-23", { location: badLocation, aggregation: "mode" }),
    ],
    [
      "a shared location in an otherwise malformed reading",
      speed("S-24", { location: sharedLocation, aggregation: "mode" }),
    ],
    ["no provenance", { ...speed("S-25"), provenance: undefined }],
    ["provenance as an array", { ...speed("S-26"), provenance: [] }],
    ["no attribution", speed("S-27", {}, { attribution: undefined })],
    ["an attribution that is not an object", speed("S-28", {}, { attribution: "NDW" })],
    ["a malformed attribution", speed("S-29", {}, { attribution: badAttribution })],
    [
      "another reading with that malformed attribution",
      speed("S-30", {}, { attribution: badAttribution }),
    ],
    [
      "an attribution with an unknown key",
      speed("S-31", {}, { attribution: { ...attribution(), note: "x" } }),
    ],
    [
      "an attribution holding a date",
      speed("S-32", {}, { attribution: { provider: new Date(0), license: "CC0-1.0" } }),
    ],
    [
      "the feed's attribution in a malformed reading",
      speed("S-33", { aggregation: "mode" }, { attribution: sharedAttribution }),
    ],
    ["a feed source id that is not a source id", speed("S-34", {}, { sourceId: "De_NDW" })],
    ["an instance id in a draft", speed("S-35", {}, { instanceId: "local" })],
    ["a malformed raw reference", speed("S-36", {}, { rawRef: { hash: "abc" } })],
    ["malformed upstream publishers", speed("S-37", {}, { upstream: [] })],
    [
      "a result in another unit",
      speed("S-38", { result: { type: "quantity", value: 24, unit: "m/s" } }),
    ],
    ["a category outside its vocabulary", los("jammed")],
    ["a subject the property does not take", speed("S-39", { subject: { kind: "location" } })],
    ["qualifiers the property does not declare", speed("S-40", { qualifiers: { lane: 1 } })],
    ["an id that does not name its point", { ...speed("S-41"), id: "oc:observation:de-ndw:other" }],
    ["an id of another class", { ...speed("S-42"), id: "oc:feature:de-ndw:S-42" }],
    ["a malformed id", { ...speed("S-43"), id: "S-43" }],
    ["a forecast temporality without a forecast", speed("S-44", { temporality: "forecast" })],
    [
      "a period that ends before it starts",
      speed("S-45", {
        phenomenonTime: { start: "2026-09-18T10:00:00Z", end: "2026-09-18T09:00:00Z" },
      }),
    ],
    ["a malformed instant", { ...speed("S-46"), phenomenonTime: { instant: "yesterday" } }],
    ["an on-demand reading without an expiry", speed("S-47", {}, { accessMode: "on_demand" })],
    [
      "a location subject without a key",
      {
        ...price(),
        location: { geometry: null, extent: "none", geometryOrigin: "none", fuzziness: "exact" },
      },
    ],
    ["a quality out of range", speed("S-48", { quality: { confidence: 2 } })],
  ];
}

/** What validating or sealing gives, or what it throws (a malformed instant throws). */
function outcome(run: () => ValidationResult): ValidationResult | { threw: string } {
  try {
    return run();
  } catch (err) {
    return { threw: String(err) };
  }
}

describe("observation drafts validated once per shared part", () => {
  it("accepts and rejects every draft as the draft validator does, with the same value or issues", () => {
    const validate = registry.observationDraftValidator();
    const outcomes = new Set<string>();
    for (const [what, draft] of cases()) {
      const expected = outcome(() => registry.validateDraft(draft));
      const actual = outcome(() => validate(draft));
      outcomes.add("threw" in expected ? "threw" : String(expected.ok));
      expect(actual, what).toEqual(expected);
      expect(JSON.stringify(actual), what).toBe(JSON.stringify(expected));
    }
    expect(outcomes).toEqual(new Set(["true", "false", "threw"]));
  });

  it("decides each draft alone, whichever drafts sharing its parts came before it", () => {
    const validate = registry.observationDraftValidator();
    for (const [what, draft] of cases().reverse()) {
      expect(JSON.stringify(outcome(() => validate(draft))), what).toBe(
        JSON.stringify(outcome(() => registry.validateDraft(draft))),
      );
    }
  });

  it("hashes each draft and each sealed record as contentHash does, or throws as it does", () => {
    const hash = contentHasher();
    const opts = { instanceId: "local", revision: 1, recordedAt: "2026-09-18T10:00:05Z" };
    const sealedLocation = { ...location(), admin: { country: "NL" } };
    const odd: [string, unknown][] = [
      [
        "a location holding NaN",
        speed("S-90", { location: { ...location(), elevationM: Number.NaN } }),
      ],
      [
        "an attribution with a lone surrogate",
        speed("S-91", {}, { attribution: { provider: "\uD800", license: "x" } }),
      ],
      ["an unclassified key", { ...speed("S-92"), colour: "red" }],
      ["an unclassified provenance key", speed("S-93", {}, { colour: "red" })],
      ["a location dropped by toJSON", speed("S-94", { location: { toJSON: () => undefined } })],
      ["a location that is a string", speed("S-95", { location: "here" })],
      [
        "an attribution of functions and symbols",
        speed("S-96", {}, { attribution: { f: () => 1, s: Symbol("s"), u: undefined, n: null } }),
      ],
      ["a shared sealed location", { ...speed("S-97", { location: sealedLocation }), revision: 1 }],
      [
        "the same sealed location again",
        { ...speed("S-98", { location: sealedLocation }), revision: 2 },
      ],
    ];
    let hashed = 0;
    for (const [what, draft] of [...cases(), ...odd]) {
      const records = [draft];
      const sealed = outcome(() => sealRecord(registry, draft, opts));
      if ("ok" in sealed && sealed.ok) records.push(sealed.value);
      for (const record of records) {
        const run = (fn: (r: Record<string, unknown>) => string) => {
          try {
            return fn(record as Record<string, unknown>);
          } catch (err) {
            return `threw ${String(err)}`;
          }
        };
        const expected = run(contentHash);
        if (!expected.startsWith("threw")) hashed++;
        expect(run(hash), what).toBe(expected);
      }
    }
    expect(hashed).toBeGreaterThan(20);
  });

  it("seals each draft into the very record sealRecord does", () => {
    const opts = { instanceId: "local", revision: 1, recordedAt: "2026-09-18T10:00:05Z" };
    const seal = observationSealer(registry, opts);
    let sealed = 0;
    for (const [what, draft] of cases()) {
      const expected = outcome(() => sealRecord(registry, draft, opts));
      expect(JSON.stringify(outcome(() => seal(draft))), what).toBe(JSON.stringify(expected));
      if ("ok" in expected && expected.ok) {
        sealed++;
        const hash = expected.value["contentHash"] as string;
        expect(JSON.stringify(seal(draft, hash)), what).toBe(JSON.stringify(expected));
      }
    }
    expect(sealed).toBeGreaterThan(5);
  });
});
