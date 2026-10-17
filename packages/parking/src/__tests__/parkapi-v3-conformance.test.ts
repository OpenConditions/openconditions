import {
  assertCovered,
  type JsonValidator,
  jsonSchemaEnums,
  openApiValidator,
  pinnedOrUnavailable,
} from "@openconditions/conformance";
import { PARKAPI_V3 } from "@openconditions/conformance/standards/parkapi-v3";
import { drainSkipped, type SkipCounts } from "@openconditions/ingest-framework";
import { beforeAll, describe, expect, it } from "vitest";
import { parseParkApiV3 } from "../formats/parkapi-v3.js";
import { fixture, mobidataFeed, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

type Json = Record<string, unknown>;

const FEED = mobidataFeed();
const FETCHED = "2026-10-05T03:31:40Z";

/** A minimal site with every field the schema requires, and live counts. */
const BASE_SITE: Json = {
  id: 1,
  source_id: 12,
  original_uid: "66",
  purpose: "CAR",
  name: "Probe",
  type: "OFF_STREET_PARKING_GROUND",
  has_realtime_data: true,
  static_data_updated_at: "2026-10-01T00:00:00Z",
  realtime_data_updated_at: "2026-10-05T03:25:00Z",
  lat: 49.0090212,
  lon: 8.4012777,
  created_at: "2024-12-04T06:59:56Z",
  modified_at: "2026-10-05T03:29:44Z",
  capacity: 100,
  realtime_free_capacity: 50,
};

/** A minimal bay of no site with every field the schema requires, and a live state. */
const BASE_SPOT: Json = {
  id: 9,
  source_id: 12,
  original_uid: "s9",
  purpose: "CAR",
  has_realtime_data: true,
  realtime_status: "AVAILABLE",
  realtime_data_updated_at: "2026-10-05T03:25:00Z",
  static_data_updated_at: "2026-10-01T00:00:00Z",
  lat: 49.0091,
  lon: 8.4013,
  created_at: "2024-12-04T06:59:56Z",
  modified_at: "2026-10-05T03:29:44Z",
};

/** A minimal source with every field the schema requires, and a name to credit. */
const BASE_SOURCE: Json = {
  id: 12,
  uid: "karlsruhe",
  name: "Stadt Karlsruhe",
  public_url: "https://web1.karlsruhe.de/service/Parken/",
  created_at: "2024-12-04T06:59:56Z",
  modified_at: "2026-10-05T03:29:44Z",
};

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

/** The real parser over one site and one source, with the skips it recorded. */
function run(site: Json, source: Json = BASE_SOURCE) {
  drainSkipped(FEED.id);
  const out = parseParkApiV3(
    FEED,
    { main: [json({ items: [site], total_count: 1 })], sources: [json({ items: [source] })] },
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  const skipped = drainSkipped(FEED.id);
  const feature = out.features[0];
  const readings = Object.fromEntries(
    out.observations
      .filter((o) => (o["subject"] as { componentKey?: string }).componentKey === undefined)
      .map((o) => [o["property"], (o["result"] as { value: unknown }).value]),
  );
  return { out, skipped, feature, readings };
}

type Run = ReturnType<typeof run>;

/** The real parser over the base site and one bay, which stands alone as `spot/<id>`. */
function runSpot(spot: Json) {
  drainSkipped(FEED.id);
  const out = parseParkApiV3(
    FEED,
    {
      main: [json({ items: [BASE_SITE], total_count: 1 })],
      sources: [json({ items: [BASE_SOURCE] })],
      spots: [json({ items: [spot], total_count: 1 })],
    },
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  const skipped = drainSkipped(FEED.id);
  const feature = out.features.find((f) => String(f["id"]).endsWith(`:spot/${spot["id"]}`));
  const readings = Object.fromEntries(
    out.observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId === feature?.["id"])
      .map((o) => [o["property"], (o["result"] as { value: unknown }).value]),
  );
  return { out, skipped, feature, readings };
}

const without = (record: Json, field: string): Json =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== field));

/** What the parser makes of a site, for comparing two runs. */
const output = (site: Json, source?: Json) => {
  const { out, skipped } = run(site, source);
  return JSON.stringify([out.features, out.observations, skipped]);
};

describe("ParkAPI v3 against its OpenAPI document", () => {
  let doc: Json = {};
  let unavailable: string | undefined;
  let validSite: JsonValidator = () => [];
  let validRestriction: JsonValidator = () => [];
  let validSource: JsonValidator = () => [];
  let validSpot: JsonValidator = () => [];
  let enums = new Map<string, string[]>();
  /** The schema pointers of the enumerations a coverage check below has read. */
  const checked = new Set<string>();

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(PARKAPI_V3);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
    doc = JSON.parse(pinned.files[0]!.contents) as Json;
    validSite = openApiValidator(doc, "ParkingSite");
    validRestriction = openApiValidator(doc, "ParkingSiteRestriction");
    validSource = openApiValidator(doc, "Source");
    validSpot = openApiValidator(doc, "ParkingSpot");
    enums = jsonSchemaEnums(doc);
  }, 120_000);

  /** A schema's own properties. */
  const properties = (schema: string): Json =>
    ((doc["components"] as Json)["schemas"] as Record<string, Json>)[schema]!["properties"] as Json;

  /** The values of one enumeration, by its pointer below the component schemas. */
  function values(pointer: string): string[] {
    const full = `#/components/schemas/${pointer}`;
    const found = enums.get(full);
    if (!found) throw new Error(`the document enumerates nothing at ${full}`);
    checked.add(full);
    return found;
  }

  /** A probe site, held to the schema: the parser is tested on standard records only. */
  function probe(fields: Json): Json {
    const site = { ...BASE_SITE, ...fields };
    expect(validSite(site), JSON.stringify(fields)).toEqual([]);
    return site;
  }

  /**
   * Whether the parser reads a value: it records no unread value for it, and
   * the site it makes is what the standard means by it.
   */
  function reads(fields: Json, expected: (result: Run) => void): boolean {
    const result = run(probe(fields));
    if (result.skipped.unknown_value) return false;
    expected(result);
    return true;
  }

  /** A probe bay, held to the schema. */
  function spotProbe(fields: Json): Json {
    const spot = { ...BASE_SPOT, ...fields };
    expect(validSpot(spot), JSON.stringify(fields)).toEqual([]);
    return spot;
  }

  /** Whether the parser reads a bay's value: no unread value, and the bay's site is as expected. */
  function readsSpot(
    fields: Json,
    expected: (result: ReturnType<typeof runSpot>) => void,
  ): boolean {
    const result = runSpot(spotProbe(fields));
    if (result.skipped.unknown_value) return false;
    expected(result);
    return true;
  }

  describe("fixtures", () => {
    it("the parking-sites capture is a valid `/v3/parking-sites` response", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const response = (
        ((doc["paths"] as Json)["/v3/parking-sites"] as Json)["get"] as {
          responses: { 200: { content: { "application/json": { schema: Json } } } };
        }
      ).responses[200].content["application/json"].schema;
      const schemas = (doc["components"] as Json)["schemas"] as Json;
      const withList = {
        ...doc,
        components: { ...(doc["components"] as Json), schemas: { ...schemas, List: response } },
      };
      const body = JSON.parse(fixture("parkapi-v3-sites.json").toString("utf8"));
      expect(openApiValidator(withList, "List")(body)).toEqual([]);
    });

    /**
     * ParkAPI writes an unset optional source field as `null`, which its own
     * document types as a plain string; `public_url` is even required.
     */
    const SOURCE_DEVIATIONS: Readonly<Record<string, string[]>> = {
      ladenburg_parkraumcheck: [
        '/public_url must be string {"type":"string"}',
        '/attribution_license must be string {"type":"string"}',
        '/attribution_contributor must be string {"type":"string"}',
        '/attribution_url must be string {"type":"string"}',
      ],
      toll_collect: [
        '/attribution_license must be string {"type":"string"}',
        '/attribution_contributor must be string {"type":"string"}',
        '/attribution_url must be string {"type":"string"}',
      ],
    };

    it("the sources capture deviates only by its null fields, which the parser reads as absent", ({
      skip,
    }) => {
      if (unavailable) skip(unavailable);
      const body = JSON.parse(fixture("parkapi-v3-sources.json").toString("utf8")) as {
        items: Json[];
      };
      expect(
        Object.fromEntries(
          body.items
            .map((s) => [s["uid"], validSource(s)] as const)
            .filter(([, errors]) => errors.length > 0),
        ),
      ).toEqual(SOURCE_DEVIATIONS);
      // A null licence or contributor credits the source by name, without a licence.
      const site = { ...BASE_SITE, source_id: 70 };
      const ladenburg = body.items.find((s) => s["uid"] === "ladenburg_parkraumcheck")!;
      expect(run(site, ladenburg).feature?.["provenance"]).toMatchObject({
        upstream: [{ publisher: "Ladenburg: Parkraumcheck", recordId: "66" }],
      });
      expect(
        (run(site, ladenburg).feature?.["provenance"] as { upstream?: Json[] } | undefined)
          ?.upstream?.[0],
      ).not.toHaveProperty("license");
    });

    it("the probe records are valid sites and sources", ({ skip }) => {
      if (unavailable) skip(unavailable);
      expect(validSite(BASE_SITE)).toEqual([]);
      expect(validSource(BASE_SOURCE)).toEqual([]);
    });
  });

  describe("enumerations, through the parser", () => {
    it("ParkAPI record types", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const types = Object.keys((doc["components"] as Json)["schemas"] as Json);
      assertCovered("component schemas", types, {
        handled: (type) =>
          type === "ParkingSite"
            ? run(probe({})).feature !== undefined
            : type === "ParkingSiteRestriction"
              ? run(probe({ restrictions: [{ type: "DISABLED", capacity: 4 }] })).feature?.[
                  "components"
                ] !== undefined
              : type === "Source"
                ? (run(probe({})).feature?.["provenance"] as Json | undefined)?.["upstream"] !==
                  undefined
                : type === "ParkingSpot"
                  ? runSpot(spotProbe({})).feature !== undefined
                  : type === "ParkingSpotRestriction"
                    ? runSpot(spotProbe({ restrictions: [{ type: "DISABLED" }] })).feature?.[
                        "components"
                      ] !== undefined
                    : false,
        unsupported: {
          ParkingSiteGroup:
            "ties sites of one upstream place across purposes; the feed requests car sites only, where each group holds a single site (see the ParkingSite fields)",
          ParkingSiteHistory: "past counts of `/history`, which the feed does not fetch",
          errorResponse: "an error answer, which fails the poll before any parsing",
        },
      });
    });

    it("ParkingSite.purpose", ({ skip }) => {
      if (unavailable) skip(unavailable);
      assertCovered("purpose", values("ParkingSite/properties/purpose"), {
        handled: (purpose) => {
          const { feature, skipped } = run(probe({ purpose }));
          expect(skipped).toEqual({});
          return feature !== undefined;
        },
        unsupported: {
          BIKE: "the feed requests `purpose=CAR`; bicycle sites are left out by design",
          MOTORCYCLE: "the feed requests `purpose=CAR`; motorcycle sites are left out by design",
          ITEM: "luggage and parcel lockers, which are no vehicle parking",
        },
      });
    });

    it("ParkingSite.type", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const meaning: Readonly<Record<string, [string, string | undefined]>> = {
        CAR_PARK: ["off_street", "multi_storey"],
        UNDERGROUND: ["off_street", "underground"],
        OFF_STREET_PARKING_GROUND: ["off_street", "surface"],
        ON_STREET: ["on_street", undefined],
        BUILDING: ["off_street", undefined],
      };
      const bicycle =
        "bicycle furniture (OSM `bicycle_parking`), which the standard uses at bike sites only; on a car site it classifies nothing, and is counted as unread";
      assertCovered("type", values("ParkingSite/properties/type"), {
        handled: (type) =>
          reads({ type }, ({ feature }) =>
            expect([
              feature?.["type"],
              (feature?.["details"] as { layout?: string } | undefined)?.layout,
            ]).toEqual(meaning[type]),
          ),
        unsupported: {
          OTHER:
            "ParkAPI's catch-all; the model has no unclassified site type, so the site takes the default off_street and the value is counted as unread",
          WALL_LOOPS: bicycle,
          SAFE_WALL_LOOPS: bicycle,
          STANDS: bicycle,
          LOCKERS: bicycle,
          SHED: bicycle,
          TWO_TIER: bicycle,
          FLOOR: bicycle,
          LOCKBOX: bicycle,
        },
      });
    });

    it("ParkingSite.park_and_ride_type", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const meaning: Readonly<Record<string, [string, string[] | undefined]>> = {
        YES: ["park_and_ride", ["park_and_ride"]],
        TRAIN: ["park_and_ride", ["park_and_ride"]],
        TRAM: ["park_and_ride", ["park_and_ride"]],
        BUS: ["park_and_ride", ["park_and_ride"]],
        CARPOOL: ["off_street", ["carpool"]],
        NO: ["off_street", undefined],
      };
      assertCovered(
        "park_and_ride_type",
        values("ParkingSite/properties/park_and_ride_type/items"),
        {
          handled: (t) =>
            reads({ park_and_ride_type: [t] }, ({ feature }) =>
              expect([
                feature?.["type"],
                (feature?.["details"] as { usage?: string[] } | undefined)?.usage,
              ]).toEqual(meaning[t]),
            ),
        },
      );
    });

    it("ParkingSite.supervision_type", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const meaning: Readonly<Record<string, Json>> = {
        NO: { supervision: "none" },
        ATTENDED: { supervision: "on_site" },
        VIDEO: { securityFeatures: ["cctv"] },
        YES: { supervision: "supervised" },
      };
      assertCovered("supervision_type", values("ParkingSite/properties/supervision_type"), {
        handled: (t) =>
          reads({ supervision_type: t }, ({ feature }) => {
            const details = feature?.["details"] as Json;
            expect({
              supervision: details["supervision"],
              securityFeatures: details["securityFeatures"],
            }).toEqual({ supervision: undefined, securityFeatures: undefined, ...meaning[t] });
          }),
      });
    });

    it("ParkingSite.realtime_opening_status", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const meaning: Readonly<Record<string, string>> = {
        OPEN: "open",
        CLOSED: "closed",
        UNKNOWN: "unknown",
      };
      assertCovered(
        "realtime_opening_status",
        values("ParkingSite/properties/realtime_opening_status"),
        {
          handled: (status) =>
            reads({ realtime_opening_status: status }, ({ readings }) =>
              expect(readings["parking.status"]).toBe(meaning[status]),
            ),
        },
      );
    });

    it("ParkingSite.external_identifiers[].type", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const value: Readonly<Record<string, string>> = {
        OSM: "https://www.openstreetmap.org/way/4711",
        DHID: "de:08212:1",
      };
      assertCovered(
        "external_identifiers.type",
        values("ParkingSite/properties/external_identifiers/items/properties/type"),
        {
          handled: (type) =>
            reads({ external_identifiers: [{ type, value: value[type] }] }, ({ feature }) =>
              type === "OSM"
                ? expect(feature?.["externalIds"]).toContainEqual({ scheme: "osm:way", id: "4711" })
                : // The stop a park-and-ride site serves, not the site: no linking id.
                  expect([
                    (feature?.["details"] as Json | undefined)?.["stops"],
                    (feature?.["externalIds"] as Json[] | undefined)?.length,
                  ]).toEqual([[{ scheme: "ifopt", id: "de:08212:1" }], 1]),
            ),
        },
      );
    });

    it("ParkingSiteRestriction.type", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const area: Readonly<Record<string, string>> = {
        DISABLED: "car:disabled",
        WOMEN: "car:women",
        FAMILY: "car:family",
        CHARGING: "car:ev_charging",
        CARSHARING: "car:car_sharing",
        RESIDENT: "car:residents",
        TRUCK: "truck:any",
        BUS: "bus:any",
        CARAVAN: "caravan:any",
        TAXI: "car:taxi",
        DELIVERY: "car:delivery",
        CUSTOMER: "car:customers",
        CARGOBIKE: "cargo_bike:any",
      };
      assertCovered("restrictions.type", values("ParkingSiteRestriction/properties/type"), {
        handled: (type) =>
          reads({ restrictions: [{ type, capacity: 10 }] }, ({ feature }) =>
            expect(feature?.["components"]).toEqual([
              expect.objectContaining({
                key: area[type],
                details: expect.objectContaining({ capacity: 10 }),
              }),
            ]),
          ) &&
          // Customers of the whole site are its audience instead of an area.
          (type !== "CUSTOMER" ||
            reads({ restrictions: [{ type }] }, ({ feature }) => {
              expect(feature?.["access"]).toMatchObject({ audience: "customers" });
              expect((feature?.["details"] as Json | undefined)?.["usage"]).toEqual(["customer"]);
              expect(feature?.["components"]).toBeUndefined();
            })),
      });
    });

    it("bay layout: orientation, side, parking_type, linear_parking_position", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const line = {
        type: "LineString",
        coordinates: [
          [8.4, 49],
          [8.41, 49],
        ],
      };
      const meaning: Readonly<Record<string, Readonly<Record<string, Json>>>> = {
        orientation: {
          PARALLEL: { bays: { orientation: "parallel" } },
          DIAGONAL: { bays: { orientation: "diagonal" } },
          PERPENDICULAR: { bays: { orientation: "perpendicular" } },
        },
        side: { RIGHT: { bays: { side: "right" } }, LEFT: { bays: { side: "left" } } },
        parking_type: {
          LANE: { bays: { position: "lane" } },
          ON_KERB: { bays: { position: "on_kerb" } },
          HALF_ON_KERB: { bays: { position: "half_on_kerb" } },
          SHOULDER: { bays: { position: "shoulder" } },
        },
        // What the site's line runs along, read with the line.
        linear_parking_position: {
          ROAD_CENTER_LINE: { outline: { geometry: line, line: "road_centre" } },
          PARKING_CENTER_LINE: { outline: { geometry: line, line: "bays_centre" } },
        },
      };
      for (const field of ["orientation", "side", "parking_type", "linear_parking_position"]) {
        assertCovered(field, values(`ParkingSite/properties/${field}`), {
          handled: (v) =>
            reads({ [field]: v, geojson: line }, ({ feature }) =>
              expect(feature?.["details"]).toMatchObject(meaning[field]![v]!),
            ),
        });
      }
    });

    it("ParkingSite.geojson.type", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const shape: Readonly<Record<string, unknown>> = {
        Polygon: [
          [
            [8.4, 49],
            [8.41, 49],
            [8.41, 49.01],
            [8.4, 49],
          ],
        ],
        MultiPolygon: [
          [
            [
              [8.4, 49],
              [8.41, 49],
              [8.41, 49.01],
              [8.4, 49],
            ],
          ],
        ],
        LineString: [
          [8.4, 49],
          [8.41, 49],
        ],
        MultiLineString: [
          [
            [8.4, 49],
            [8.41, 49],
          ],
        ],
      };
      // The site stays placed at its lat/lon; the shape is its outline.
      assertCovered("geojson.type", values("ParkingSite/properties/geojson/properties/type"), {
        handled: (type) =>
          reads({ geojson: { type, coordinates: shape[type] } }, ({ feature }) => {
            expect((feature?.["location"] as Json | undefined)?.["geometry"]).toMatchObject({
              type: "Point",
            });
            expect((feature?.["details"] as Json | undefined)?.["outline"]).toEqual({
              geometry: { type, coordinates: shape[type] },
            });
          }),
      });
    });

    it("Source.static_status and Source.realtime_status", ({ skip }) => {
      if (unavailable) skip(unavailable);
      for (const field of ["static_status", "realtime_status"]) {
        const list = values(`Source/properties/${field}`);
        assertCovered(field, list, {
          handled: (status) => {
            const source = { ...BASE_SOURCE, [field]: status };
            expect(validSource(source)).toEqual([]);
            return output(BASE_SITE, source) !== output(BASE_SITE);
          },
          unsupported: Object.fromEntries(
            list.map((v) => [
              v,
              "ParkAPI's own import health; a site's `has_realtime_data` already says whether its live data is current",
            ]),
          ),
        });
      }
    });

    it("ParkingSpot enumerations", ({ skip }) => {
      if (unavailable) skip(unavailable);
      assertCovered("spot purpose", values("ParkingSpot/properties/purpose"), {
        handled: (purpose) => runSpot(spotProbe({ purpose })).feature !== undefined,
        unsupported: {
          BIKE: "bicycle bays, left out by design as bicycle sites are",
          MOTORCYCLE: "motorcycle bays, left out by design as motorcycle sites are",
          ITEM: "lockers, which are no vehicle parking",
        },
      });
      const kinds: Readonly<Record<string, [string, string | undefined]>> = {
        CAR_PARK: ["off_street", "multi_storey"],
        UNDERGROUND: ["off_street", "underground"],
        OFF_STREET_PARKING_GROUND: ["off_street", "surface"],
        ON_STREET: ["on_street", undefined],
      };
      assertCovered("spot type", values("ParkingSpot/properties/type"), {
        handled: (type) =>
          readsSpot({ type }, ({ feature }) =>
            expect([
              feature?.["type"],
              (feature?.["details"] as { layout?: string } | undefined)?.layout,
            ]).toEqual(kinds[type]),
          ),
        unsupported: {
          LOCKERS: "a locker, which a car bay is not; counted as unread",
          LOCKBOX: "a lockbox, which a car bay is not; counted as unread",
        },
      });
      const state: Readonly<Record<string, Json>> = {
        AVAILABLE: { "parking.available": 1 },
        TAKEN: { "parking.available": 0 },
        UNKNOWN: { "parking.status": "unknown" },
      };
      assertCovered("spot realtime_status", values("ParkingSpot/properties/realtime_status"), {
        handled: (status) =>
          readsSpot({ realtime_status: status }, ({ readings }) =>
            expect(readings).toEqual(state[status]),
          ),
      });
      const area: Readonly<Record<string, string>> = {
        DISABLED: "car:disabled",
        WOMEN: "car:women",
        FAMILY: "car:family",
        CHARGING: "car:ev_charging",
        CARSHARING: "car:car_sharing",
        RESIDENT: "car:residents",
        TRUCK: "truck:any",
        BUS: "bus:any",
        CARAVAN: "caravan:any",
        TAXI: "car:taxi",
        DELIVERY: "car:delivery",
        CARGOBIKE: "cargo_bike:any",
      };
      assertCovered("spot restrictions.type", values("ParkingSpotRestriction/properties/type"), {
        handled: (type) =>
          readsSpot({ restrictions: [{ type }] }, ({ feature }) =>
            type === "CUSTOMER"
              ? expect(feature?.["access"]).toMatchObject({ audience: "customers" })
              : expect((feature?.["components"] as Json[] | undefined)?.[0]).toMatchObject({
                  key: area[type],
                }),
          ),
      });
      assertCovered(
        "spot external_identifiers.type",
        values("ParkingSpot/properties/external_identifiers/items/properties/type"),
        {
          handled: (type) =>
            readsSpot(
              {
                external_identifiers: [
                  {
                    type,
                    value: type === "OSM" ? "https://www.openstreetmap.org/node/5" : "de:08212:1",
                  },
                ],
              },
              ({ feature }) =>
                type === "OSM"
                  ? expect(feature?.["externalIds"]).toContainEqual({ scheme: "osm:node", id: "5" })
                  : expect((feature?.["details"] as Json | undefined)?.["stops"]).toEqual([
                      { scheme: "ifopt", id: "de:08212:1" },
                    ]),
            ),
        },
      );
      const ring = [
        [8.4, 49],
        [8.41, 49],
        [8.41, 49.01],
        [8.4, 49],
      ];
      const line = ring.slice(0, 2);
      const shape: Readonly<Record<string, unknown>> = {
        Polygon: [ring],
        MultiPolygon: [[ring]],
        LineString: line,
        MultiLineString: [line],
      };
      assertCovered("spot geojson.type", values("ParkingSpot/properties/geojson/properties/type"), {
        handled: (type) =>
          readsSpot({ geojson: { type, coordinates: shape[type] } }, ({ feature }) =>
            expect((feature?.["details"] as Json | undefined)?.["outline"]).toEqual({
              geometry: { type, coordinates: shape[type] },
            }),
          ),
      });
    });

    it("every enumeration of a read record type is checked above", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const unread = ["ParkingSiteGroup", "ParkingSiteHistory"];
      const all = [...enums.keys()].filter(
        (p) =>
          p.startsWith("#/components/schemas/") &&
          !unread.some((schema) => p.startsWith(`#/components/schemas/${schema}/`)),
      );
      expect(all.filter((p) => !checked.has(p))).toEqual([]);
    });
  });

  describe("fields, through the parser", () => {
    /** A value of each field that the parser, where it reads the field, cannot leave unchanged. */
    const SAMPLES: Readonly<Record<string, unknown>> = {
      id: 7,
      source_id: 12,
      original_uid: "4711",
      purpose: "BIKE",
      photo_url: "https://example.org/photo.jpg",
      name: "Rathaus",
      operator_name: "Stadtwerke",
      public_url: "https://example.org/site",
      address: "Marktplatz 1, 76133 Karlsruhe",
      description: "Einfahrt über die Kaiserstraße",
      type: "ON_STREET",
      max_stay: 7200,
      max_height: 210,
      max_width: 230,
      has_lighting: true,
      park_and_ride_type: ["YES"],
      supervision_type: "ATTENDED",
      is_covered: true,
      orientation: "PARALLEL",
      side: "RIGHT",
      parking_type: "LANE",
      linear_parking_position: "ROAD_CENTER_LINE",
      capacity_min: 5,
      capacity_max: 9,
      related_location: "Schule am Park",
      has_realtime_data: false,
      fee_description: "1 € je Stunde",
      has_fee: false,
      static_data_updated_at: "2026-10-02T00:00:00Z",
      realtime_data_updated_at: "2026-10-05T03:20:00Z",
      realtime_opening_status: "CLOSED",
      lat: 49.01,
      lon: 8.41,
      official_region_code: "082120000000",
      geojson: {
        type: "LineString",
        coordinates: [
          [8.4, 49],
          [8.41, 49],
        ],
      },
      restrictions: [{ type: "DISABLED", capacity: 4 }],
      external_identifiers: [{ type: "OSM", value: "https://www.openstreetmap.org/node/1" }],
      group: {
        id: 3,
        original_uid: "g3",
        created_at: "2024-12-04T06:59:56Z",
        modified_at: "2026-10-05T03:29:44Z",
      },
      tags: ["barrierefrei"],
      opening_hours: "Mo-Fr 07:00-20:00",
      created_at: "2024-01-01T00:00:00Z",
      modified_at: "2026-10-04T00:00:00Z",
      capacity: 80,
      realtime_capacity: 40,
      realtime_free_capacity: 30,
    };

    it("every ParkingSite field is read or listed as unread", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const fields = Object.keys(properties("ParkingSite"));
      assertCovered("ParkingSite fields", fields, {
        handled: (field) => {
          if (!(field in SAMPLES)) throw new Error(`no sample of ${field}`);
          // What a line runs along says something only of a site drawn as a line.
          const context =
            field === "linear_parking_position" ? { geojson: SAMPLES["geojson"] } : {};
          const rest = without({ ...BASE_SITE, ...context }, field);
          const set = { ...rest, [field]: SAMPLES[field] };
          expect(validSite(set), field).toEqual([]);
          return output(rest) !== output(set);
        },
        unsupported: {
          static_data_updated_at:
            "when the upstream source last changed the site; a record's freshness is the poll that delivered its content, and a content change already moves it",
          group:
            "ties sites of one upstream place across purposes (DB BahnPark's car and bicycle parking of a station); the feed requests car sites only, where each group holds a single site, so there is no other site to relate",
          tags: "free-form source tags with no defined vocabulary",
          created_at: "ParkAPI's own database bookkeeping",
          modified_at: "ParkAPI's own database bookkeeping",
        },
      });
    });

    it("every ParkingSiteRestriction field of an audience's restriction is read or listed as unread", ({
      skip,
    }) => {
      if (unavailable) skip(unavailable);
      const base: Json = { type: "DISABLED", capacity: 10, realtime_free_capacity: 3 };
      const samples: Json = {
        parking_site_id: 1,
        capacity: 12,
        realtime_capacity: 2,
        realtime_free_capacity: 5,
        type: "WOMEN",
        hours: "Mo-Fr 08:00-18:00",
        max_stay: "PT2H",
      };
      assertCovered(
        "ParkingSiteRestriction fields",
        Object.keys(properties("ParkingSiteRestriction")),
        {
          handled: (field) => {
            const rest = without(base, field);
            const set = { ...rest, [field]: samples[field] };
            expect(validRestriction(set), field).toEqual([]);
            return (
              output(probe({ restrictions: [rest] })) !== output(probe({ restrictions: [set] }))
            );
          },
          unsupported: {
            parking_site_id: "the site the restriction is nested in already",
          },
        },
      );
    });

    it("every ParkingSpot field is read or listed as unread", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const samples: Json = {
        id: 11,
        source_id: 12,
        // The base site: the bay becomes its space.
        parking_site_id: 1,
        original_uid: "s11",
        type: "ON_STREET",
        description: "Werktags 7.30-13 Uhr",
        address: "Marktplatz 1, 76133 Karlsruhe",
        lat: 49.02,
        lon: 8.42,
        official_region_code: "082120000000",
        name: "Behindertenparkplatz",
        purpose: "BIKE",
        geojson: SAMPLES["geojson"],
        restrictions: [{ type: "DISABLED" }],
        has_realtime_data: false,
        realtime_status: "TAKEN",
        realtime_data_updated_at: "2026-10-05T03:20:00Z",
        external_identifiers: [{ type: "OSM", value: "https://www.openstreetmap.org/node/1" }],
        created_at: "2024-01-01T00:00:00Z",
        modified_at: "2026-10-04T00:00:00Z",
        static_data_updated_at: "2026-10-02T00:00:00Z",
        tags: ["barrierefrei"],
      };
      const outputOf = (spot: Json) => {
        const { out, skipped } = runSpot(spot);
        return JSON.stringify([out.features, out.observations, skipped]);
      };
      assertCovered("ParkingSpot fields", Object.keys(properties("ParkingSpot")), {
        handled: (field) => {
          if (!(field in samples)) throw new Error(`no sample of ${field}`);
          const rest = without(BASE_SPOT, field);
          const set = { ...rest, [field]: samples[field] };
          expect(validSpot(set), field).toEqual([]);
          return outputOf(rest) !== outputOf(set);
        },
        unsupported: {
          static_data_updated_at:
            "when the upstream source last changed the bay; a record's freshness is the poll that delivered its content",
          tags: "free-form source tags with no defined vocabulary",
          created_at: "ParkAPI's own database bookkeeping",
          modified_at: "ParkAPI's own database bookkeeping",
        },
      });
    });

    it("every Source field is read or listed as unread", ({ skip }) => {
      if (unavailable) skip(unavailable);
      const samples: Json = {
        id: 12,
        created_at: "2024-01-01T00:00:00Z",
        modified_at: "2026-10-04T00:00:00Z",
        uid: "karlsruhe",
        name: "Stadt Karlsruhe",
        public_url: "https://example.org/source",
        last_import: "2026-10-05T03:00:00Z",
        attribution_license: "CC BY 4.0",
        attribution_contributor: "Stadt Karlsruhe, Tiefbauamt",
        attribution_url: "https://example.org/licence",
        static_data_updated_at: "2026-10-05T01:00:00Z",
        realtime_data_updated_at: "2026-10-05T03:29:00Z",
        static_status: "ACTIVE",
        realtime_status: "ACTIVE",
        static_parking_site_error_count: 2,
        realtime_parking_site_error_count: 3,
      };
      const bookkeeping =
        "ParkAPI's own import bookkeeping, about the source rather than its sites";
      assertCovered("Source fields", Object.keys(properties("Source")), {
        handled: (field) => {
          const rest = without(BASE_SOURCE, field);
          const set = { ...rest, [field]: samples[field] };
          expect(validSource(set), field).toEqual([]);
          return output(BASE_SITE, rest) !== output(BASE_SITE, set);
        },
        unsupported: {
          created_at: bookkeeping,
          modified_at: bookkeeping,
          last_import: bookkeeping,
          static_data_updated_at: bookkeeping,
          realtime_data_updated_at: bookkeeping,
          static_status: bookkeeping,
          realtime_status: bookkeeping,
          static_parking_site_error_count: bookkeeping,
          realtime_parking_site_error_count: bookkeeping,
          public_url:
            "the source's home page; an upstream publisher credit names the publisher and links its licence, but holds no page of the publisher",
        },
      });
    });
  });
});

describe("ParkAPI v3 skips", () => {
  const counts = (site: Json): SkipCounts => run(site).skipped;

  it("a site dropped is counted by its reason, and a site left out by design is not", () => {
    drainSkipped(FEED.id);
    const sites = [
      "not a site",
      { ...BASE_SITE, id: undefined },
      { ...BASE_SITE, id: 2, lat: null },
      { ...BASE_SITE, id: 3, lon: "east" },
      { ...BASE_SITE, id: 4, purpose: "SCOOTER" },
      { ...BASE_SITE, id: 5, purpose: "BIKE", type: "STANDS" },
      { ...BASE_SITE, id: 6, purpose: "ITEM", type: "LOCKERS" },
      { ...BASE_SITE, id: 7 },
    ];
    const out = parseParkApiV3(
      FEED,
      { main: [json({ items: sites })], sources: [json({ items: [BASE_SOURCE] })] },
      parseContext(FETCHED),
    );
    expect(out.features.map((f) => f["id"])).toEqual([`oc:feature:${FEED.id}:7`]);
    // The pipeline counts dropped sites among the rejected ones itself.
    expect(out.rejected).toBeFalsy();
    expect(drainSkipped(FEED.id)).toEqual({ malformed: 2, no_geometry: 2, unknown_type: 1 });
  });

  it("each value a kept site is published without is counted once", () => {
    expect(
      counts({
        ...BASE_SITE,
        type: "OTHER",
        park_and_ride_type: ["YES", "FERRY"],
        supervision_type: "YES",
        external_identifiers: [
          { type: "DHID", value: "de:08212:1" },
          { type: "GTFS", value: "1" },
          { type: "OSM", value: "https://www.openstreetmap.org/way/1" },
        ],
        restrictions: [
          { type: "TAXI", capacity: 2 },
          { type: "CUSTOMER", capacity: 10 },
          { type: "VALET", capacity: 1 },
          { type: "DISABLED", capacity: 3 },
        ],
        orientation: "ANGLED",
        realtime_opening_status: "MAINTENANCE",
      }),
    ).toEqual({ unknown_value: 6 });
    expect(counts({ ...BASE_SITE, supervision_type: "CCTV" })).toEqual({ unknown_value: 1 });
  });

  it("the captured sites lose nothing", () => {
    drainSkipped(FEED.id);
    parseParkApiV3(
      FEED,
      { main: [fixture("parkapi-v3-sites.json")], sources: [fixture("parkapi-v3-sources.json")] },
      parseContext(FETCHED),
    );
    expect(drainSkipped(FEED.id)).toEqual({});
  });
});
