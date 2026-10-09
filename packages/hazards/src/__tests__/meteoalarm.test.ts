import {
  createFetchState,
  type FeedPayloads,
  fetchEndpoint,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CapAlert } from "../cap/types.js";
import { hazardsDomain } from "../domain.js";
import { readMeteoAlarm } from "../formats/meteoalarm.js";
import {
  aliasIndex,
  type MeteoAlarmAliasSnapshot,
  readMeteoAlarmAliasCsv,
} from "../formats/meteoalarm-aliases.js";
import aliasSnapshot from "../formats/snapshots/meteoalarm-aliases.json" with { type: "json" };
import { fixture, meteoalarmFeed, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const meteoalarm = hazardsDomain.formats["meteoalarm"]!;
const feed = meteoalarmFeed();
const parse = (payloads: FeedPayloads, at: string): ParseOutput =>
  meteoalarm.parse(feed, payloads, parseContext(at, 120));

/** Polls while the captures were current. */
const AUSTRIA_AT = "2026-10-05T06:50:00Z";
const NOW = "2026-10-08T15:00:00Z";
const FIT_AT = "2026-09-25T22:00:00Z";
const geocodes = () => [fixture("meteoalarm-geocodes.json")];

const kind = (s: RecordDraft) => [s["type"], s["subtype"]].filter(Boolean).join(".");
const locationOf = (s: RecordDraft) =>
  s["location"] as {
    geometry: { type: string; coordinates: unknown[] } | null;
    geometryOrigin: string;
    extent: string;
    admin?: { country: string; geocodes: { scheme: string; code: string }[] };
  };
const json = (name: string) =>
  JSON.parse(fixture(name).toString("utf8")) as Record<string, unknown>;
const buffer = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("the meteoalarm format over the captured feeds", () => {
  test("Austria: an EMMA region takes the geocode file's shape, derived; the update names its warning", () => {
    const out = parse(
      { alerts: [fixture("meteoalarm-austria.json")], geocodes: geocodes() },
      AUSTRIA_AT,
    );
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations.map(kind)).toEqual(["thunderstorm", "thunderstorm"]);
    const [dornbirn, feldkirch] = out.situations as [RecordDraft, RecordDraft];
    expect(locationOf(dornbirn)).toMatchObject({
      geometryOrigin: "derived",
      extent: "area",
      admin: { country: "AT", geocodes: [{ scheme: "emma_id", code: "AT803" }] },
    });
    expect(locationOf(dornbirn).geometry!.type).toBe("Polygon");
    expect(locationOf(feldkirch).admin!.geocodes).toEqual([{ scheme: "emma_id", code: "AT804" }]);
    expect(dornbirn).toMatchObject({
      groupId: "2.49.0.0.40.0.AT.-20261005083327_ATNT_803",
      relations: [
        {
          relation: "update_of",
          ref: {
            class: "situation",
            id: "oc:situation:eu-meteoalarm-alerts:2.49.0.0.40.0.AT.-20261005083327_ATNT_803",
          },
        },
      ],
    });
    expect(out.records).toMatchObject({ inputCount: 2, accepted: 2, terminal: 0 });
  });

  test("Austria without the geocode file: the codes alone, no geometry", () => {
    const out = parse({ alerts: [fixture("meteoalarm-austria.json")] }, AUSTRIA_AT);
    expect(out.situations).toHaveLength(2);
    expect(locationOf(out.situations[0]!)).toMatchObject({
      geometry: null,
      geometryOrigin: "none",
      admin: { country: "AT", geocodes: [{ scheme: "emma_id", code: "AT803" }] },
    });
  });

  test("Switzerland: an inline polygon is the source's, in every language the warning carries", () => {
    const out = parse(
      { alerts: [fixture("meteoalarm-switzerland.json")], geocodes: geocodes() },
      NOW,
    );
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations).toHaveLength(1);
    const [warning] = out.situations as [RecordDraft];
    expect(locationOf(warning)).toMatchObject({
      geometryOrigin: "source",
      admin: { country: "CH" },
    });
    expect(locationOf(warning).geometry!.type).toBe("Polygon");
    const event = (warning["details"] as { cap: { event: { lang: string }[] } }).cap.event;
    expect(event.map((t) => t.lang)).toEqual(["en", "de", "fr", "it", "rm"]);
  });

  test("France: a NUTS3 area takes the shape of the EMMA region MeteoAlarm's aliases name", () => {
    const out = parse({ alerts: [fixture("meteoalarm-france.json")], geocodes: geocodes() }, NOW);
    expect(sealFailures(out.situations)).toEqual([]);
    const [coast, alps] = out.situations as [RecordDraft, RecordDraft];
    // FR815 is FR006, Pyrénées-Orientales; the other regions are not in the trimmed file.
    expect(locationOf(coast)).toMatchObject({
      geometryOrigin: "derived",
      admin: { country: "FR" },
    });
    expect(locationOf(coast).geometry!.type).toBe("Polygon");
    expect(locationOf(coast).admin!.geocodes).toContainEqual({ scheme: "nuts", code: "FR815" });
    // FR822 is FR033, which the trimmed file lacks: the code alone.
    expect(locationOf(alps)).toMatchObject({ geometry: null, geometryOrigin: "none" });
  });

  test("France without the geocode file: NUTS3 areas keep their geocodes and no geometry", () => {
    const out = parse({ alerts: [fixture("meteoalarm-france.json")] }, NOW);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations).toHaveLength(2);
    for (const s of out.situations) {
      expect(locationOf(s)).toMatchObject({
        geometry: null,
        geometryOrigin: "none",
        extent: "area",
        admin: { country: "FR" },
      });
      for (const g of locationOf(s).admin!.geocodes) {
        expect(g).toEqual({ scheme: "nuts", code: expect.stringMatching(/^FR\d{3}$/) });
      }
    }
  });

  test("Ireland: the FIPS 10-4 region codes are fips10_4, not the US scheme, and reach IE006", () => {
    const out = parse({ alerts: [fixture("meteoalarm-ireland.json")], geocodes: geocodes() }, NOW);
    expect(sealFailures(out.situations)).toEqual([]);
    const [warning] = out.situations as [RecordDraft];
    // EI26 is IE006, the one Irish region in the trimmed file.
    expect(locationOf(warning)).toMatchObject({
      geometryOrigin: "derived",
      admin: { country: "IE" },
    });
    const schemes = locationOf(warning).admin!.geocodes;
    expect(schemes.length).toBeGreaterThan(1);
    expect(schemes.every((g) => g.scheme === "fips10_4" && /^EI\d{2}$/.test(g.code))).toBe(true);
    expect(schemes).toContainEqual({ scheme: "fips10_4", code: "EI01" });
  });

  test("Czechia: CISORP codes are cisorp; the EMMA regions the file has give the shape", () => {
    const out = parse({ alerts: [fixture("meteoalarm-czechia.json")], geocodes: geocodes() }, NOW);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations).toHaveLength(2);
    const [first] = out.situations as [RecordDraft];
    const found = locationOf(first).admin!;
    expect(found.country).toBe("CZ");
    expect(found.geocodes).toContainEqual({ scheme: "cisorp", code: "3104" });
    expect(found.geocodes).toContainEqual({ scheme: "emma_id", code: "CZ03104" });
    expect(locationOf(first).geometryOrigin).toBe("derived");
    const without = parse({ alerts: [fixture("meteoalarm-czechia.json")] }, NOW);
    expect(locationOf(without.situations[0]!).geometry).toBeNull();
  });

  test("the fit capture: France, Norway and Spain, an all-clear that names no area", () => {
    const out = parse({ alerts: [fixture("meteoalarm-warnings.json")] }, FIT_AT);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations.map(kind)).toEqual([
      "flood.rain",
      "flood.rain",
      "flood",
      "wind",
      "avalanche",
    ]);
    expect(out.situations.map((s) => locationOf(s).admin?.country)).toEqual([
      "FR",
      undefined,
      "FR",
      "NO",
      "ES",
    ]);
    const allClear = out.situations[1]!;
    expect(allClear["location"]).toEqual({
      geometry: null,
      extent: "none",
      geometryOrigin: "none",
      fuzziness: "extent_unknown",
    });
    expect(allClear["validity"]).toEqual({
      status: "ended",
      start: "2026-09-30T22:00:00+02:00",
      end: "2026-09-30T22:00:00+02:00",
      endedReason: "source_ended",
    });
    expect(locationOf(out.situations[2]!)).toMatchObject({
      geometry: null,
      admin: {
        country: "FR",
        geocodes: [
          { scheme: "nuts", code: expect.stringMatching(/^FR/) },
          { scheme: "nuts", code: expect.stringMatching(/^FR/) },
        ],
      },
    });
  });
});

describe("the meteoalarm format: serving window", () => {
  const instant = (value: unknown) => Date.parse(String(value));
  const warnings = [
    ["meteoalarm-austria.json", AUSTRIA_AT],
    ["meteoalarm-switzerland.json", NOW],
    ["meteoalarm-france.json", NOW],
    ["meteoalarm-ireland.json", NOW],
    ["meteoalarm-czechia.json", NOW],
  ] as const;

  test.each(warnings)("%s: freshness.expiresAt is min(expires, fetchedAt + 180 s)", (name, at) => {
    const out = parse({ alerts: [fixture(name)], geocodes: geocodes() }, at);
    expect(out.situations.length).toBeGreaterThan(0);
    for (const s of out.situations) {
      const expires = (s["validity"] as { end: string }).end;
      const freshness = s["freshness"] as { fetchedAt: string; expiresAt: string };
      expect(freshness.fetchedAt).toBe(at);
      expect(instant(freshness.expiresAt)).toBe(Math.min(instant(expires), instant(at) + 180_000));
    }
  });

  test("a warning that expires within the window keeps its own expiry; a longer one is cut to three minutes", () => {
    const france = json("meteoalarm-france.json") as { warnings: { alert: CapAlert }[] };
    const [first] = france.warnings as [{ alert: CapAlert }];
    const expires = first.alert.info![0]!.expires!;
    const near = new Date(Date.parse(expires) - 120_000).toISOString();
    const out = parse({ alerts: [fixture("meteoalarm-france.json")] }, near);
    const [soon] = out.situations as [RecordDraft];
    expect((soon["freshness"] as { expiresAt: string }).expiresAt).toBe(expires);
    const early = parse({ alerts: [fixture("meteoalarm-france.json")] }, NOW);
    expect((early.situations[0]!["freshness"] as { expiresAt: string }).expiresAt).toBe(
      "2026-10-08T15:03:00Z",
    );
  });

  test("a warning with no expiry is served for the window alone", () => {
    const ireland = json("meteoalarm-ireland.json") as { warnings: { alert: CapAlert }[] };
    for (const info of ireland.warnings[0]!.alert.info!) delete info.expires;
    const out = parse({ alerts: [buffer(ireland)] }, NOW);
    expect((out.situations[0]!["freshness"] as { expiresAt: string }).expiresAt).toBe(
      "2026-10-08T15:03:00Z",
    );
  });
});

describe("the meteoalarm format: countries", () => {
  const COUNTRIES: [string, string][] = [
    ["20", "AD"],
    ["40", "AT"],
    ["56", "BE"],
    ["70", "BA"],
    ["100", "BG"],
    ["191", "HR"],
    ["196", "CY"],
    ["203", "CZ"],
    ["208", "DK"],
    ["233", "EE"],
    ["246", "FI"],
    ["250", "FR"],
    ["300", "GR"],
    ["348", "HU"],
    ["352", "IS"],
    ["372", "IE"],
    ["376", "IL"],
    ["380", "IT"],
    ["428", "LV"],
    ["440", "LT"],
    ["442", "LU"],
    ["470", "MT"],
    ["498", "MD"],
    ["499", "ME"],
    ["528", "NL"],
    ["578", "NO"],
    ["616", "PL"],
    ["620", "PT"],
    ["642", "RO"],
    ["688", "RS"],
    ["703", "SK"],
    ["705", "SI"],
    ["724", "ES"],
    ["752", "SE"],
    ["756", "CH"],
    ["804", "UA"],
    ["807", "MK"],
    ["826", "GB"],
  ];

  test("every country of the feed list is read from its identifier's ISO numeric code", () => {
    const ireland = json("meteoalarm-ireland.json") as { warnings: { alert: CapAlert }[] };
    const [first] = ireland.warnings as [{ alert: CapAlert }];
    const out = parse(
      {
        alerts: [
          buffer({
            warnings: COUNTRIES.map(([numeric, iso]) => ({
              alert: { ...first.alert, identifier: `2.49.0.1.${numeric}.0.${iso}.1` },
            })),
          }),
        ],
      },
      NOW,
    );
    expect(out.situations.map((s) => locationOf(s).admin?.country)).toEqual(
      COUNTRIES.map(([, iso]) => iso),
    );
  });

  test("the numeric code is the ISO 3166 one, with the eight no-warning feeds covered", () => {
    expect(COUNTRIES).toHaveLength(38);
    expect(new Set(COUNTRIES.map(([n]) => n)).size).toBe(38);
  });
});

describe("the meteoalarm format: shapes", () => {
  const austria = (geocodeFile: Buffer[]) =>
    parse({ alerts: [fixture("meteoalarm-austria.json")], geocodes: geocodeFile }, AUSTRIA_AT);

  test("a region shape with a position out of range is skipped; that area keeps its code", () => {
    const file = json("meteoalarm-geocodes.json") as {
      features: { properties: { code: string }; geometry: { coordinates: number[][][] } }[];
    };
    const dornbirn = file.features.find((f) => f.properties.code === "AT803")!;
    dornbirn.geometry.coordinates[0]![1] = [200, 47];
    const out = austria([buffer(file)]);
    expect(out.situations).toHaveLength(2);
    expect(locationOf(out.situations[0]!)).toMatchObject({
      geometry: null,
      geometryOrigin: "none",
      admin: { geocodes: [{ scheme: "emma_id", code: "AT803" }] },
    });
    expect(locationOf(out.situations[1]!).geometryOrigin).toBe("derived");
  });

  test("a geocode file that does not read leaves every area with its code; the alerts publish", () => {
    for (const bad of [Buffer.from("<html>moved</html>"), buffer({ features: "none" })]) {
      const out = austria([bad]);
      expect(out.situations).toHaveLength(2);
      expect(locationOf(out.situations[0]!).geometry).toBeNull();
    }
  });

  test("a malformed geocode entry is skipped, never a parse failure", () => {
    // Constructed: entries the hub might write wrongly, beside the real ones.
    const alerts = json("meteoalarm-austria.json") as {
      warnings: { alert: { info: { area: { geocode: unknown[] }[] }[] } }[];
    };
    for (const info of alerts.warnings[0]!.alert.info) {
      info.area[0]!.geocode.push(null, 7, { valueName: "EMMA_ID", value: 123 }, { value: "AT804" });
    }
    const file = json("meteoalarm-geocodes.json") as {
      features: { properties: { code: string }; geometry: unknown }[];
    };
    const feldkirch = file.features.find((f) => f.properties.code === "AT804")!;
    feldkirch.geometry = { type: "Polygon", coordinates: "not a ring" };
    const out = parse({ alerts: [buffer(alerts)], geocodes: [buffer(file)] }, AUSTRIA_AT);
    expect(out.situations).toHaveLength(2);
    expect(out.rejected).toBeUndefined();
    expect(locationOf(out.situations[0]!)).toMatchObject({
      geometryOrigin: "derived",
      admin: { geocodes: [{ scheme: "emma_id", code: "AT803" }] },
    });
    expect(locationOf(out.situations[1]!)).toMatchObject({
      geometry: null,
      admin: { geocodes: [{ scheme: "emma_id", code: "AT804" }] },
    });
  });

  test("a region the file lacks has no shape", () => {
    const file = json("meteoalarm-geocodes.json") as {
      features: { properties: { code: string } }[];
    };
    file.features = file.features.filter((f) => f.properties.code !== "AT804");
    const out = austria([buffer(file)]);
    expect(locationOf(out.situations[0]!).geometryOrigin).toBe("derived");
    expect(locationOf(out.situations[1]!).geometry).toBeNull();
  });

  test("a region shape is simplified once, to 0.005 degrees", () => {
    const ring = Array.from({ length: 721 }, (_, i) => {
      const a = (Math.min(i, 720) * Math.PI) / 360;
      return [14 + 0.5 * Math.cos(a), 47 + 0.5 * Math.sin(a)];
    });
    const file = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { code: "AT803", type: "EMMA_ID" },
          geometry: { type: "Polygon", coordinates: [ring] },
        },
      ],
    };
    const out = austria([buffer(file)]);
    const kept = (locationOf(out.situations[0]!).geometry!.coordinates as number[][][])[0]!;
    expect(kept.length).toBeLessThan(80);
    expect(kept.length).toBeGreaterThan(8);
  });
});

describe("the meteoalarm format: payloads", () => {
  test('{"warnings":[]} is a country with nothing in force: an accounted zero', () => {
    const out = parse({ alerts: [Buffer.from('{"warnings":[]}')] }, NOW);
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 0, accepted: 0, terminal: 0 });
    expect(readMeteoAlarm(Buffer.from('{"warnings":[]}'))).toEqual([]);
  });

  test("the countries of one poll are one parse", () => {
    const out = parse(
      {
        alerts: [
          fixture("meteoalarm-ireland.json"),
          Buffer.from('{"warnings":[]}'),
          fixture("meteoalarm-france.json"),
        ],
      },
      NOW,
    );
    expect(out.situations.map((s) => locationOf(s).admin?.country)).toEqual(["IE", "FR", "FR"]);
    expect(out.records).toMatchObject({ inputCount: 3, accepted: 3 });
  });

  test("an entry with no alert is a rejected record; a payload that is no envelope, too, while another reads", () => {
    const out = parse(
      {
        alerts: [
          buffer({
            warnings: [
              { uuid: "x" },
              ...(json("meteoalarm-ireland.json")["warnings"] as unknown[]),
            ],
          }),
          Buffer.from("<html>Service Unavailable</html>"),
        ],
      },
      NOW,
    );
    expect(out.situations).toHaveLength(1);
    expect(out.rejected).toBe(2);
  });

  test("when no payload is an envelope, the answer is the publisher's error and the parse fails", () => {
    expect(() => parse({ alerts: [Buffer.from('{"error":"limit"}')] }, NOW)).toThrow(
      /no warnings envelope/,
    );
    expect(() => parse({ alerts: [Buffer.from("not json")] }, NOW)).toThrow();
  });

  test("a message that is not Actual is terminal", () => {
    const ireland = json("meteoalarm-ireland.json") as { warnings: { alert: CapAlert }[] };
    ireland.warnings[0]!.alert.status = "Test";
    const out = parse({ alerts: [buffer(ireland)] }, NOW);
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 1, terminal: 1 });
  });
});

describe("MeteoAlarm's alias table", () => {
  test("the CSV is read with a byte-order mark, quotes and CRLF; a row short of a cell is skipped", () => {
    const csv =
      '﻿"CODE","ALIAS_CODE","ALIAS_TYPE"\r\n"FR006","FR815","NUTS3"\r\nFR006\r\n,FR815,NUTS3\r\nFR006,,NUTS3\r\n\r\nBE004,BE31,NUTS2\r\nBE004,BE24,NUTS2\r\n';
    const rows = readMeteoAlarmAliasCsv(csv);
    expect(rows).toEqual([
      ["FR006", "FR815", "NUTS3"],
      ["BE004", "BE31", "NUTS2"],
      ["BE004", "BE24", "NUTS2"],
    ]);
    expect(aliasIndex(rows).get("NUTS2:BE24")).toEqual(["BE004"]);
  });

  test("the vendored copy resolves the codes the live feeds send", () => {
    const index = aliasIndex((aliasSnapshot as unknown as MeteoAlarmAliasSnapshot).rows);
    expect(index.get("NUTS3:FR815")).toEqual(["FR006"]);
    expect(index.get("NUTS3:BG311")).toBeDefined();
    expect(index.get("NUTS2:HU21")).toBeDefined();
    expect(index.get("FIPS:EI26")).toEqual(["IE006"]);
    expect(index.get("CISORP:3104")).toEqual(["CZ03104"]);
    expect(index.get("WARNCELLID:501000005")).toEqual(["DE801"]);
  });
});

describe("the meteoalarm format over its endpoints", () => {
  afterEach(() => vi.restoreAllMocks());

  test("a country that answers 404 leaves the others to publish", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const served = new Map<string, Uint8Array<ArrayBuffer>>([
      [
        "https://feeds.meteoalarm.org/api/v1/warnings/feeds-austria",
        new Uint8Array(fixture("meteoalarm-austria.json")),
      ],
      [
        "https://feeds.meteoalarm.org/api/v1/warnings/feeds-france",
        new Uint8Array(fixture("meteoalarm-france.json")),
      ],
      [
        "https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/MeteoAlarm_Geocodes_2026_07_31.json",
        new Uint8Array(fixture("meteoalarm-geocodes.json")),
      ],
    ]);
    const fetchFn = (async (input: string | URL | Request) => {
      const body = served.get(String(input));
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    }) as never;
    const state = createFetchState();
    const at = Date.parse(AUSTRIA_AT);
    const alerts = await fetchEndpoint(feed, "alerts", fetchFn, { state, at });
    if (alerts.status !== "partial") throw new Error(`unexpected ${alerts.status}`);
    const shapes = await fetchEndpoint(feed, "geocodes", fetchFn, { state, at });
    if (shapes.status !== "fetched") throw new Error(`unexpected ${shapes.status}`);
    const out = parse({ alerts: alerts.buffers, geocodes: shapes.buffers }, AUSTRIA_AT);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations.map((s) => locationOf(s).admin?.country)).toContain("AT");
    expect(locationOf(out.situations[0]!).geometryOrigin).toBe("derived");
    // France's Pyrénées-Orientales is drawn through the vendored aliases.
    const france = out.situations.filter((s) => locationOf(s).admin?.country === "FR");
    expect(france.map((s) => locationOf(s).geometryOrigin)).toContain("derived");
  });
});
