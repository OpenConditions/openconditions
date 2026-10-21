import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AWKWARD_TEXT } from "@openconditions/conformance";
import { type Registry, sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import fc from "fast-check";

type Rec = Record<string, unknown>;
type Schema = Rec;

/**
 * Random situations the model accepts, for the exporters: every situation
 * kind, type and subtype and every effect the registry holds, their fields'
 * enumerations as the model's published JSON Schemas list them, and text,
 * language tags, times and coordinates at the edges of what the model
 * allows. A candidate the registry rejects as a draft is dropped, so every
 * situation an exporter sees is one a parser could have written.
 */

const SCHEMAS = join(import.meta.dirname, "..", "..", "..", "model-registry", "schemas");
const schemaFile = (path: string): Schema =>
  JSON.parse(readFileSync(join(SCHEMAS, path), "utf8")) as Schema;

/** Text the model allows (at least one character) that is hard on whatever re-encodes it. */
const TEXTS = [
  ...AWKWARD_TEXT.filter((t) => t.length > 0),
  "Bauarbeiten A 46",
  String.fromCharCode(0x01, 0x08, 0x0b, 0x0c, 0x1f),
  String.fromCharCode(0xd800, 0xdbff, 0xdc00, 0xdfff),
  String.fromCharCode(0x61, 0xfffe, 0x62, 0xffff),
  String.fromCharCode(0xe9).repeat(1025),
  String.fromCodePoint(0x1f600).repeat(600),
];

const text = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TEXTS) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 30 }) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 20 }) },
);

/** Language tags the model's pattern allows, the odd and the long among them. */
const LANGUAGES = [
  "de",
  "en",
  "EN",
  "fr-CA",
  "zh-Hant-TW",
  "sr-Latn-RS",
  "de-DE-u-co-phonebk",
  "und",
  "mul",
  "zxx",
  "gsw",
  "en-GB-oxendict-x-private",
  `de-${Array.from({ length: 20 }, () => "abcdefgh").join("-")}`,
] as const;

const localised = fc.array(fc.record({ lang: fc.constantFrom(...LANGUAGES), text }), {
  minLength: 1,
  maxLength: 3,
});

/** Instants the model's date-time pattern allows, with and without fractions and offsets. */
const INSTANTS = [
  "2026-09-06T08:00:00Z",
  "2026-09-06T09:59:59.999Z",
  "2026-09-06T10:00:00Z",
  "2026-09-06T12:00:00+02:00",
  "2026-09-06T03:00:00-12:00",
  "2026-09-06T23:30:00+14:00",
  "2026-09-07T08:00:00.123456789Z",
  "2024-02-29T00:00:00Z",
  "1970-01-01T00:00:00Z",
  "0001-01-01T00:00:00Z",
  "9999-12-31T23:59:59Z",
  "9999-12-31T23:59:59-12:00",
] as const;

const instant = fc.constantFrom(...INSTANTS);
const ms = (t: string) => Date.parse(t);

const longitude = fc.oneof(
  fc.constantFrom(180, -180, 0, -0, 179.9999999, -179.9999999, 1e-7, -1e-7, 5e-324),
  fc.double({ min: -180, max: 180, noNaN: true }),
);
const latitude = fc.oneof(
  fc.constantFrom(90, -90, 0, -0, 89.9999999, -89.9999999, 1e-7, 5e-324),
  fc.double({ min: -90, max: 90, noNaN: true }),
);
const height = fc.oneof(fc.constantFrom(0, -11_000, 8_848, 1e308, -1e308), fc.integer());
const position = fc.oneof(
  { weight: 4, arbitrary: fc.tuple(longitude, latitude) },
  { weight: 1, arbitrary: fc.tuple(longitude, latitude, height) },
);

/** A position near another: lines from a millimetre long to across the antimeridian. */
const nearby = (p: number[], step: number) =>
  fc
    .tuple(
      fc.double({ min: -step, max: step, noNaN: true }),
      fc.double({ min: -step, max: step, noNaN: true }),
    )
    .map(([dx, dy]) => {
      let lon = p[0]! + dx;
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      const lat = Math.max(-90, Math.min(90, p[1]! + dy));
      return p.length > 2 ? [lon, lat, p[2]!] : [lon, lat];
    });

const lineFrom = (min: number) =>
  fc
    .tuple(position, fc.constantFrom(1e-8, 0.01, 1, 20, 179), fc.integer({ min, max: 6 }))
    .chain(([start, step, n]) =>
      fc.array(nearby(start, step), { minLength: n - 1, maxLength: n - 1 }).map((rest) => {
        const out: number[][] = [start];
        // Each step from the one before, so a line walks rather than jumps.
        for (const r of rest) {
          const prev = out[out.length - 1]!;
          const lon = prev[0]! + (r[0]! - start[0]!);
          out.push([lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon, r[1]!, ...r.slice(2)]);
        }
        return out;
      }),
    );

/** A small star-shaped ring round a centre, closed, in either winding. */
const ring = fc
  .tuple(
    fc.tuple(longitude, fc.double({ min: -85, max: 85, noNaN: true })),
    fc.constantFrom(1e-6, 0.01, 1, 4),
    fc.integer({ min: 3, max: 8 }),
    fc.boolean(),
  )
  .map(([[lon, lat], r, n, clockwise]) => {
    const pts = Array.from({ length: n }, (_, i) => {
      const a = ((clockwise ? -1 : 1) * 2 * Math.PI * i) / n;
      let x = lon + r * Math.cos(a);
      if (x > 180) x -= 360;
      if (x < -180) x += 360;
      return [x, lat + r * Math.sin(a)];
    });
    return [...pts, [...pts[0]!]];
  });

const point = position.map((coordinates) => ({ type: "Point", coordinates }));
const lineString = lineFrom(2).map((coordinates) => ({ type: "LineString", coordinates }));

/**
 * A line as the road graph holds one, an OSM way: two-dimensional, and never
 * across the antimeridian, where OpenStreetMap splits its ways.
 */
export const wayGeometry = lineFrom(2)
  .map((coordinates) => coordinates.map((p) => [p[0]!, p[1]!]))
  .filter((coordinates) =>
    coordinates.every((p, i) => i === 0 || Math.abs(p[0]! - coordinates[i - 1]![0]!) <= 180),
  )
  .map((coordinates) => ({ type: "LineString" as const, coordinates }));
const polygon = ring.map((r) => ({ type: "Polygon", coordinates: [r] }));
const simpleGeometry = fc.oneof(
  { weight: 4, arbitrary: point },
  { weight: 4, arbitrary: lineString },
  { weight: 2, arbitrary: polygon },
  {
    weight: 1,
    arbitrary: fc
      .array(position, { minLength: 1, maxLength: 3 })
      .map((coordinates) => ({ type: "MultiPoint", coordinates })),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(lineFrom(2), { minLength: 1, maxLength: 3 })
      .map((coordinates) => ({ type: "MultiLineString", coordinates })),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(ring, { minLength: 1, maxLength: 2 })
      .map((rings) => ({ type: "MultiPolygon", coordinates: rings.map((r) => [r]) })),
  },
);
export const geometry: fc.Arbitrary<Rec> = fc.oneof(
  { weight: 8, arbitrary: simpleGeometry },
  {
    weight: 1,
    arbitrary: fc
      .array(simpleGeometry, { minLength: 1, maxLength: 3 })
      .map((geometries) => ({ type: "GeometryCollection", geometries })),
  },
);

/** The canonical unit a quantity of a given field must be in. */
const UNITS: Readonly<Record<string, string>> = {
  limit: "km/h",
  delay: "s",
  queueLength: "m",
};

const number = (s: Schema): fc.Arbitrary<number> => {
  const integer = s["type"] === "integer";
  const min = (s["minimum"] as number | undefined) ?? (s["exclusiveMinimum"] as number | undefined);
  const max = (s["maximum"] as number | undefined) ?? (s["exclusiveMaximum"] as number | undefined);
  const lo = min ?? (integer ? -1_000_000 : -1e308);
  const hi = Math.min(max ?? (integer ? 1_000_000 : 1e308), integer ? 1_000_000 : 1e308);
  const exclusive = (v: number) =>
    !(s["exclusiveMinimum"] !== undefined && v <= (s["exclusiveMinimum"] as number)) &&
    !(s["exclusiveMaximum"] !== undefined && v >= (s["exclusiveMaximum"] as number));
  const base = integer
    ? fc.oneof(fc.integer({ min: lo, max: hi }), fc.constantFrom(lo, hi))
    : fc.oneof(
        fc.double({ min: lo, max: hi, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom(lo, hi, 0, 0.5, 1e-9),
      );
  return base.filter((v) => v >= lo && v <= hi && exclusive(v));
};

/** Kernel definitions generated here rather than from their schema. */
interface Context {
  defs: Readonly<Record<string, Schema>>;
  /** Unit of the quantity being generated, by its field name. */
  field?: string;
}

/**
 * A value for a JSON Schema, over the keywords the model's published schemas
 * use. Optional members are present at random; past a depth only the
 * required ones are, so records stay small. Definitions the generator has an
 * arbitrary of its own for (text, geometry, times) use those.
 */
function arbitraryOf(s: Schema, ctx: Context, depth = 0): fc.Arbitrary<unknown> | undefined {
  const ref = s["$ref"] as string | undefined;
  if (ref !== undefined) {
    const name = ref.replace("#/$defs/", "");
    switch (name) {
      case "Text":
        return localised;
      case "Geometry":
        return geometry;
      case "Quantity":
        return fc.record({
          value: fc.oneof(
            { weight: 4, arbitrary: number({ type: "number", minimum: 0, maximum: 1e6 }) },
            { weight: 1, arbitrary: fc.constantFrom(0, 0.4, 59.5, 1e21, 1e308, -1) },
          ),
          unit: fc.constant(UNITS[ctx.field ?? ""] ?? "m"),
        });
      case "VehicleApplicability":
        return fc.constantFrom({ kind: "all" }, { kind: "unknown" });
      case "Schedule":
      case "VehicleSelector":
      case "RecordRef":
      case "Relation":
      case "Effect":
      case "Validity":
      case "Attribution":
      case "Provenance":
        return undefined;
      default:
        return arbitraryOf(ctx.defs[name] ?? {}, ctx, depth + 1);
    }
  }
  if ("const" in s) return fc.constant(s["const"]);
  if (Array.isArray(s["enum"])) return fc.constantFrom(...(s["enum"] as unknown[]));
  for (const key of ["anyOf", "oneOf"]) {
    const alternatives = s[key] as Schema[] | undefined;
    if (alternatives) {
      const arbs = alternatives
        .filter((a) => a["type"] !== "null")
        .map((a) => arbitraryOf(a, ctx, depth))
        .filter((a): a is fc.Arbitrary<unknown> => a !== undefined);
      return arbs.length > 0 ? fc.oneof(...arbs) : undefined;
    }
  }
  switch (s["type"]) {
    case "boolean":
      return fc.boolean();
    case "number":
    case "integer":
      return number(s);
    case "string":
      if (s["format"] === "date-time") return instant;
      if (s["pattern"] === "^[A-Z]{2}$") return fc.constantFrom("DE", "NL", "ZZ", "XK");
      if (s["pattern"] !== undefined || s["format"] !== undefined) return undefined;
      return text;
    case "array": {
      const items = arbitraryOf((s["items"] as Schema | undefined) ?? {}, ctx, depth + 1);
      if (items === undefined) return undefined;
      const min = (s["minItems"] as number | undefined) ?? 0;
      return fc.array(items, { minLength: min, maxLength: min + 2 });
    }
    case "object": {
      const props = (s["properties"] as Record<string, Schema> | undefined) ?? {};
      const required = new Set((s["required"] as string[] | undefined) ?? []);
      const fields: Record<string, fc.Arbitrary<unknown>> = {};
      for (const [key, sub] of Object.entries(props)) {
        if (!required.has(key) && depth > 3) continue;
        const arb = arbitraryOf(sub, { ...ctx, field: key }, depth + 1);
        if (arb === undefined) {
          if (required.has(key)) return undefined;
          continue;
        }
        fields[key] = arb;
      }
      return fc.record(fields, {
        requiredKeys: Object.keys(fields).filter((k) => required.has(k)),
      });
    }
    default:
      return undefined;
  }
}

/** The fields every effect has, which the generator writes itself. */
const EFFECT_BASE = new Set([
  "id",
  "sourceRecordRef",
  "location",
  "applicability",
  "direction",
  "laneScope",
  "validity",
  "compliance",
  "normalization",
  "actionStatus",
  "issues",
  "source",
  "kind",
  "v",
]);

/** The effects DATEX and TraFF tell. */
const TOLD = new Set([
  "closure",
  "lane_restriction",
  "speed_limit",
  "delay",
  "detour",
  "contraflow",
]);

/** Every lifecycle, but mostly one the XML exporters tell rather than withhold. */
function validity(statuses: readonly string[]): fc.Arbitrary<Rec> {
  return fc
    .tuple(
      fc.oneof(
        { weight: 3, arbitrary: fc.constantFrom("active", "planned") },
        { weight: 1, arbitrary: fc.constantFrom(...statuses) },
      ),
      fc.option(instant, { nil: undefined }),
      fc.option(instant, { nil: undefined }),
    )
    .map(([status, a, b]) => {
      const [start, end] = a !== undefined && b !== undefined && ms(a) > ms(b) ? [b, a] : [a, b];
      return {
        status,
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
      };
    });
}

export interface SituationArbitraries {
  registry: Registry;
  /** A candidate draft, which the registry may still reject. */
  candidate: fc.Arbitrary<Rec>;
  /** A draft sealed as the store holds it, or undefined when the registry rejects it. */
  sealed: (draft: Rec) => Rec | undefined;
  /** A situation draft the registry accepts, sealed as the store holds it. */
  situation: fc.Arbitrary<Rec>;
  /** Several of them with distinct ids. */
  situations: (max: number) => fc.Arbitrary<Rec[]>;
}

/** Arbitraries over the production registry's situations. */
export function situationArbitraries(): SituationArbitraries {
  const registry = productionRegistry();
  const kernel = schemaFile("situation/roadworks@1.json");
  const defs = kernel["$defs"] as Record<string, Schema>;
  const ctx: Context = { defs };
  const statuses = ((defs["Validity"]!["properties"] as Rec)["status"] as { enum: string[] }).enum;

  // A direction with no reference axis is "both" or "unknown" only.
  const direction = (arbitraryOf(defs["DirectionRef"]!, ctx, 0) as fc.Arbitrary<Rec>).map((d) =>
    ["bearing", "compass", "text"].includes(d["basis"] as string) &&
    (d["value"] === "positive" || d["value"] === "negative")
      ? { ...d, value: "both" }
      : d,
  );
  const road = arbitraryOf(defs["RoadRef"]!, ctx, 0)!;
  const lane = arbitraryOf(defs["LaneRef"]!, ctx, 0)!;
  const informationSource = arbitraryOf(
    ((defs["Provenance"]!["properties"] as Rec)["informationSource"] as Schema)!,
    ctx,
    0,
  )!;
  const locationEnums = defs["LocationRef"]!["properties"] as Record<string, Schema>;
  const enumAt = (s: Schema | undefined) => (s as { enum: string[] }).enum;
  const extents = enumAt(locationEnums["extent"]).filter((e) => e !== "none");
  const origins = enumAt(locationEnums["geometryOrigin"]).filter((e) => e !== "none");
  const fuzziness = enumAt(locationEnums["fuzziness"]);
  const sourceFormats = enumAt(
    (defs["Provenance"]!["properties"] as Record<string, Schema>)["sourceFormat"],
  );

  const location = (own: boolean): fc.Arbitrary<Rec> =>
    fc
      .record(
        {
          geometry: own ? geometry : fc.option(geometry, { nil: null, freq: 8 }),
          extent: fc.constantFrom(...extents),
          geometryOrigin: fc.constantFrom(...origins),
          // Mostly exact: the XML exporters withhold a coarse location whole.
          fuzziness: fc.oneof(
            { weight: 4, arbitrary: fc.constant("exact") },
            { weight: 1, arbitrary: fc.constantFrom(...fuzziness) },
          ),
          roads: fc.array(road, { minLength: 1, maxLength: 3 }),
          direction,
          areaDescription: localised,
          lanes: fc.array(lane, { minLength: 1, maxLength: 2 }),
        },
        {
          requiredKeys: own ? ["geometry"] : ["geometry", "extent", "geometryOrigin", "fuzziness"],
        },
      )
      .map((l) => (l.geometry === null ? { ...l, extent: "none", geometryOrigin: "none" } : l));

  const effectKinds = registry.effects().map((e) => e.code);
  const effectFields = new Map(
    effectKinds.map((code) => {
      const s = schemaFile(`effect/${code}@1.json`);
      const own: Schema = {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(s["properties"] as Record<string, Schema>).filter(
            ([key]) => !EFFECT_BASE.has(key),
          ),
        ),
        required: ((s["required"] as string[]) ?? []).filter((key) => !EFFECT_BASE.has(key)),
      };
      return [code, arbitraryOf(own, { defs: s["$defs"] as Record<string, Schema> }, 1)!];
    }),
  );
  const baseEnums = schemaFile("effect/closure@1.json")["properties"] as Record<string, Schema>;
  const enumOf = (key: string) => (baseEnums[key] as { enum: string[] }).enum;
  const issues = arbitraryOf(baseEnums["issues"]!, ctx, 1)!;

  const effect = fc
    .tuple(
      // Every effect, but mostly those the XML exporters have a record or an
      // event for; the others (access, dimension limits) are vehicle-specific.
      fc.oneof(
        { weight: 3, arbitrary: fc.constantFrom(...effectKinds.filter((k) => TOLD.has(k))) },
        { weight: 1, arbitrary: fc.constantFrom(...effectKinds) },
      ),
      fc.record(
        {
          sourceRecordRef: text,
          location: location(true),
          direction,
          validity: validity(statuses),
          actionStatus: fc.constantFrom(...enumOf("actionStatus")),
        },
        { requiredKeys: [] },
      ),
      // Mostly for every vehicle and complete: the XML exporters withhold
      // a situation whole for anything else.
      fc.constantFrom({ kind: "all" }, { kind: "all" }, { kind: "all" }, { kind: "unknown" }),
      fc.constantFrom(...enumOf("compliance")),
      fc.oneof(
        { weight: 4, arbitrary: fc.constant("complete") },
        { weight: 1, arbitrary: fc.constantFrom(...enumOf("normalization")) },
      ),
      issues,
    )
    .chain(([kind, base, applicability, compliance, normalization, someIssues]) =>
      effectFields.get(kind)!.map(
        (own): Rec => ({
          id: "e",
          ...base,
          ...(own as Rec),
          kind,
          v: 1,
          applicability,
          compliance,
          normalization: kind === "unsupported" ? "unsupported" : normalization,
          ...(kind === "unsupported" || normalization !== "complete" ? { issues: someIssues } : {}),
        }),
      ),
    )
    // An effect its own schema rejects (a lane count past the total, a
    // weight in metres) is left out rather than repaired field by field.
    .map((e) => (registry.effectSchema(e["kind"] as string)!.safeParse(e).success ? e : undefined));

  const kinds = registry.kinds("situation");
  const classification = fc.constantFrom(...kinds).chain((entry) => {
    const types = Object.entries(entry.types ?? {});
    return fc.constantFrom(...types).chain(([type, subtypes]) =>
      fc
        .option(fc.constantFrom(...(subtypes.length > 0 ? subtypes : ["-"])), { nil: undefined })
        .map((subtype) => ({
          kind: entry.code,
          type,
          ...(subtype !== undefined && subtype !== "-" ? { subtype } : {}),
        })),
    );
  });
  const details = new Map(
    kinds.map((entry) => {
      const s = schemaFile(`situation/${entry.code}@1.json`);
      const d = (s["properties"] as Record<string, Schema>)["details"];
      return [
        entry.code,
        d ? arbitraryOf(d, { defs: s["$defs"] as Record<string, Schema> }, 1) : undefined,
      ];
    }),
  );
  const situationEnums = kernel["properties"] as Record<string, Schema>;
  const severity = (situationEnums["severity"]!["properties"] as Record<string, Schema>)["label"]!;
  // A record id's local part is any characters but a line break.
  const lineBreak = new RegExp(`[\\n\\r${String.fromCharCode(0x2028, 0x2029)}]`);
  const localIds = fc.oneof(
    fc.constantFrom(
      "a",
      "x/y?z=1&b=<c>",
      String.fromCodePoint(0xe9, 0x1f600),
      String.fromCharCode(0x01, 0xfffe, 0xd800),
      " ",
      "__proto__",
      "constructor",
    ),
    fc.string({ unit: "binary", minLength: 1, maxLength: 12 }).filter((s) => !lineBreak.test(s)),
  );

  const candidate = fc
    .record(
      {
        classification,
        localId: localIds,
        temporality: fc.constantFrom(...(situationEnums["temporality"] as { enum: string[] }).enum),
        certainty: fc.constantFrom(...(situationEnums["certainty"] as { enum: string[] }).enum),
        severity: fc.constantFrom(...(severity as { enum: string[] }).enum),
        level: fc.option(fc.constantFrom(1, 2, 3, 4, 5), { nil: undefined }),
        headline: fc.option(localised, { nil: undefined }),
        description: fc.option(localised, { nil: undefined }),
        validity: validity(statuses),
        effects: fc.array(effect, { maxLength: 3 }),
        location: location(false),
        sourceUpdatedAt: fc.option(instant, { nil: undefined }),
        informationSource: fc.option(informationSource, { nil: undefined }),
        fetchedAt: instant,
        expiresAt: fc.option(instant, { nil: undefined }),
        // The store keeps a revision in a 32-bit integer.
        revision: fc.oneof(fc.constantFrom(1, 2, 2 ** 31 - 1), fc.nat()),
        planned: fc.boolean(),
        sourceFormat: fc.constantFrom(...sourceFormats),
      },
      {
        requiredKeys: [
          "classification",
          "localId",
          "temporality",
          "certainty",
          "severity",
          "validity",
          "effects",
          "location",
          "fetchedAt",
          "revision",
        ],
      },
    )
    .chain((c) => {
      const d = details.get(c.classification!.kind);
      return (d ?? fc.constant(undefined)).map((det) => ({ ...c, details: det }));
    })
    .map((c): Rec => {
      const label = c.severity ?? "unknown";
      return {
        id: `oc:situation:fuzz:${c.localId ?? "a"}`,
        class: "situation",
        ...c.classification!,
        temporality: c.temporality ?? "live",
        certainty: c.certainty ?? "observed",
        severity: {
          label,
          ...(label !== "unknown" ? { source: "derived" } : {}),
          ...(c.level !== undefined ? { level: c.level } : {}),
        },
        ...(c.headline ? { headline: c.headline } : {}),
        ...(c.description ? { description: c.description } : {}),
        validity: c.validity ?? { status: "active" },
        planned: c.planned ?? false,
        effects: (c.effects ?? [])
          .filter((e): e is Rec => e !== undefined)
          .map((e, i) => ({ ...e, id: `e${i}` })),
        location: c.location!,
        provenance: {
          origin: "feed",
          sourceId: "fuzz",
          sourceFormat: c.sourceFormat ?? "datex2",
          accessMode: "bulk",
          recordId: c.localId ?? "a",
          attribution: { provider: "Fuzz", license: "CC0-1.0" },
          privacy: { class: "authoritative" },
          ...(c.sourceUpdatedAt ? { sourceUpdatedAt: c.sourceUpdatedAt } : {}),
          ...(c.informationSource && Object.keys(c.informationSource as Rec).length > 0
            ? { informationSource: c.informationSource }
            : {}),
        },
        freshness: {
          fetchedAt: c.fetchedAt ?? INSTANTS[0],
          ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
        },
        ...(c.details !== undefined ? { details: c.details } : {}),
        revision: Math.max(1, c.revision ?? 1),
      };
    });

  /**
   * The draft as the store holds it, or undefined when the registry rejects
   * it. Sealing writes an unpaired surrogate as U+FFFD, as the store does.
   */
  const sealed = (draft: Rec): Rec | undefined => {
    const { revision, ...rest } = draft;
    const out = sealRecord(registry, rest, {
      instanceId: "fuzz.example",
      revision: revision as number,
      recordedAt: "2026-09-06T09:45:00Z",
    });
    return out.ok ? out.value : undefined;
  };

  const situation = candidate.map(sealed).filter((s): s is Rec => s !== undefined);
  return {
    registry,
    candidate,
    sealed,
    situation,
    situations: (max) =>
      fc
        .array(candidate, { minLength: 1, maxLength: max })
        .map((drafts) =>
          drafts
            .map((d, i) => sealed({ ...d, id: `${String(d["id"])}#${i}` }))
            .filter((s): s is Rec => s !== undefined),
        ),
  };
}
