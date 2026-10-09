import { readFileSync } from "node:fs";
import {
  type CapAlert,
  type CapInfo,
  capOutput,
  type HazardsCatalogFeed,
  hazardsDomain,
  readCapXml,
  readMeteoAlarm,
} from "@openconditions/hazards";
import { sealRecord } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionRegistry } from "../index.js";

/**
 * Alerts fit check: real CAP messages from four publishers, read by the
 * hazards domain's own parsers into `alert` situations and sealed against
 * the production registry. Captured 2026-09-30 and 2026-10-01 from:
 * - the U.S. National Weather Service alerts API (CAP 1.2 per alert;
 *   public domain);
 * - Deutscher Wetterdienst open data, CAP warnings per district in every
 *   language DWD publishes (CC BY 4.0), captured 2026-09-29;
 * - Environment and Climate Change Canada's CAP datamart (ECCC Data
 *   Servers End-use Licence);
 * - MeteoAlarm's warnings API, the CAP of Météo-France, MET Norway and
 *   AEMET as JSON (CC BY 4.0 with MeteoAlarm's redistribution terms).
 * The NWS messages are its CAP XML, read by the `cap` format: the GeoJSON
 * the `us-nws-alerts` feed reads decodes into the same messages. Each
 * publisher's messages are read as one poll while they were current; a
 * message another message of the same poll updates is superseded, so the
 * ECCC chain is read message by message.
 */
const registry = productionRegistry();

const utf8 = (name: string) =>
  readFileSync(new URL(`./fixtures/alerts/${name}`, import.meta.url), "utf8");
const bytes = (name: string) => Buffer.from(utf8(name));

type Draft = Record<string, unknown>;

/**
 * A feed as its region file writes it: the fields its records take from the
 * feed (the loader's derived fields play no part in a parse).
 */
const feedOf = (
  id: string,
  format: string,
  country: string | undefined,
  license: string,
  attribution: string,
) =>
  ({
    id,
    format,
    region: country?.toLowerCase(),
    country,
    license,
    attribution,
  }) as HazardsCatalogFeed;

const NWS = feedOf(
  "us-nws-alerts",
  "cap",
  "US",
  "LicenseRef-US-Gov-Public-Domain",
  "National Weather Service (NOAA)",
);
const DWD = feedOf(
  "de-dwd-alerts",
  "cap",
  "DE",
  "CC-BY-4.0",
  "Deutscher Wetterdienst; Geobasisdaten © GeoBasis-DE / BKG 2021 (Daten modifiziert)",
);
const ECCC = feedOf(
  "ca-eccc-alerts",
  "cap",
  "CA",
  "LicenseRef-ECCC-Data-Servers-End-use",
  "Data Source: Environment and Climate Change Canada",
);
const METEOALARM = feedOf(
  "eu-meteoalarm-alerts",
  "meteoalarm",
  undefined,
  "LicenseRef-MeteoAlarm-Terms",
  "EUMETNET – MeteoAlarm",
);

/** Polls while the captures were current: before any of them expired. */
const NWS_AT = "2026-09-30T23:30:00Z";
const DWD_AT = "2026-09-29T05:40:00Z";
const ECCC_AT = "2026-09-30T15:00:00Z";
const METEOALARM_AT = "2026-09-25T22:00:00Z";

const ctx = (fetchedAt: string) => ({ fetchedAt, cadenceSec: 120, reference: {} });

const cap = hazardsDomain.formats["cap"]!;
const meteoalarm = hazardsDomain.formats["meteoalarm"]!;

/** The CAP files of one poll, read by the `cap` format. */
const capPoll = (feed: HazardsCatalogFeed, files: readonly string[], at: string): Draft[] =>
  cap.parse(feed, { alerts: files.map(bytes) }, ctx(at)).situations;

const nws = (name: string) => capPoll(NWS, [name], NWS_AT);

/** A message as the `cap` format maps it: the constructed cases, changed from a capture. */
const capMessage = (feed: HazardsCatalogFeed, alert: CapAlert, at: string): Draft[] =>
  capOutput([alert], feed, { fetchedAt: at }).situations;

const meteoalarmPoll = (alerts: readonly CapAlert[]): Draft[] =>
  meteoalarm.parse(
    METEOALARM,
    { alerts: [Buffer.from(JSON.stringify({ warnings: alerts.map((alert) => ({ alert })) }))] },
    ctx(METEOALARM_AT),
  ).situations;

const meteoalarmAlerts = readMeteoAlarm(bytes("meteoalarm-warnings.json"));
const meteoalarmSituations = meteoalarmPoll(meteoalarmAlerts);

function sealAll(records: readonly Draft[]) {
  return records.flatMap((r) => {
    const sealed = sealRecord(registry, r, {
      instanceId: "fit.example",
      revision: 1,
      recordedAt: NWS_AT,
    });
    return sealed.ok ? [] : [{ id: r["id"], issues: sealed.issues }];
  });
}

const byKind = (records: readonly Draft[]) =>
  records.map((r) => [r["type"], r["subtype"]].filter(Boolean).join("."));

const identifierOf = (record: Draft) =>
  (record["details"] as { cap: { identifier: string } }).cap.identifier;

describe("alerts fit check", () => {
  it("maps NWS alerts, classified by their VTEC phenomenon", () => {
    const records = [
      "nws-tornado-warning.xml",
      "nws-flood-warning.xml",
      "nws-flood-watch.xml",
      "nws-tropical-storm-warning.xml",
      "nws-extreme-heat-watch.xml",
    ].flatMap(nws);
    expect(sealAll(records)).toEqual([]);
    expect(byKind(records)).toEqual([
      "thunderstorm.tornado",
      "flood",
      "flood",
      "tropical_cyclone.tropical_storm",
      "heat.extreme",
    ]);
  });

  it("keeps a tornado warning's update as an update of the warning it continues", () => {
    const [tornado] = nws("nws-tornado-warning.xml") as [Draft];
    expect(tornado["severity"]).toEqual({
      label: "critical",
      source: "declared",
      declaredRaw: "Extreme",
    });
    expect(tornado["certainty"]).toBe("observed");
    expect(tornado["relations"]).toEqual([
      {
        relation: "update_of",
        ref: {
          class: "situation",
          id: "oc:situation:us-nws-alerts:urn:oid:2.49.0.1.840.0.93490fce2a191c24d1f347aa7be723bfaccb940a.001.1",
        },
      },
    ]);
    expect(tornado["groupId"]).toBe(
      "urn:oid:2.49.0.1.840.0.93490fce2a191c24d1f347aa7be723bfaccb940a.001.1",
    );
    const location = tornado["location"] as { geometry: { type: string }; admin: object };
    expect(location.geometry.type).toBe("Polygon");
    expect(location.admin).toEqual({
      country: "US",
      geocodes: [
        { scheme: "same", code: "020105" },
        { scheme: "same", code: "020167" },
        { scheme: "ugc", code: "KSC105" },
        { scheme: "ugc", code: "KSC167" },
      ],
    });
  });

  it("keeps a watch for later days as a forecast, and a zone watch without a polygon by its zones", () => {
    const [heat] = nws("nws-extreme-heat-watch.xml") as [Draft];
    expect(heat["temporality"]).toBe("forecast");
    const [watch] = nws("nws-flood-watch.xml") as [Draft];
    const location = watch["location"] as { geometry: unknown; geometryOrigin: string };
    expect(location.geometry).toBeNull();
    expect(location.geometryOrigin).toBe("none");
  });

  it("maps DWD warnings in every language, with islands cut out of the coast", () => {
    const records = capPoll(DWD, ["dwd-thunderstorm.xml", "dwd-coastal-gusts-mul.xml"], DWD_AT);
    expect(sealAll(records)).toEqual([]);
    expect(byKind(records)).toEqual(["thunderstorm", "wind.strong_wind"]);
    const [, gusts] = records as [Draft, Draft];
    const event = (gusts["details"] as { cap: { event: { lang: string; text: string }[] } }).cap
      .event;
    expect(event.map((t) => t.lang)).toEqual(["de-DE", "en", "fr", "es", "ar", "ru", "tr", "pl"]);
    expect(event[1]).toEqual({ lang: "en", text: "near gale" });
    const geometry = (gusts["location"] as { geometry: { type: string; coordinates: unknown[][] } })
      .geometry;
    expect(geometry.type).toBe("Polygon");
    expect(geometry.coordinates).toHaveLength(10);
    // The German block's instruction is empty and the translations' is not; an empty element is no text.
    const instruction = gusts["instruction"] as { lang: string }[];
    expect(instruction.map((t) => t.lang)).toEqual(["en", "fr", "es", "ar", "ru", "tr", "pl"]);
  });

  it("maps ECCC's bilingual alerts and ends the storm surge on its all-clear", () => {
    const records = ["eccc-storm-surge.xml", "eccc-storm-surge-ended.xml", "eccc-fog.xml"].flatMap(
      (f) => capPoll(ECCC, [f], ECCC_AT),
    );
    expect(sealAll(records)).toEqual([]);
    expect(byKind(records)).toEqual(["coastal.storm_surge", "coastal.storm_surge", "other"]);
    const [surge, ended, fog] = records as [Draft, Draft, Draft];
    expect((surge["relations"] as unknown[]).length).toBe(2);
    expect((surge["validity"] as { status: string }).status).toBe("active");
    expect(ended["validity"]).toMatchObject({ status: "ended", endedReason: "source_ended" });
    const details = fog["details"] as { cap: { event: unknown; category: string[] } };
    expect(details.cap.event).toEqual([
      { lang: "en-CA", text: "fog" },
      { lang: "fr-CA", text: "brouillard" },
    ]);
    expect((surge["details"] as { cap: { category: string[] } }).cap.category).toEqual([
      "env",
      "met",
    ]);
  });

  it("maps MeteoAlarm warnings, including an all-clear that names no area", () => {
    expect(sealAll(meteoalarmSituations)).toEqual([]);
    expect(byKind(meteoalarmSituations)).toEqual([
      "flood.rain",
      "flood.rain",
      "flood",
      "wind",
      "avalanche",
    ]);
    const allClear = meteoalarmSituations[1]!;
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
    const france = meteoalarmSituations[2]!["location"] as { admin: object; geometry: unknown };
    expect(france.geometry).toBeNull();
    expect(france.admin).toEqual({
      country: "FR",
      geocodes: [
        { scheme: "nuts", code: expect.stringMatching(/^FR/) },
        { scheme: "nuts", code: expect.stringMatching(/^FR/) },
      ],
    });
  });
});

/**
 * What CAP allows and these messages do not show, each made from a real
 * message by one change.
 */
describe("alerts fit check, cases the captures lack", () => {
  const tornado = () => readCapXml(bytes("nws-tornado-warning.xml"));

  it("splits a message whose info blocks warn of two hazards into two situations of one group", () => {
    const alert = tornado();
    const hail: CapInfo = {
      ...alert.info![0]!,
      eventCode: [{ valueName: "SAME", value: "SVR" }],
      parameter: [],
    };
    const records = capMessage(NWS, { ...alert, info: [alert.info![0]!, hail] }, NWS_AT);
    expect(sealAll(records)).toEqual([]);
    // The first part keeps the message's own id, so a later reference to the message resolves.
    expect(records.map((r) => r["id"])).toEqual([
      `oc:situation:us-nws-alerts:${alert.identifier}`,
      `oc:situation:us-nws-alerts:${alert.identifier}#2`,
    ]);
    expect(byKind(records)).toEqual(["thunderstorm.tornado", "thunderstorm.severe"]);
    expect(new Set(records.map((r) => r["groupId"])).size).toBe(1);
  });

  it("splits a MeteoAlarm message whose hazards differ only in their awareness type", () => {
    const [france] = meteoalarmAlerts.filter((a) => a.identifier.includes(".FR.")) as [CapAlert];
    const awareness = (info: CapInfo, type: string) => ({
      ...info,
      parameter: (info.parameter ?? []).map((p) =>
        p.valueName === "awareness_type" ? { ...p, value: type } : p,
      ),
    });
    const info = france.info![0]!;
    const records = meteoalarmPoll([
      { ...france, info: [awareness(info, "1; Wind"), awareness(info, "10; Rain")] },
    ]);
    expect(sealAll(records)).toEqual([]);
    expect(byKind(records)).toEqual(["wind", "rain"]);
  });

  it("groups an original warning with its updates", () => {
    const [original] = capPoll(DWD, ["dwd-thunderstorm.xml"], DWD_AT) as [Draft];
    expect(original["groupId"]).toBe(identifierOf(original));
  });

  it("keeps a cancellation as a cancelled situation that cancels the warning", () => {
    const [cancel] = capMessage(NWS, { ...tornado(), msgType: "Cancel" }, NWS_AT) as [Draft];
    expect(sealAll([cancel])).toEqual([]);
    expect(cancel["validity"]).toMatchObject({ status: "cancelled", endedReason: "cancelled" });
    expect((cancel["relations"] as { relation: string }[])[0]!.relation).toBe("cancels");
  });

  it("never inverts the validity of a message that expires before it takes effect", () => {
    const alert = tornado();
    const late = { ...alert.info![0]!, effective: "2026-09-30T19:30:00-05:00" };
    const [record] = capMessage(NWS, { ...alert, info: [late] }, "2026-09-30T23:50:00Z") as [Draft];
    expect(sealAll([record])).toEqual([]);
    expect(record["validity"]).toMatchObject({
      start: "2026-09-30T19:00:00-05:00",
      end: "2026-09-30T19:00:00-05:00",
    });
  });
});
