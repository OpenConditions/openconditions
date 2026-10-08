import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { catalogFeed, datexFixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

const FETCHED = "2026-10-06T03:00:00Z";

function parse(feed: ChargingCatalogFeed, payloads: FeedPayloads): ParseOutput {
  const out = chargingDomain.formats["datex2"]!.parse(feed, payloads, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  externalIds?: { scheme: string; id: string }[];
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const byId = (records: RecordDraft[], id: string) => records.find((r) => r["id"] === id);

describe("datex2", () => {
  test("DATEX: DGT refill points become EVSEs with their connectors; Slovenia's rates become an offer", () => {
    const dgt = parse(catalogFeed("es-dgt-charging"), {
      main: [datexFixture("es-dgt-energy.xml")],
    });
    expect(dgt.features).toHaveLength(3);
    const almassora = byId(dgt.features, "oc:feature:es-dgt-charging:IXBKAMF4GUCULLK2GRK4");
    expect(almassora).toMatchObject({
      name: [{ lang: "es", text: "Consum - Almassora" }],
      operator: { role: "operator", name: [{ lang: "es", text: "CHARGING TOGETHER SL" }] },
      location: { address: { city: "Almassora", country: "ES" } },
      openingHours: { osm: "Mo-Sa 09:00-21:30" },
    });
    const evses = components(almassora).filter((c) => c.kind === "evse");
    expect(evses.map((c) => c.key)).toEqual([
      "ES*FCT*E230003",
      "ES*FCT*E230004",
      "ES*FCT*E232861",
      "ES*FCT*E232862",
    ]);
    expect(evses[0]!.externalIds).toEqual([{ scheme: "emi3:evse", id: "ESFCTE230003" }]);
    expect(components(almassora).find((c) => c.key === "ES*FCT*E232861/1")?.details).toEqual({
      kind: "connector",
      v: 1,
      standard: "IEC_62196_T2_COMBO",
      format: "cable",
      powerType: "DC",
      current: "dc",
      maxVoltage: 1000,
      maxAmperage: 500,
      maxPowerKw: 100,
    });
    // Two Type 2 sockets on one refill point are two connectors of one EVSE.
    const palma = byId(dgt.features, "oc:feature:es-dgt-charging:9TOKBPBKRBJVLI0RR4XG");
    expect(components(palma).map((c) => c.key)).toEqual([
      "ES*EMA*EMELIBMALLO531",
      "ES*EMA*EMELIBMALLO531/1",
      "ES*EMA*EMELIBMALLO531/2",
    ]);
    expect(components(palma)[1]!.details).toMatchObject({
      powerType: "AC_3_PHASE",
      maxPowerKw: 22.17,
    });
    expect(dgt.observations).toEqual([]);
    expect(dgt.offers).toEqual([]);

    const si = parse(catalogFeed("si-nap-charging"), { main: [datexFixture("si-nap-energy.xml")] });
    // The bicycle charger of Ruše is no charging site for a car.
    expect(si.features.map((f) => f["id"])).toEqual([
      "oc:feature:si-nap-charging:246ea408-3f25-4378-95a5-b9829851edc2",
      "oc:feature:si-nap-charging:41944637-9579-4337-9546-138bfb068d66",
    ]);
    const naklo = "oc:feature:si-nap-charging:41944637-9579-4337-9546-138bfb068d66";
    const offers = si.offers.filter((o) => (o["subject"] as { id: string }).id === naklo);
    expect(offers).toHaveLength(2);
    const offer = byId(
      si.offers,
      `oc:offer:si-nap-charging:41944637-9579-4337-9546-138bfb068d66:ea9984e6-8786-4c9e-913b-aebe4c167073-rp-c`,
    );
    expect(offer).toMatchObject({
      kind: "energy_tariff",
      subject: { class: "feature", id: naklo },
      currency: "EUR",
      elements: [
        {
          components: [
            { type: "energy", price: { amount: "0.35", currency: "EUR" }, unit: "kW.h" },
          ],
        },
      ],
    });
    // DATEX does not say whether a rate includes VAT.
    expect(offer).not.toHaveProperty("priceIncludesVat");
    const site = byId(si.features, naklo);
    expect(components(site).find((c) => c.key === "SI*GNE*E1297/1")?.details["tariffRefs"]).toEqual(
      [offer!["id"]],
    );
    expect(site).toMatchObject({ openingHours: { osm: "24/7", twentyFourSeven: true } });
  });

  describe("an inline table", () => {
    const rate = (id: string, policy: string, lines: string[], unit?: string) => `
      <fac:rates xsi:type="fac:RateTable" id="${id}">
        <fac:applicableCurrency>EUR</fac:applicableCurrency>
        <fac:energyPricingPolicy><fac:pricingPolicy>${policy}</fac:pricingPolicy></fac:energyPricingPolicy>
        <fac:rateLineCollection>${lines.join("")}</fac:rateLineCollection>
      </fac:rates>${unit === undefined ? "" : `<egi:deliveryUnit>${unit}</egi:deliveryUnit>`}`;
    const line = (type: string, value: string) =>
      `<fac:rateLine><fac:rateLineType>${type}</fac:rateLineType><fac:value>${value}</fac:value></fac:rateLine>`;
    const site = (id: string, lat: string, points: string[], operator = "Petrol d.d.") => `
      <egi:energyInfrastructureSite id="${id}">
        <fac:operator id="op"><fac:name><com:values><com:value lang="sl">${operator}</com:value></com:values></fac:name></fac:operator>
        <fac:locationReference xsi:type="loc:PointLocation"><loc:coordinatesForDisplay><loc:latitude>${lat}</loc:latitude><loc:longitude>14.5</loc:longitude></loc:coordinatesForDisplay></fac:locationReference>
        <egi:energyInfrastructureStation id="${id}-st">
          ${points
            .map(
              (p, i) =>
                `<egi:refillPoint xsi:type="egi:ElectricChargingPoint" id="${i}"><egi:connector><egi:connectorType>iec62196T2</egi:connectorType></egi:connector>${p}</egi:refillPoint>`,
            )
            .join("")}
        </egi:energyInfrastructureStation>
      </egi:energyInfrastructureSite>`;
    const table = (sites: string[]) =>
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:egi="http://datex2.eu/schema/3/energyInfrastructure" xmlns:fac="http://datex2.eu/schema/3/facilities" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureTablePublication" modelBaseVersion="3">
  <egi:energyInfrastructureTable id="t">${sites.join("")}</egi:energyInfrastructureTable>
</d2:payload>`);
    const status = (entries: [site: string, point: string, status: string][]) =>
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:egi="http://datex2.eu/schema/3/energyInfrastructure" xmlns:fac="http://datex2.eu/schema/3/facilities" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureStatusPublication" modelBaseVersion="3">
  ${entries
    .map(
      ([s, p, value]) => `<egi:energyInfrastructureSiteStatus id="${s}">
    <fac:lastUpdated>2026-10-06T02:50:00Z</fac:lastUpdated>
    <egi:energyInfrastructureStationStatus id="${s}-st">
      <egi:refillPointStatus id="${p}"><egi:status>${value}</egi:status></egi:refillPointStatus>
    </egi:energyInfrastructureStationStatus>
  </egi:energyInfrastructureSiteStatus>`,
    )
    .join("")}
</d2:payload>`);
    const si = (payloads: FeedPayloads) => parse(catalogFeed("si-nap-charging"), payloads);
    const offerOf = (out: ParseOutput, table: string) =>
      out.offers.find((o) => String(o["id"]).endsWith(`:${table}`));

    test("one operator's sites within 15 m are one site; the other's charge points keep apart", () => {
      const out = si({
        main: [table([site("S-2", "46.05", [""]), site("S-10", "46.05004", ["", ""])])],
        status: [status([["S-10", "1", "available"]])],
      });
      expect(out.features.map((f) => f["id"])).toEqual(["oc:feature:si-nap-charging:S-2"]);
      expect(components(out.features[0]).map((c) => c.key)).toEqual([
        "0",
        "0/1",
        "S-10:0",
        "S-10:0/1",
        "1",
        "1/1",
      ]);
      expect(out.observations.map((o) => o["subject"])).toEqual([
        { kind: "feature", featureId: "oc:feature:si-nap-charging:S-2", componentKey: "1" },
      ]);
    });

    test("status alone lands where the full parse put it; a point the sites no longer hold is rejected", () => {
      const statuses = status([
        ["S-10", "0", "charging"],
        ["S-10", "1", "available"],
        ["S-2", "0", "outOfOrder"],
        ["S-2", "7", "available"],
      ]);
      const { full, status: only } = fullAndStatus(
        "datex2",
        catalogFeed("si-nap-charging"),
        {
          main: [table([site("S-2", "46.05", [""]), site("S-10", "46.05004", ["", ""])])],
          status: [statuses],
        },
        parseContext(FETCHED),
      );
      expect(full.observations.map((o) => o["subject"])).toContainEqual({
        kind: "feature",
        featureId: "oc:feature:si-nap-charging:S-2",
        componentKey: "S-10:0",
      });
      expect(byReadingId(only.observations)).toEqual(byReadingId(full.observations));
      expect(only.rejected).toBe(1);
    });

    test("a removed refill point is no charge point; a site of removed points is no site", () => {
      const out = si({
        main: [table([site("A", "46.0", ["", ""]), site("B", "46.1", [""])])],
        status: [
          status([
            ["A", "1", "removed"],
            ["B", "0", "removed"],
          ]),
        ],
      });
      expect(out.features.map((f) => f["id"])).toEqual(["oc:feature:si-nap-charging:A"]);
      expect(components(out.features[0]).map((c) => c.key)).toEqual(["0", "0/1"]);
    });

    test("a rate line prices by its own type; a table with a line it cannot price is no offer", () => {
      const out = si({
        main: [
          table([
            site("A", "46.0", [
              rate("mixed", "pricePerDeliveryUnit", [
                line("perUnit", "0.39"),
                line("flatRate", "1.00"),
              ]),
              rate("capped", "pricePerDeliveryUnit", [
                line("perUnit", "0.39"),
                line("maximumRate", "30"),
              ]),
              rate("timed", "pricePerChargingTime", [line("perUnit", "0.05")]),
              rate("litres", "pricePerDeliveryUnit", [line("perUnit", "1.79")], "litre"),
            ]),
          ]),
        ],
      });
      expect(out.offers.map((o) => String(o["id"]).split(":").pop())).toEqual(["mixed"]);
      expect(offerOf(out, "mixed")?.["elements"]).toEqual([
        {
          components: [
            { type: "energy", price: { amount: "0.39", currency: "EUR" }, unit: "kW.h" },
            { type: "flat", price: { amount: "1", currency: "EUR" } },
          ],
        },
      ]);
    });
  });

  test("DATEX: a status reading lands on its refill point, joined on site, station and point", () => {
    // Lithuania numbers its refill points within a station: `0` is a point of
    // every station, so a status names its site and station too.
    const table = `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:egi="http://datex2.eu/schema/3/energyInfrastructure" xmlns:fac="http://datex2.eu/schema/3/facilities" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureTablePublication" modelBaseVersion="3">
  <egi:energyInfrastructureTable id="t">
    ${["257", "258"]
      .map(
        (n) => `<egi:energyInfrastructureSite id="EGI-S-${n}">
      <fac:name><com:values><com:value lang="lt">Site ${n}</com:value></com:values></fac:name>
      <fac:locationReference xsi:type="loc:PointLocation"><loc:coordinatesForDisplay><loc:latitude>54.6${n}</loc:latitude><loc:longitude>25.2</loc:longitude></loc:coordinatesForDisplay></fac:locationReference>
      <egi:energyInfrastructureStation id="EGI-ST-${n}">
        <egi:refillPoint xsi:type="egi:ElectricChargingPoint" id="0"><egi:connector><egi:connectorType>iec62196T2</egi:connectorType></egi:connector></egi:refillPoint>
        <egi:refillPoint xsi:type="egi:ElectricChargingPoint" id="1"><egi:connector><egi:connectorType>iec62196T2</egi:connectorType></egi:connector></egi:refillPoint>
      </egi:energyInfrastructureStation>
    </egi:energyInfrastructureSite>`,
      )
      .join("\n")}
  </egi:energyInfrastructureTable>
</d2:payload>`;
    // A point of site 258 being built, in a status publication of its own.
    const planned = `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="https://datex2.eu/schema/3/d2Payload" xmlns:egi="https://datex2.eu/schema/3/energyInfrastructure" xmlns:fac="https://datex2.eu/schema/3/facilities" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="egi:EnergyInfrastructureStatusPublication" modelBaseVersion="3">
  <egi:energyInfrastructureSiteStatus id="EGI-S-257">
    <fac:lastUpdated>2026-10-06T05:00:46+03:00</fac:lastUpdated>
    <egi:energyInfrastructureStationStatus id="EGI-ST-257">
      <egi:refillPointStatus id="0"><egi:status>PLANNED</egi:status></egi:refillPointStatus>
    </egi:energyInfrastructureStationStatus>
  </egi:energyInfrastructureSiteStatus>
</d2:payload>`;
    const out = parse(catalogFeed("es-dgt-charging"), {
      main: [Buffer.from(table)],
      status: [datexFixture("lt-energy-status.xml"), Buffer.from(planned)],
    });
    const reading = (site: string, key: string) =>
      out.observations.find(
        (o) =>
          (o["subject"] as { featureId: string }).featureId ===
            `oc:feature:es-dgt-charging:${site}` &&
          (o["subject"] as { componentKey: string }).componentKey === key,
      );
    // As of the site status's lastUpdated (05:00:46 at +03:00).
    expect(reading("EGI-S-258", "0")).toMatchObject({
      result: { value: "available" },
      phenomenonTime: { instant: "2026-10-06T02:00:46Z" },
    });
    // Site 257's out-of-order point last changed on 2025-11-21: no live state any more.
    expect(reading("EGI-S-257", "1")).toBeUndefined();
    // A planned point has no live state but its lifecycle.
    expect(reading("EGI-S-257", "0")).toBeUndefined();
    const site257 = out.features.find((f) => f["id"] === "oc:feature:es-dgt-charging:EGI-S-257");
    expect(components(site257).find((c) => c.key === "0")).toMatchObject({
      lifecycle: "planned",
    });

    // The same statuses alone, through the full parse's index.
    const only = chargingDomain.formats["datex2"]!.parseStatus!(
      catalogFeed("es-dgt-charging"),
      { status: [datexFixture("lt-energy-status.xml"), Buffer.from(planned)] },
      parseContext(FETCHED),
      out.statusIndex!,
    );
    expect(byReadingId(only.observations)).toEqual(byReadingId(out.observations));
  });
});
