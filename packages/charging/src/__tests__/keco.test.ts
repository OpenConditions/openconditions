import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

const FETCHED = "2026-10-06T03:00:00Z";

function parse(payloads: FeedPayloads): ParseOutput {
  const out = chargingDomain.formats["keco"]!.parse(
    catalogFeed("kr-keco-charging"),
    payloads,
    parseContext(FETCHED, 600),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Item = Record<string, string>;
type Envelope = { items: { item: Item[] } };
const json = (name: string) => JSON.parse(fixture(name).toString("utf8")) as Envelope;
const buffer = (doc: unknown) => Buffer.from(JSON.stringify(doc));

/** The documented samples, with the items a test adds. */
function payloads(info: Item[] = [], status?: Item[]): FeedPayloads {
  const infoDoc = json("keco-info.json");
  infoDoc.items.item.push(...info);
  const statusDoc = json("keco-status.json");
  if (status !== undefined) statusDoc.items.item = status;
  return { main: [buffer(infoDoc)], status: [buffer(statusDoc)] };
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:kr-keco-charging:${id}`);
const sample = json("keco-info.json").items.item[0]!;

describe("keco", () => {
  test("KECO: charger type 06 gives three connectors; status 3 at a Seoul time is charging in UTC", () => {
    const out = parse(
      payloads(
        [{ ...sample, chgerId: "03", chgerType: "06", output: "100", stat: "2" }],
        [
          // 12:00:01 in Seoul is 03:00:01 UTC, inside the thirty days.
          {
            busiId: "ME",
            statId: "28260005",
            chgerId: "03",
            stat: "3",
            statUpdDt: "20260906120001",
          },
          // 11:59:59 in Seoul is 02:59:59 UTC, older than thirty days; read as
          // UTC it would not be.
          {
            busiId: "ME",
            statId: "28260005",
            chgerId: "02",
            stat: "2",
            statUpdDt: "20260906115959",
          },
        ],
      ),
    );
    expect(out.features).toHaveLength(1);
    const station = site(out, "28260005");
    expect(
      components(station)
        .filter((c) => c.parentKey === "03")
        .map((c) => [c.key, c.details["standard"], c.details["current"], c.details["maxPowerKw"]]),
    ).toEqual([
      ["03/CHADEMO", "CHADEMO", "dc", 100],
      ["03/IEC_62196_T2", "IEC_62196_T2", "ac", undefined],
      ["03/IEC_62196_T1_COMBO", "IEC_62196_T1_COMBO", "dc", 100],
    ]);
    expect(out.observations).toHaveLength(1);
    expect(out.observations[0]).toMatchObject({
      property: "charging.evse_status",
      subject: { featureId: "oc:feature:kr-keco-charging:28260005", componentKey: "03" },
      result: { value: "charging" },
      phenomenonTime: { instant: "2026-09-06T03:00:01Z" },
    });
  });

  test("KECO: a change one status poll reported holds on the next, never reverting to the daily state", () => {
    const fresh = { statUpdDt: "20261006100000" };
    const charger = (chgerId: string, stat: string, statUpdDt: string) => ({
      busiId: "ME",
      statId: "28260005",
      chgerId,
      stat,
      statUpdDt,
    });
    const info = json("keco-info.json");
    info.items.item = [
      { ...sample, ...fresh, stat: "2" },
      { ...sample, ...fresh, chgerId: "03", stat: "2" },
    ];
    const delta = (items: Item[]) => {
      const doc = json("keco-status.json");
      doc.items.item = items;
      return buffer(doc);
    };
    // The daily file says both are free; the first status poll saw 02 start
    // charging, the second saw 03 start and 02 stay as it was (not listed).
    const out = parse({
      main: [buffer(info)],
      status: [
        delta([charger("02", "3", "20261006113000")]),
        delta([charger("03", "3", "20261006114000")]),
      ],
    });
    const states = out.observations.map((o) => [
      (o["subject"] as { componentKey: string }).componentKey,
      (o["result"] as { value: string }).value,
    ]);
    expect(states).toEqual([
      ["02", "charging"],
      ["03", "charging"],
    ]);
    // A delta older than the state it would replace changes nothing.
    const stale = parse({
      main: [buffer(info)],
      status: [delta([charger("02", "5", "20261006090000")])],
    });
    expect(stale.observations.map((o) => (o["result"] as { value: string }).value)).toEqual([
      "available",
      "available",
    ]);
    expect(chargingDomain.formats["keco"]!.endpoints["status"]).toEqual({
      required: false,
      accumulatesSince: "main",
      changesWindowSec: 600,
      status: true,
    });
  });

  test("KECO: the changes alone, through the full parse's index, give the full parse's readings", () => {
    const fresh = { statUpdDt: "20261006100000" };
    const charger = (statId: string, chgerId: string, stat: string, statUpdDt: string) => ({
      busiId: "ME",
      statId,
      chgerId,
      stat,
      statUpdDt,
    });
    const info = json("keco-info.json");
    info.items.item = [
      { ...sample, ...fresh, stat: "2" },
      { ...sample, ...fresh, chgerId: "03", stat: "2" },
      { ...sample, ...fresh, chgerId: "04", stat: "5" },
    ];
    const delta = (items: Item[]) => {
      const doc = json("keco-status.json");
      doc.items.item = items;
      return buffer(doc);
    };
    const changes = [
      delta([charger("28260005", "02", "3", "20261006113000")]),
      // Older than the daily state of 03: the daily state stands.
      delta([
        charger("28260005", "03", "5", "20261006090000"),
        charger("NOPE0001", "01", "2", "20261006114000"),
      ]),
    ];
    const { full, status } = fullAndStatus(
      "keco",
      catalogFeed("kr-keco-charging"),
      { main: [buffer(info)], status: changes },
      parseContext(FETCHED, 600),
    );
    expect(
      full.observations.map((o) => [
        (o["subject"] as { componentKey: string }).componentKey,
        (o["result"] as { value: string }).value,
      ]),
    ).toEqual([
      ["02", "charging"],
      ["03", "available"],
      ["04", "out_of_order"],
    ]);
    // Chargers no answer names keep the daily state, read again as of this poll.
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
    expect(status.rejected).toBe(1);
  });

  test("KECO: the documented charger is a site with its charger, operator and hours", () => {
    const out = parse(payloads());
    const station = site(out, "28260005");
    expect(station).toMatchObject({
      name: [{ lang: "ko", text: "기후대기관" }],
      operator: { name: [{ lang: "ko", text: "한국자동차환경협회" }] },
      description: [{ lang: "ko", text: "공사로 인해 이용 불가" }],
      location: {
        geometry: { type: "Point", coordinates: [126.641973, 37.56962] },
        address: { text: "인천광역시 서구 환경로 42", country: "KR" },
      },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      access: { audience: "public" },
    });
    expect(
      components(station).map((c) => [c.key, c.details["standard"], c.details["maxPowerKw"]]),
    ).toEqual([
      ["02", undefined, undefined],
      ["02/CHADEMO", "CHADEMO", 50],
      ["02/IEC_62196_T2", "IEC_62196_T2", undefined],
    ]);
    // The sample's status was last changed in 2019: no reading.
    expect(out.observations).toEqual([]);
  });

  test("KECO: a deleted charger is skipped, every charger type maps, and a restricted charger is restricted", () => {
    const chargers = ["01", "02", "04", "05", "07", "08", "09", "10", "11"].map((type, i) => ({
      ...sample,
      chgerId: String(10 + i),
      chgerType: type,
    }));
    const out = parse(
      payloads([
        ...chargers,
        { ...sample, chgerId: "30", delYn: "Y" },
        {
          ...sample,
          statId: "ME000001",
          statNm: "제한 충전소",
          limitYn: "Y",
          limitDetail: "거주자외 출입제한",
        },
      ]),
    );
    const station = site(out, "28260005");
    const byCharger = (id: string) =>
      components(station)
        .filter((c) => c.parentKey === id)
        .map((c) => c.details["standard"]);
    expect(["10", "11", "12", "13", "14", "15", "16", "17", "18"].map(byCharger)).toEqual([
      ["CHADEMO"],
      ["IEC_62196_T1"],
      ["IEC_62196_T1_COMBO"],
      ["CHADEMO", "IEC_62196_T1_COMBO"],
      ["IEC_62196_T2"],
      ["IEC_62196_T1_COMBO"],
      ["SAE_J3400"],
      ["IEC_62196_T1_COMBO", "SAE_J3400"],
      ["IEC_62196_T2_COMBO"],
    ]);
    expect(components(station).some((c) => c.key === "30")).toBe(false);
    expect(site(out, "ME000001")).toMatchObject({
      access: { audience: "restricted" },
      description: [{ lang: "ko", text: "공사로 인해 이용 불가; 거주자외 출입제한" }],
    });
  });
});
