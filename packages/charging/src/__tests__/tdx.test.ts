import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

// The live capture is stamped 2026-10-06T07:04:36+08:00.
const FETCHED = "2026-10-05T23:06:00Z";

type Rate = Record<string, unknown>;
type RateRow = { StationID: string; ConnectorID: string; Rates: Rate[] };

function payloads(editRates?: (rows: RateRow[]) => void): FeedPayloads {
  const rates = JSON.parse(fixture("tdx-rate.json").toString("utf8")) as {
    ChargingRates: RateRow[];
  };
  editRates?.(rates.ChargingRates);
  return {
    sites: [fixture("tdx-station.json")],
    tariffs: [Buffer.from(JSON.stringify(rates))],
    status: [fixture("tdx-live.json")],
  };
}

function parse(input: FeedPayloads = payloads()): ParseOutput {
  const out = chargingDomain.formats["tdx"]!.parse(
    catalogFeed("tw-tdx-charging"),
    input,
    parseContext(FETCHED, 3600),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:tw-tdx-charging:${id}`);
const offersOf = (out: ParseOutput, id: string) =>
  out.offers.filter(
    (o) => (o["subject"] as { id: string }).id === `oc:feature:tw-tdx-charging:${id}`,
  );

describe("tdx", () => {
  test("TDX: a ChargingRate with a weekday window becomes an offer with days and times", () => {
    const out = parse(
      payloads((rows) => {
        for (const row of rows.filter((r) => r.StationID === "TPE0514")) {
          row.Rates[2] = { ...row.Rates[2], DayType: 2 };
        }
      }),
    );
    const offers = offersOf(out, "TPE0514");
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      kind: "energy_tariff",
      currency: "TWD",
      elements: [
        {
          components: [{ type: "energy", price: { amount: "6.5", currency: "TWD" }, unit: "kW.h" }],
          restrictions: { startTime: "00:00", endTime: "08:00" },
        },
        {
          components: [{ type: "energy", price: { amount: "6.5", currency: "TWD" } }],
          restrictions: { startTime: "08:00", endTime: "16:00" },
        },
        {
          components: [{ type: "energy", price: { amount: "13.5", currency: "TWD" } }],
          restrictions: {
            startTime: "16:00",
            endTime: "22:00",
            days: ["MO", "TU", "WE", "TH", "FR"],
          },
        },
        {
          components: [{ type: "energy", price: { amount: "6.5", currency: "TWD" } }],
          restrictions: { startTime: "22:00" },
        },
      ],
    });
    // TDX says nothing about VAT; the station's rate text is the site's, not the offer's.
    expect(offers[0]).not.toHaveProperty("priceIncludesVat");
    expect(offers[0]).not.toHaveProperty("altText");
    // The rates are per connector: the two that have them name the offer.
    const station = site(out, "TPE0514");
    expect(
      components(station)
        .filter((c) => c.kind === "connector")
        .map((c) => [c.key, c.details["tariffRefs"]]),
    ).toEqual([
      ["90505425-P0094/90505425-C0094-1", [offers[0]?.["id"]]],
      ["90505425-P0094/90505425-C0094-2", undefined],
      ["90505425-P0095/90505425-C0095-1", [offers[0]?.["id"]]],
      ["90505425-P0095/90505425-C0095-2", undefined],
    ]);
  });

  test("TDX: live charge points are EVSEs with typed connectors, and their states are readings", () => {
    const out = parse();
    const ntu = site(out, "TPE0201U03");
    expect(ntu).toMatchObject({
      name: [{ lang: "zh-TW", text: "國立臺灣大學新南地下停車場" }],
      location: {
        geometry: { type: "Point", coordinates: [121.53387, 25.01912] },
        address: { text: "羅斯福路4段1號臺北市新生南路三段76巷對面", country: "TW" },
      },
      description: [{ lang: "zh-TW", text: "平日40元/時，假日40元/時" }],
      details: {
        openingHoursText: [{ lang: "zh-TW", text: "每日/00:00-24:00" }],
        tariffText: [{ lang: "zh-TW", text: "AC/計度/一般/ 7.8000元每度" }],
      },
    });
    expect(
      components(ntu).map((c) => [c.key, c.details["standard"], c.details["current"]]),
    ).toEqual([
      ["90807408-PCP03576", undefined, undefined],
      ["90807408-PCP03576/90807408-CCP03576", "IEC_62196_T1", "ac"],
      ["90807408-PCP03577", undefined, undefined],
      ["90807408-PCP03577/90807408-CCP03577", "IEC_62196_T1", "ac"],
      ["90807408-PCP03578", undefined, undefined],
      ["90807408-PCP03578/90807408-CCP03578", "IEC_62196_T2", "ac"],
    ]);
    const read = out.observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId.endsWith(":TPE0201U03"))
      .map((o) => [
        o["property"],
        (o["subject"] as { componentKey: string }).componentKey,
        (o["result"] as { value: string }).value,
        (o["phenomenonTime"] as { instant: string }).instant,
      ]);
    // As of each row's LastUpdateTime, 07:03:03 in Taipei.
    const at = "2026-10-05T23:03:03Z";
    expect(read).toEqual([
      ["charging.connector_status", "90807408-PCP03576/90807408-CCP03576", "occupied", at],
      ["charging.connector_status", "90807408-PCP03577/90807408-CCP03577", "available", at],
      ["charging.connector_status", "90807408-PCP03578/90807408-CCP03578", "available", at],
    ]);
    // Per kWh, the same at every point: one offer that all three plugs name.
    const [offer] = offersOf(out, "TPE0201U03");
    expect(offer).toMatchObject({
      elements: [{ components: [{ type: "energy", price: { amount: "7.8", currency: "TWD" } }] }],
    });
  });

  test("TDX: a status from January is no reading; a station without live points keeps its counted groups", () => {
    const out = parse();
    const arena = out.observations.filter((o) =>
      (o["subject"] as { featureId: string }).featureId.endsWith(":28371994-STP4900001"),
    );
    expect(arena).toHaveLength(8);
    expect(
      arena.some((o) =>
        (o["subject"] as { componentKey: string }).componentKey.startsWith("28371994-PTP4900009"),
      ),
    ).toBe(false);
    // Six charge points of one gun each, all Type 1: one group of six.
    const school = site(out, "33029464-STP6360001");
    expect(components(school)).toEqual([
      { key: "type-5", kind: "evse", details: { kind: "evse", v: 1, quantity: 6 } },
      {
        key: "type-5/1",
        parentKey: "type-5",
        kind: "connector",
        details: { kind: "connector", v: 1, standard: "IEC_62196_T1", current: "ac" },
      },
    ]);
    expect(school).toMatchObject({
      location: { address: { text: "台北市松山區復興北路361巷7號B1-B2停車場", country: "TW" } },
    });
    // RateType 3 is per minute in the schema and per hour at this station: no
    // offer, the station's own text stays its tariff.
    expect(offersOf(out, "33029464-STP6360001")).toEqual([]);
    expect(school?.["details"]).toMatchObject({
      tariffText: [{ lang: "zh-TW", text: "計時/每日/10元每1時" }],
    });
    // Two guns per charge point of two types: one group per type, uncounted.
    const fulin = site(parse({ sites: [fixture("tdx-station.json")] }), "TPE0514");
    expect(
      components(fulin).map((c) => [c.key, c.details["quantity"], c.details["standard"]]),
    ).toEqual([
      ["type-1", undefined, undefined],
      ["type-1/1", undefined, "IEC_62196_T1_COMBO"],
      ["type-2", undefined, undefined],
      ["type-2/1", undefined, "IEC_62196_T2_COMBO"],
    ]);
  });

  test("TDX: live states alone, through the full parse's index, give the full parse's readings", () => {
    const { full, status } = fullAndStatus(
      "tdx",
      catalogFeed("tw-tdx-charging"),
      payloads(),
      parseContext(FETCHED, 3600),
    );
    expect(full.observations.length).toBeGreaterThan(0);
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
    expect(status.rejected).toBe(0);
  });

  test("TDX: a connector the snapshot's live states did not name is rejected", () => {
    const live = {
      LiveStatuses: [
        {
          StationID: "TPE0514",
          ChargingPointID: "90505425-P0094",
          ConnectorID: "90505425-C0094-1",
          ConnectorType: 1,
          ConnectorStatus: 3,
          LastUpdateTime: "2026-10-06T07:03:47+08:00",
        },
        {
          StationID: "TPE0514",
          ChargingPointID: "90505425-P9999",
          ConnectorID: "90505425-C9999-1",
          ConnectorType: 1,
          ConnectorStatus: 1,
          LastUpdateTime: "2026-10-06T07:03:47+08:00",
        },
      ],
    };
    const { status } = fullAndStatus(
      "tdx",
      catalogFeed("tw-tdx-charging"),
      payloads(),
      parseContext(FETCHED, 3600),
      { status: [Buffer.from(JSON.stringify(live))] },
    );
    expect(status.observations.map((o) => [o["subject"], o["result"]])).toEqual([
      [
        {
          kind: "feature",
          featureId: "oc:feature:tw-tdx-charging:TPE0514",
          componentKey: "90505425-P0094/90505425-C0094-1",
        },
        { type: "category", value: "out_of_order", vocabulary: "evse_status" },
      ],
    ]);
    expect(status.rejected).toBe(1);
  });
});
