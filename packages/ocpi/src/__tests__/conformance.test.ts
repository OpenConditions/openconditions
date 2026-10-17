import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type JsonValidator,
  jsonSchemaValidator,
  parseYaml,
  pinnedOrUnavailable,
  type SchemaFile,
} from "@openconditions/conformance";
import { OCPI_2_2_1, OCPI_2_3_0 } from "@openconditions/conformance/standards/ocpi";
import { beforeAll, describe, expect, test } from "vitest";
import { normaliseLocation, normaliseTariff } from "../decode.js";

type Json = Record<string, unknown>;
type Version = "2.2.1" | "2.3.0";
type ObjectName = "Location" | "Tariff";

/**
 * OCPI's DateTime: RFC 3339 in UTC, where "the absence of the timezone
 * designator implies a UTC timestamp", fractional seconds may be used, and
 * "other formats/patterns are not allowed" (`+00:00` included).
 */
const OCPI_DATE_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z?$";

/**
 * The OpenAPI schema as OCPI's own type definitions read. Three of its
 * annotations differ from what JSON Schema would make of them:
 *
 * - `format: enum` marks a closed enumeration whose `enum` already says it all;
 *   it is no JSON Schema format.
 * - `format: open-enum` marks a 2.3.0 OpenEnum, which leaves "room for them
 *   to use other values": the `enum` lists the known values, any string is valid.
 * - `format: date-time` is RFC 3339's, which requires an offset; OCPI's
 *   DateTime allows none and no offset but `Z`, so it is that pattern.
 */
function asOcpi(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(asOcpi);
  if (typeof node !== "object" || node === null) return node;
  const schema = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "format" && (value === "enum" || value === "open-enum")) continue;
    if (key === "enum" && schema["format"] === "open-enum") continue;
    if (key === "format" && value === "date-time") {
      out["pattern"] = OCPI_DATE_TIME;
      continue;
    }
    out[key] = asOcpi(value);
  }
  return out;
}

/**
 * A validator per OCPI object, the version's module files loaded together so
 * that their relative `$ref`s resolve: each file's `$id` is its pinned name
 * under one base. (The shared `openApiValidator` reads a single document.)
 */
function validators(
  files: readonly SchemaFile[],
  version: Version,
): Record<ObjectName, JsonValidator> {
  const base = `https://ocpi.conformance.openconditions.invalid/${version}/`;
  const refs = files.map((f) => ({
    ...(asOcpi(parseYaml(f.contents)) as Json),
    $id: `${base}${f.fileName}`,
  }));
  const of = (module: string, name: string) =>
    jsonSchemaValidator(
      { $ref: `${base}modules/${module}/schema.yaml#/components/schemas/${name}` },
      { draft: "2020-12", refs },
    );
  return { Location: of("locations", "Location"), Tariff: of("tariffs", "Tariff") };
}

const FIXTURES = join(import.meta.dirname, "fixtures");

function records(name: string): Json[] {
  const body = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
  if (Array.isArray(body)) return body as Json[];
  const envelope = body as Json;
  return (envelope["data"] ?? envelope["items"]) as Json[];
}

/** A record with every null-valued property left out, as an unset optional field is. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, withoutNulls(v)]),
  );
}

const hasNull = (value: unknown): boolean =>
  value === null ||
  (typeof value === "object" && Object.values(value as object).some((v) => hasNull(v)));

/** An Ajv error with array indexes written `*` and its parameters dropped, so one rule reads once. */
const rule = (error: string) => error.replace(/\/\d+(?=[/ ])/g, "/*").replace(/ \{.*$/, "");

interface Expectation {
  version: Version;
  object: ObjectName;
  /**
   * The publisher writes `null` for optional fields it does not set. OCPI's
   * objects declare none of their fields nullable; the decoders read a null
   * as an unset field.
   */
  nulls: boolean;
  /** Each rule the null-free records still break, with why the publisher does. */
  deviations: Readonly<Record<string, string>>;
}

/**
 * Each fixture against the OCPI version its endpoint serves: NDW and OCPDB
 * (`/ocpi/2.2/`) 2.2.1, Via Lietuva (`/ocpi/2.3.0/`) 2.3.0. Digitraffic's
 * captures are GeoJSON and camel-cased, no OCPI objects, and are not checked.
 */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  "ndw-locations.json": { version: "2.2.1", object: "Location", nulls: true, deviations: {} },
  "ndw-tariffs.json": { version: "2.2.1", object: "Tariff", nulls: true, deviations: {} },
  "lt-locations.json": {
    version: "2.3.0",
    object: "Location",
    nulls: true,
    deviations: {
      "/id must be string": "location ids are JSON numbers (258), not string(36)",
      "/evses/*/uid must be string": "EVSE uids are JSON numbers",
      "/evses/*/connectors/*/id must be string": "connector ids are JSON numbers",
      "/evses/*/connectors/* must have required property 'max_voltage'":
        "the voltage is sent as `voltage`, the field's name before OCPI 2.2",
      "/evses/*/connectors/* must have required property 'max_amperage'":
        "the amperage is sent as `amperage`, the field's name before OCPI 2.2",
      '/operator/website must match format "uri"':
        "websites are host names without a scheme (`www.inbalancegrid.lt`)",
      '/owner/website must match format "uri"': "as the operator's website",
      "/energy_mix must be object": "an unset energy mix is an empty array `[]`",
    },
  },
  "lt-tariffs.json": {
    version: "2.3.0",
    object: "Tariff",
    nulls: true,
    deviations: {
      "/ must have required property 'tax_included'":
        "2.3.0 requires tax_included; most tariffs send null",
      "/elements/*/price_components/*/price must be number":
        'prices are decimal strings ("0.2900")',
      "/elements/*/price_components/*/vat must be number": 'VAT is a decimal string ("21.0000")',
      "/min_price must be object":
        'min_price is a bare decimal string ("0.1000"), not a PriceLimit',
      [`/last_updated must match pattern "${OCPI_DATE_TIME}"`]:
        "last_updated is naive local time with a space (`2026-09-11 12:26:21`)",
    },
  },
  "ocpdb-locations.json": {
    version: "2.2.1",
    object: "Location",
    nulls: true,
    deviations: {
      "/ must have required property 'country_code'":
        "the aggregator names no CPO: its rows carry `source` instead of country_code",
      "/ must have required property 'party_id'": "as country_code",
      "/coordinates/latitude must be string": "coordinates are JSON numbers, not string(10)",
      "/coordinates/longitude must be string": "as latitude",
      "/evses/*/status must be equal to one of the allowed values":
        "register rows (`bnetza_api`) have the status `STATIC`, which OCPI does not define",
    },
  },
  "ocpdb-tariffs.json": {
    version: "2.2.1",
    object: "Tariff",
    nulls: false,
    deviations: {
      "/ must have required property 'country_code'": "as the OCPDB locations",
      "/ must have required property 'party_id'": "as the OCPDB locations",
      "/elements/*/price_components/* must have required property 'step_size'":
        "step_size, required, is left out",
      [`/start_date_time must match pattern "${OCPI_DATE_TIME}"`]:
        "times carry a `+00:00` offset, which OCPI says is not UTC's `Z`",
      [`/last_updated must match pattern "${OCPI_DATE_TIME}"`]: "as start_date_time",
    },
  },
};

describe("OCPI fixtures against the EV Roaming Foundation's OpenAPI", () => {
  const checks: Partial<Record<Version, Record<ObjectName, JsonValidator>>> = {};
  let unavailable: string | undefined;

  beforeAll(async () => {
    for (const [version, set] of [
      ["2.2.1", OCPI_2_2_1],
      ["2.3.0", OCPI_2_3_0],
    ] as const) {
      const pinned = await pinnedOrUnavailable(set);
      if ("unavailable" in pinned) {
        unavailable = pinned.unavailable;
        return;
      }
      checks[version] = validators(pinned.files, version);
    }
  }, 120_000);

  test.for(Object.entries(EXPECTED))(
    "%s breaks only the rules its expected deviations name",
    ([name, expected], { skip }) => {
      if (unavailable) skip(unavailable);
      const validate = checks[expected.version]![expected.object];
      const list = records(name);
      expect(list.some(hasNull)).toBe(expected.nulls);
      const broken = new Set(list.flatMap((r) => validate(withoutNulls(r)).map(rule)));
      expect([...broken].sort()).toEqual(Object.keys(expected.deviations).sort());
    },
  );

  test("the specification's own minimal objects are valid, so the check holds the fixtures and not itself", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const location = {
      country_code: "NL",
      party_id: "ABC",
      id: "LOC1",
      publish: true,
      address: "Street 1",
      city: "Town",
      country: "NLD",
      coordinates: { latitude: "52.000000", longitude: "5.000000" },
      time_zone: "Europe/Amsterdam",
      last_updated: "2026-10-17T08:00:00",
    };
    const tariff = {
      country_code: "NL",
      party_id: "ABC",
      id: "T1",
      currency: "EUR",
      elements: [{ price_components: [{ type: "ENERGY", price: 0.3, step_size: 1 }] }],
      last_updated: "2026-10-17T08:00:00Z",
    };
    for (const version of ["2.2.1", "2.3.0"] as const) {
      expect(checks[version]!.Location(location)).toEqual([]);
      expect(
        checks[version]!.Location({ ...location, last_updated: "2026-10-17T08:00:00+00:00" }),
      ).not.toEqual([]);
    }
    expect(checks["2.2.1"]!.Tariff(tariff)).toEqual([]);
    expect(checks["2.3.0"]!.Tariff({ ...tariff, tax_included: "NO" })).toEqual([]);
    // 2.3.0 OpenEnums admit values beyond the listed ones; its closed enums do not.
    expect(checks["2.3.0"]!.Location({ ...location, parking_type: "X_ROOFTOP" })).toEqual([]);
    expect(checks["2.2.1"]!.Location({ ...location, parking_type: "X_ROOFTOP" })).not.toEqual([]);
  });
});

describe("the decoders read each publisher deviation as the publisher means it", () => {
  test("Via Lietuva: numeric ids, pre-2.2 connector names, string prices and naive times", () => {
    const [location] = records("lt-locations.json").map(normaliseLocation);
    expect(location!.id).toBe("258");
    expect(location!.evses.map((e) => e.uid)).toEqual(["535", "12032"]);
    expect(location!.evses[0]!.connectors[0]).toMatchObject({
      id: "650306",
      max_voltage: 400,
      max_amperage: 32,
    });
    // The website is kept as written; the charging mapping makes a URL of it where it can.
    expect(location!.operator).toEqual({
      name: "In Balance grid, UAB",
      website: "www.inbalancegrid.lt",
    });
    const tariffs = new Map(
      records("lt-tariffs.json").map((t) => [String(t["id"]), normaliseTariff(t)]),
    );
    expect(tariffs.get("24")).toMatchObject({
      tax_included: "NO",
      min_price: { excl_vat: 0.1 },
      last_updated: "2026-09-11 12:26:21",
      elements: [{ price_components: [{ type: "ENERGY", price: 0.21, vat: 21 }] }],
    });
    // A null tax_included is unset, as an omitted one.
    expect(tariffs.get("4")).not.toHaveProperty("tax_included");
  });

  test("OCPDB: no party, numeric coordinates, STATIC rows, no step size and +00:00 offsets", () => {
    const locations = records("ocpdb-locations.json").map(normaliseLocation);
    const register = locations.find((l) => l.source === "bnetza_api")!;
    expect(register).not.toHaveProperty("country_code");
    expect(register).not.toHaveProperty("party_id");
    expect(register.coordinates.latitude).toEqual(expect.any(Number));
    expect(register.evses.map((e) => e.status)).toEqual(["STATIC", "STATIC"]);
    const [tariff] = records("ocpdb-tariffs.json").map(normaliseTariff);
    expect(tariff!.elements[0]!.price_components[0]).not.toHaveProperty("step_size");
    expect(Date.parse(tariff!.start_date_time!)).toBe(Date.parse("2026-08-03T08:26:43.619Z"));
  });
});
