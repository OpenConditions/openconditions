import type { RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { capSituations } from "../cap/situations.js";
import type { CapAlert, CapArea } from "../cap/types.js";
import { readCapXml } from "../cap/xml.js";
import { dwdFeed, ecccFeed, fixture } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-01T00:30:00Z";
const cap = (name: string) => readCapXml(fixture(name));
const situations = (alert: CapAlert, feed = dwdFeed(), opts = {}) =>
  capSituations(alert, feed, { groupId: alert.identifier, fetchedAt: FETCHED, ...opts });
const byKind = (records: readonly RecordDraft[]) =>
  records.map((r) => [r["type"], r["subtype"]].filter(Boolean).join("."));
const location = (r: RecordDraft) => r["location"] as Record<string, unknown>;

describe("capSituations", () => {
  test("maps DWD warnings in every language, with islands cut out of the coast", () => {
    const storm = situations(cap("dwd-thunderstorm.xml"));
    const coast = situations(cap("dwd-coastal-gusts-mul.xml"));
    expect(sealFailures([...storm, ...coast])).toEqual([]);
    expect(byKind([...storm, ...coast])).toEqual(["thunderstorm", "wind.strong_wind"]);
    const [gusts] = coast as [RecordDraft];
    const event = (gusts["details"] as { cap: { event: { lang: string; text: string }[] } }).cap
      .event;
    expect(event.map((t) => t.lang)).toEqual(["de-DE", "en", "fr", "es", "ar", "ru", "tr", "pl"]);
    expect(event[1]).toEqual({ lang: "en", text: "near gale" });
    const geometry = location(gusts)["geometry"] as { type: string; coordinates: unknown[] };
    expect(geometry.type).toBe("Polygon");
    expect(geometry.coordinates).toHaveLength(10);
    expect(location(gusts)["geometryOrigin"]).toBe("source");
    // The German block's instruction is empty and the translations' is not; an empty element is no text.
    const instruction = gusts["instruction"] as { lang: string }[];
    expect(instruction.map((t) => t.lang)).toEqual(["en", "fr", "es", "ar", "ru", "tr", "pl"]);
  });

  test("takes the record's id, provenance and terms from the feed", () => {
    const alert = cap("dwd-coastal-gusts-mul.xml");
    const [gusts] = situations(alert, dwdFeed(), { groupId: "root" }) as [RecordDraft];
    expect(gusts["id"]).toBe(`oc:situation:de-dwd-alerts:${alert.identifier}`);
    expect(gusts["groupId"]).toBe("root");
    expect(gusts["provenance"]).toEqual({
      origin: "feed",
      sourceId: "de-dwd-alerts",
      sourceFormat: "cap",
      accessMode: "bulk",
      recordId: alert.identifier,
      sourceUpdatedAt: "2026-09-29T08:04:00+02:00",
      attribution: {
        provider:
          "Deutscher Wetterdienst; Geobasisdaten © GeoBasis-DE / BKG 2021 (Daten modifiziert)",
        license: "CC-BY-4.0",
        licenseUrl:
          "https://www.dwd.de/DE/service/rechtliche_hinweise/rechtliche_hinweise_node.html",
      },
      privacy: { class: "authoritative" },
    });
    expect(gusts["externalIds"]).toEqual([
      { scheme: "cap", id: alert.identifier, authority: "opendata@dwd.de" },
    ]);
    expect(gusts["relations"]).toEqual([
      {
        relation: "update_of",
        ref: {
          class: "situation",
          id: "oc:situation:de-dwd-alerts:2.49.0.0.276.0.DWD.PVW.1790657940000.0eac7b84-3cd2-470a-bb64-36d42feffe3c.MUL",
        },
      },
    ]);
    const expires = alert.info![0]!.expires!;
    expect(gusts["freshness"]).toEqual({ fetchedAt: FETCHED, expiresAt: expires });
    expect(location(gusts)["admin"]).toMatchObject({ country: "DE" });
  });

  test("maps ECCC's bilingual alerts and ends the storm surge on its all-clear", () => {
    const records = ["eccc-storm-surge.xml", "eccc-storm-surge-ended.xml", "eccc-fog.xml"].flatMap(
      (f) => situations(cap(f), ecccFeed()),
    );
    expect(sealFailures(records)).toEqual([]);
    expect(byKind(records)).toEqual(["coastal.storm_surge", "coastal.storm_surge", "other"]);
    const [surge, ended, fog] = records as [RecordDraft, RecordDraft, RecordDraft];
    expect((surge["relations"] as unknown[]).length).toBe(2);
    expect((surge["validity"] as { status: string }).status).toBe("active");
    expect(ended["validity"]).toMatchObject({ status: "ended", endedReason: "source_ended" });
    expect(fog["kind"]).toBe("alert");
    const details = fog["details"] as { cap: { event: unknown } };
    expect(details.cap.event).toEqual([
      { lang: "en-CA", text: "fog" },
      { lang: "fr-CA", text: "brouillard" },
    ]);
    expect((surge["details"] as { cap: { category: string[] } }).cap.category).toEqual([
      "env",
      "met",
    ]);
    // CAP-CP names Canada; the area codes are the Canadian profile's.
    const admin = location(fog)["admin"] as { country: string; geocodes: { scheme: string }[] };
    expect(admin.country).toBe("CA");
    expect(new Set(admin.geocodes.map((g) => g.scheme))).toEqual(new Set(["sgc", "eccc_clc"]));
  });

  test("groups an original warning with its updates", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const [original] = situations(alert) as [RecordDraft];
    expect(original["groupId"]).toBe(alert.identifier);
  });

  // The cases below are made from a real message by one change each.
  test("splits a message whose info blocks warn of two hazards into two situations of one group", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const info = alert.info![0]!;
    const gusts = {
      ...info,
      eventCode: info.eventCode!.map((e) => (e.valueName === "II" ? { ...e, value: "11" } : e)),
    };
    const records = situations({ ...alert, info: [info, gusts] });
    expect(sealFailures(records)).toEqual([]);
    expect(records.map((r) => r["id"])).toEqual([
      `oc:situation:de-dwd-alerts:${alert.identifier}`,
      `oc:situation:de-dwd-alerts:${alert.identifier}#2`,
    ]);
    expect(byKind(records)).toEqual(["thunderstorm", "wind.strong_wind"]);
    expect(new Set(records.map((r) => r["groupId"])).size).toBe(1);
  });

  test("keeps a cancellation as a cancelled situation that cancels the warning", () => {
    const alert = cap("dwd-coastal-gusts-mul.xml");
    const [cancel] = situations({ ...alert, msgType: "Cancel" }) as [RecordDraft];
    expect(sealFailures([cancel])).toEqual([]);
    expect(cancel["validity"]).toMatchObject({ status: "cancelled", endedReason: "cancelled" });
    expect((cancel["relations"] as { relation: string }[])[0]!.relation).toBe("cancels");
  });

  test("never inverts the validity of a message that expires before it takes effect", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const info = alert.info![0]!;
    const late = {
      ...info,
      effective: "2026-09-29T09:00:00+02:00",
      expires: "2026-09-29T08:00:00+02:00",
    };
    const [record] = situations({ ...alert, info: [late] }) as [RecordDraft];
    expect(sealFailures([record])).toEqual([]);
    expect(record["validity"]).toMatchObject({
      start: "2026-09-29T08:00:00+02:00",
      end: "2026-09-29T08:00:00+02:00",
    });
  });

  test("reads the Irish FIPS 10-4 and Czech CISORP area codes", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const info = alert.info![0]!;
    const area: CapArea = {
      areaDesc: "Dublin",
      geocode: [
        { valueName: "FIPS", value: "EI07" },
        { valueName: "FIPS", value: "US12" },
        { valueName: "CISORP", value: "2101" },
      ],
    };
    const [record] = situations({ ...alert, info: [{ ...info, area: [area] }] }) as [RecordDraft];
    expect(sealFailures([record])).toEqual([]);
    expect(location(record)).toMatchObject({
      geometry: null,
      extent: "area",
      geometryOrigin: "none",
      admin: {
        geocodes: [
          { scheme: "fips10_4", code: "EI07" },
          { scheme: "cisorp", code: "2101" },
        ],
      },
    });
  });

  test("takes a derived shape for an area that has only codes", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const info = alert.info![0]!;
    const area: CapArea = { areaDesc: "Zone", geocode: [{ valueName: "UGC", value: "KSZ001" }] };
    const shape = {
      type: "Polygon" as const,
      coordinates: [
        [
          [-100, 39],
          [-99, 39],
          [-99, 40],
          [-100, 39],
        ],
      ],
    };
    const geometryOf = (a: CapArea) =>
      a.areaDesc === "Zone" ? { geometry: shape, origin: "derived" as const } : undefined;
    const [record] = situations({ ...alert, info: [{ ...info, area: [area] }] }, dwdFeed(), {
      geometryOf,
    }) as [RecordDraft];
    expect(location(record)).toMatchObject({ geometry: shape, geometryOrigin: "derived" });
  });

  test("the expiry hook decides when the record stops being current", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const [record] = situations(alert, dwdFeed(), { expiresAt: () => "2026-10-01T00:35:00Z" }) as [
      RecordDraft,
    ];
    expect(record["freshness"]).toEqual({ fetchedAt: FETCHED, expiresAt: "2026-10-01T00:35:00Z" });
  });

  test("a blank exclusion names no hole and rejects nothing", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const info = alert.info![0]!;
    const area: CapArea = {
      areaDesc: "Area",
      polygon: ["50,10 51,10 51,11 50,10"],
      geocode: [{ valueName: "EXCLUDE_POLYGON", value: "  " }],
    };
    const [record] = situations({ ...alert, info: [{ ...info, area: [area] }] }) as [RecordDraft];
    expect(location(record)["geometry"]).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [10, 50],
          [10, 51],
          [11, 51],
          [10, 50],
        ],
      ],
    });
  });

  test("a polygon with a position out of range rejects its record", () => {
    const alert = cap("dwd-thunderstorm.xml");
    const info = alert.info![0]!;
    const area: CapArea = { areaDesc: "Bad", polygon: ["95,10 96,11 95,11 95,10"] };
    expect(situations({ ...alert, info: [{ ...info, area: [area] }] })).toEqual([]);
  });
});
