import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFetchState,
  type FeedPayloads,
  fetchEndpoint,
  type ParseOutput,
  type RecordDraft,
  unzipEntries,
} from "@openconditions/ingest-framework";
import { afterEach, describe, expect, test, vi } from "vitest";
import { capOutput } from "../cap/accounting.js";
import type { CapAlert } from "../cap/types.js";
import { readCapXml } from "../cap/xml.js";
import { hazardsDomain } from "../domain.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { dwdFeed, ecccFeed, fixture, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T22:00:00Z";
const cap = hazardsDomain.formats["cap"]!;
const parse = (feed: HazardsCatalogFeed, payloads: FeedPayloads, at = FETCHED): ParseOutput =>
  cap.parse(feed, payloads, parseContext(at));
/** Polls while the fit captures were current: DWD's of 2026-09-29, ECCC's of 2026-09-30. */
const DWD_FIT_AT = "2026-09-29T05:40:00Z";
const ECCC_FIT_AT = "2026-09-30T15:00:00Z";
const byKind = (records: readonly RecordDraft[]) =>
  records.map((r) => [r["type"], r["subtype"]].filter(Boolean).join("."));
/** A DWD identifier's issue time in epoch milliseconds, which tells the captured messages apart. */
const stamp = (identifier: string) => identifier.split(".")[8]!;
const identifierOf = (s: RecordDraft) =>
  (s["details"] as { cap: { identifier: string } }).cap.identifier;

describe("the cap format over the fit captures", () => {
  test("DWD: eight languages, and the islands cut out of the coastal warning", () => {
    const out = parse(
      dwdFeed(),
      { alerts: [fixture("dwd-thunderstorm.xml"), fixture("dwd-coastal-gusts-mul.xml")] },
      DWD_FIT_AT,
    );
    expect(sealFailures(out.situations)).toEqual([]);
    expect(byKind(out.situations)).toEqual(["thunderstorm", "wind.strong_wind"]);
    const gusts = out.situations[1]!;
    const event = (gusts["details"] as { cap: { event: { lang: string }[] } }).cap.event;
    expect(event.map((t) => t.lang)).toEqual(["de-DE", "en", "fr", "es", "ar", "ru", "tr", "pl"]);
    const geometry = (gusts["location"] as { geometry: { coordinates: unknown[] } }).geometry;
    expect(geometry.coordinates).toHaveLength(10);
    expect(out.records).toMatchObject({ inputCount: 2, accepted: 2, terminal: 0 });
  });

  test("ECCC: the all-clear ends the surge and supersedes the message it updates; fog is alert.other", () => {
    const files = ["eccc-storm-surge.xml", "eccc-storm-surge-ended.xml", "eccc-fog.xml"];
    const out = parse(ecccFeed(), { alerts: files.map(fixture) }, ECCC_FIT_AT);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations.map((s) => [s["kind"], byKind([s])[0]])).toEqual([
      ["alert", "coastal.storm_surge"],
      ["alert", "other"],
    ]);
    const [ended] = out.situations as [RecordDraft];
    expect(ended["validity"]).toMatchObject({ status: "ended", endedReason: "source_ended" });
    expect(ended["groupId"]).toBe("urn:oid:2.49.0.1.124.1565919500.2026");
    expect(out.records).toMatchObject({ inputCount: 3, uniqueCount: 3, accepted: 2, terminal: 1 });
  });
});

describe("the cap format: shapes for areas named only by warn cell", () => {
  /** The coast strong-wind warning of 2026-10-09, three coast cells and no polygon. */
  const COAST_AT = "2026-10-09T15:00:00Z";
  const coast = () => [fixture("dwd-coast-strong-wind-mul.xml")];
  const areas = () => [fixture("dwd-areas-coast.json"), fixture("dwd-areas-lakes.json")];
  const locationOf = (s: RecordDraft) =>
    s["location"] as {
      geometry: { type: string; coordinates: unknown[] } | null;
      geometryOrigin: string;
      admin?: { geocodes: { scheme: string; code: string }[] };
    };

  test("a coast warning takes the union of DWD's shapes for its cells, derived", () => {
    const out = parse(dwdFeed(), { alerts: coast(), areas: areas() }, COAST_AT);
    expect(sealFailures(out.situations)).toEqual([]);
    const [warning] = out.situations as [RecordDraft];
    // 501000005 and 501000001 are in the trimmed layer; 501000002, Helgoland, is not.
    expect(locationOf(warning)).toMatchObject({ geometryOrigin: "derived" });
    expect(locationOf(warning).geometry!.type).toBe("MultiPolygon");
    expect(locationOf(warning).admin!.geocodes).toContainEqual({
      scheme: "warncellid",
      code: "501000002",
    });
  });

  test("without the area layers, or with layers that do not read, the codes stand alone", () => {
    for (const payloads of [
      { alerts: coast() } as FeedPayloads,
      { alerts: coast(), areas: [Buffer.from("<html>503</html>"), Buffer.from('{"features":7}')] },
    ]) {
      const out = parse(dwdFeed(), payloads, COAST_AT);
      expect(locationOf(out.situations[0]!)).toMatchObject({
        geometry: null,
        geometryOrigin: "none",
      });
    }
  });

  test("a warning with its own polygons keeps them; its per-commune cells add nothing", () => {
    const own = parse(dwdFeed(), { alerts: [fixture("dwd-coastal-gusts-mul.xml")] }, DWD_FIT_AT);
    const withAreas = parse(
      dwdFeed(),
      { alerts: [fixture("dwd-coastal-gusts-mul.xml")], areas: areas() },
      DWD_FIT_AT,
    );
    expect(withAreas.situations.map((s) => s["location"])).toEqual(
      own.situations.map((s) => s["location"]),
    );
  });
});

describe("the cap format: what a parse keeps", () => {
  // A real DWD chain: the coastal warning of 05:17 and the update of 11:08 that replaced it.
  const zipEntries = () =>
    new Map(unzipFixture().map(({ name, data }) => [stamp(name), data] as const));
  const original = () => zipEntries().get("1791429420000")!;
  const update = () => zipEntries().get("1791450480000")!;

  test("an alert and the update referencing it are one situation: the update, grouped under the alert", () => {
    const a = readCapXml(original());
    const out = parse(dwdFeed(), { alerts: [original(), update()] });
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations).toHaveLength(1);
    const [b] = out.situations as [RecordDraft];
    expect((b["details"] as { cap: { msgType: string } }).cap.msgType).toBe("update");
    expect(b["relations"]).toEqual([
      {
        relation: "update_of",
        ref: { class: "situation", id: `oc:situation:de-dwd-alerts:${a.identifier}` },
      },
    ]);
    expect(b["groupId"]).toBe(a.identifier);
    expect(out.records).toMatchObject({ inputCount: 2, terminal: 1, accepted: 1 });
  });

  test("a cancel whose warning is gone is a cancelled situation that cancels it", () => {
    const a = readCapXml(original());
    const cancel = withAlert(update(), { msgType: "Cancel" });
    const out = parse(dwdFeed(), { alerts: [cancel] });
    expect(sealFailures(out.situations)).toEqual([]);
    const [record] = out.situations as [RecordDraft];
    expect(record["validity"]).toMatchObject({ status: "cancelled", endedReason: "cancelled" });
    expect(record["relations"]).toEqual([
      {
        relation: "cancels",
        ref: { class: "situation", id: `oc:situation:de-dwd-alerts:${a.identifier}` },
      },
    ]);
    expect(out.records).toMatchObject({ inputCount: 1, terminal: 0, accepted: 1 });
  });

  test("a message that is not Actual yields nothing and counts as terminal", () => {
    const out = parse(dwdFeed(), {
      alerts: [
        withAlert(original(), { status: "Test" }),
        withAlert(update(), { status: "Exercise" }),
      ],
    });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 2, terminal: 2, accepted: 0 });
  });

  test("a message without its header fields is rejected, the rest kept", () => {
    const out = parse(dwdFeed(), { alerts: [withAlert(original(), { sent: "" }), update()] });
    expect(out.situations).toHaveLength(1);
    expect(out.rejected).toBe(1);
    expect(out.records).toMatchObject({ inputCount: 2, uniqueCount: 2, accepted: 1, terminal: 0 });
  });

  test("a message that cannot be read is a unique record, rejected beside the terminal ones", () => {
    const out = parse(dwdFeed(), {
      alerts: [
        withAlert(original(), { status: "Exercise" }),
        withAlert(update(), { sent: "unknown" }),
        Buffer.from("<html><body>503</body></html>"),
      ],
    });
    expect(out.situations).toEqual([]);
    expect(out.rejected).toBe(2);
    expect(out.records).toMatchObject({ inputCount: 3, uniqueCount: 3, terminal: 1, accepted: 0 });
  });

  test("the same message twice is one", () => {
    const out = parse(dwdFeed(), { alerts: [update(), update()] });
    expect(out.situations).toHaveLength(1);
    expect(out.records).toMatchObject({
      inputCount: 2,
      uniqueCount: 1,
      duplicates: 1,
      accepted: 1,
    });
  });

  test("a payload that is no CAP message is a rejected record; the others publish", () => {
    const out = parse(dwdFeed(), {
      alerts: [update(), Buffer.from("<html><body>503</body></html>")],
    });
    expect(out.situations).toHaveLength(1);
    expect(out.rejected).toBe(1);
    expect(out.records).toMatchObject({ inputCount: 2, accepted: 1, terminal: 0 });
  });

  test("when every payload fails, the answer is the publisher's error and the parse fails", () => {
    expect(() =>
      parse(dwdFeed(), { alerts: [Buffer.from("<html><body>503</body></html>")] }),
    ).toThrow(/not alert/);
    expect(() =>
      parse(dwdFeed(), { alerts: [Buffer.from("<html/>"), Buffer.from("<error/>")] }),
    ).toThrow(/not alert/);
  });

  test("header tokens are read without their surrounding whitespace", () => {
    const out = parse(dwdFeed(), {
      alerts: [
        original(),
        withAlert(update(), { status: " Actual ", msgType: "\n Update\n" } as Partial<CapAlert>),
      ],
    });
    expect(out.situations).toHaveLength(1);
    expect(out.records).toMatchObject({ inputCount: 2, terminal: 1, accepted: 1 });
    expect(out.situations[0]!["relations"]).toMatchObject([{ relation: "update_of" }]);
  });

  test("a message that expired before the poll yields nothing and counts as terminal", () => {
    const storm = fixture("dwd-thunderstorm.xml");
    expect(parse(dwdFeed(), { alerts: [storm] }, DWD_FIT_AT).situations).toHaveLength(1);
    const later = parse(dwdFeed(), { alerts: [storm] }, "2026-09-29T06:00:00Z");
    expect(later.situations).toEqual([]);
    expect(later.records).toMatchObject({ inputCount: 1, terminal: 1, accepted: 0 });
  });

  test("every situation counts once in the accounting", () => {
    const out = parse(dwdFeed(), { alerts: [update()] });
    expect(out.records!.situationRecords).toEqual(
      Object.fromEntries(out.situations.map((s) => [s["id"], 1])),
    );
    expect(out.records).toMatchObject({
      unlocatable: 0,
      unlocatableSituations: [],
      unlocatableRecords: [],
    });
  });
});

/** The entries of the trimmed status zip, read as the feed's `unzip` reads it. */
function unzipFixture(): { name: string; data: Buffer }[] {
  return unzipEntries(fixture("dwd-stat-mul.zip"), { maxEntries: 10, maxBytes: 1 << 20 });
}

/** A captured message with header fields changed: the constructed cases. */
function withAlert(body: Buffer, change: Partial<CapAlert>): Buffer {
  let xml = body.toString("utf8");
  for (const [field, value] of Object.entries(change)) {
    xml = xml.replace(new RegExp(`<${field}>[^<]*</${field}>`), `<${field}>${value}</${field}>`);
  }
  return Buffer.from(xml);
}

describe("the cap format over its endpoints", () => {
  const T = Date.parse(FETCHED);
  afterEach(() => vi.restoreAllMocks());

  test("DWD: the status zip unzips into its CAP files, and the update replaces its warning", async () => {
    const zip = fixture("dwd-stat-mul.zip");
    const feed = dwdFeed();
    const serve = async () => new Response(new Uint8Array(zip));
    const res = await fetchEndpoint(feed, "alerts", serve as never, {
      state: createFetchState(),
      at: T,
    });
    if (res.status !== "fetched") throw new Error(`unexpected ${res.status}`);
    expect(res.buffers).toHaveLength(3);
    const out = parse(feed, { alerts: res.buffers });
    expect(sealFailures(out.situations)).toEqual([]);
    const messages = new Set(out.situations.map(identifierOf));
    expect([...messages].map(stamp)).toEqual(["1791450480000", "1791478140000"]);
    expect(out.records).toMatchObject({ inputCount: 3, terminal: 1 });
    // The gale warning names coast cells only; the gusts warning cuts EXCLUDE_POLYGON holes.
    const coast = out.situations.find((s) => String(s["id"]).includes("1791450480000"))!;
    expect(coast["location"]).toMatchObject({
      geometry: null,
      admin: {
        country: "DE",
        geocodes: [
          { scheme: "warncellid", code: "501000006" },
          { scheme: "warncellid", code: "501000007" },
        ],
      },
    });
    const gusts = out.situations.find((s) => String(s["id"]).includes("1791478140000"))!;
    const polygons = (
      gusts["location"] as { geometry: { type: string; coordinates: unknown[][][] } }
    ).geometry;
    expect(polygons.type).toBe("MultiPolygon");
    expect(polygons.coordinates.some((p) => p.length > 1)).toBe(true);
  });

  const DAY = "https://dd.weather.gc.ca/20261008/WXO-DD/alerts/cap/20261008/";
  const OFFICE = `${DAY}CWTO/`;
  const listing = (name: string) =>
    readFileSync(join(import.meta.dirname, "fixtures", "eccc-datamart", name), "utf8");
  const FILES: [string, string][] = [
    ["18", "T_WHCN13_C_CWTO_202610081811_2451493062.cap"],
    ["19", "T_WHCN13_C_CWTO_202610081936_2688257323.cap"],
    ["19", "T_WHCN13_C_CWTO_202610081959_1129882422.cap"],
  ];

  /** The Datamart as captured, served from memory; any other URL answers 404. */
  function datamart(day = listing("day.txt")) {
    const tree = new Map<string, string | Uint8Array<ArrayBuffer>>([
      [DAY, day],
      [OFFICE, listing("office.txt")],
      [`${OFFICE}18/`, listing("hour-18.txt")],
      [`${OFFICE}19/`, listing("hour-19.txt")],
    ]);
    for (const [hour, file] of FILES) {
      tree.set(`${OFFICE}${hour}/${file}`, new Uint8Array(fixture(`eccc-datamart/${file}`)));
    }
    return (async (input: string | URL | Request) => {
      const body = tree.get(String(input));
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    }) as never;
  }

  async function poll(fetch: never, parseAt = FETCHED) {
    const feed = ecccFeed();
    const state = createFetchState();
    // The tolerant index warns of the directory that answered 404.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const index = await fetchEndpoint(feed, "index", fetch, { state, at: T });
    // Yesterday's directory answers 404 in the stub; today's is the listing.
    if (index.status !== "partial") throw new Error(`unexpected ${index.status}`);
    const alerts = await fetchEndpoint(feed, "alerts", fetch, {
      state,
      at: T,
      eachSource: index.buffers,
      eachSourceUrls: index.urls,
    });
    if (alerts.status !== "fetched") throw new Error(`unexpected ${alerts.status}`);
    return parse(feed, { index: index.buffers, alerts: alerts.buffers }, parseAt);
  }

  test("ECCC: once the last update has expired, the walk still lists it and nothing is published", async () => {
    // Every hazard of the last message expired by 22:58:31 UTC; nothing supersedes it.
    const out = await poll(datamart(), "2026-10-08T23:30:00Z");
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 3, terminal: 3, accepted: 0 });
  });

  test("ECCC: one file of the walk that is no CAP message is rejected; the rest publish", async () => {
    const feed = ecccFeed();
    const files = FILES.map(([, file]) => fixture(`eccc-datamart/${file}`));
    const out = parse(feed, { alerts: [...files, Buffer.from("<html>busy</html>")] });
    expect(new Set(out.situations.map(identifierOf))).toEqual(
      new Set(["urn:oid:2.49.0.1.124.1129882422.2026"]),
    );
    expect(out.rejected).toBe(1);
    expect(out.records).toMatchObject({ inputCount: 4, terminal: 2 });
  });

  test("ECCC: two hour listings walk to three CAP files, of which the last update stands", async () => {
    const out = await poll(datamart());
    expect(sealFailures(out.situations)).toEqual([]);
    expect([...new Set(out.situations.map(identifierOf))]).toEqual([
      "urn:oid:2.49.0.1.124.1129882422.2026",
    ]);
    expect(new Set(out.situations.map((s) => s["groupId"]))).toEqual(
      new Set(["urn:oid:2.49.0.1.124.3058508579.2026"]),
    );
    expect(out.records).toMatchObject({
      inputCount: 3,
      terminal: 2,
      accepted: out.situations.length,
    });
  });

  test("ECCC: a day listing that names no office fails the walk; it is never an empty day", async () => {
    // Constructed: the day's listing with its one office removed. The Datamart
    // has no empty level, so such a page is a failed listing, not zero alerts.
    const empty = listing("day.txt").replace(/^.*href="CWTO\/".*\n/m, "");
    await expect(poll(datamart(empty))).rejects.toThrow(/matched no link/);
  });
});

test("capOutput over decoded messages is what the format returns", () => {
  const alerts = [readCapXml(fixture("dwd-thunderstorm.xml"))];
  const out = capOutput(alerts, dwdFeed(), { fetchedAt: DWD_FIT_AT });
  expect(out.situations).toHaveLength(1);
  expect(out).toEqual(parse(dwdFeed(), { alerts: [fixture("dwd-thunderstorm.xml")] }, DWD_FIT_AT));
});
