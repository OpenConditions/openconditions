import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import type { ChargingCatalogFeed } from "../feed-schema.js";
import { catalogFeed, ocpiFixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

const FETCHED = "2026-10-06T03:00:00Z";

function parse(feed: ChargingCatalogFeed, payloads: FeedPayloads, cadenceSec = 300): ParseOutput {
  const out = chargingDomain.formats["ocpi"]!.parse(
    feed,
    payloads,
    parseContext(FETCHED, cadenceSec),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  lifecycle?: string;
  externalIds?: { scheme: string; id: string }[];
  details: Record<string, unknown>;
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const byId = (records: RecordDraft[], id: string) => records.find((r) => r["id"] === id);
const readingsOf = (out: ParseOutput, featureId: string) =>
  out.observations.filter((o) => (o["subject"] as { featureId: string }).featureId === featureId);
const keyed = (out: ParseOutput, featureId: string) =>
  readingsOf(out, featureId).map((o) => [
    (o["subject"] as { componentKey: string }).componentKey,
    (o["result"] as { value: string }).value,
  ]);
const json = (name: string) => JSON.parse(ocpiFixture(name).toString("utf8"));

const ocpdbPayloads = (): FeedPayloads => ({
  main: [ocpiFixture("ocpdb-locations.json")],
  tariffs: [ocpiFixture("ocpdb-tariffs.json")],
  associations: [ocpiFixture("ocpdb-associations.json")],
  sources: [ocpiFixture("ocpdb-sources.json")],
});
const ocpdb = () => parse(catalogFeed("de-bw-mobidata-charging"), ocpdbPayloads());

describe("ocpi", () => {
  test("OCPDB: a relayed register charge point has no reading and credits its upstream", () => {
    const out = ocpdb();
    const site = byId(out.features, "oc:feature:de-bw-mobidata-charging:72555");
    expect(site).toMatchObject({
      lifecycle: "operational",
      // One row per upstream source of a site: the source qualifies the id.
      // The register's own device id is the one BNetzA's feed carries too.
      externalIds: [
        { scheme: "provider", id: "72555", authority: "de-bw-mobidata-charging/bnetza_api" },
        { scheme: "bnetza", id: "1002913" },
      ],
      provenance: {
        sourceFormat: "ocpi",
        upstream: [{ publisher: "Bundesnetzagentur", recordId: "1002913", license: "CC-BY-4.0" }],
      },
      location: { address: { street: "Viktoriastr. 5", city: "Lünen", country: "DE" } },
      openingHours: { osm: "24/7", twentyFourSeven: true },
    });
    expect(components(site).filter((c) => c.kind === "evse")).toHaveLength(2);
    // `STATIC` marks the register's rows: no live state, so no reading.
    expect(readingsOf(out, "oc:feature:de-bw-mobidata-charging:72555")).toEqual([]);
    // A source with a contributor is credited by it.
    expect(byId(out.features, "oc:feature:de-bw-mobidata-charging:308744")).toMatchObject({
      externalIds: [{ authority: "de-bw-mobidata-charging/datex2_enbw" }],
      provenance: { upstream: [{ publisher: "EnBW AG", license: "CC-BY-4.0" }] },
    });
    // A live row's state is read as of its status_last_updated, and holds
    // while the feed polls: it states no validity of its own.
    const live = readingsOf(out, "oc:feature:de-bw-mobidata-charging:308744");
    const reading = live.find(
      (o) => (o["subject"] as { componentKey: string }).componentKey === "262347503",
    );
    expect(reading).toMatchObject({
      result: { type: "category", value: "available", vocabulary: "evse_status" },
      phenomenonTime: { instant: "2026-10-05T16:49:24Z" },
    });
    expect(reading).not.toHaveProperty("validUntil");
  });

  test("OCPDB: tariff associations put the tariff offer ids on the right connectors", () => {
    const out = ocpdb();
    const site = byId(out.features, "oc:feature:de-bw-mobidata-charging:308745");
    const refs = Object.fromEntries(
      components(site)
        .filter((c) => c.kind === "connector")
        .map((c) => [c.key, c.details["tariffRefs"]]),
    );
    const flat = "oc:offer:de-bw-mobidata-charging:308745:138586";
    const ac = "oc:offer:de-bw-mobidata-charging:308745:138587";
    expect(refs).toEqual({
      "262347504/263132796": [flat],
      "262347505/263132797": [flat],
      "262347508/263132800": [flat],
      "262347507/263132799": [ac],
      "262347506/263132798": [flat],
    });
    const offers = out.offers.filter(
      (o) => (o["subject"] as { id: string }).id === "oc:feature:de-bw-mobidata-charging:308745",
    );
    expect(offers.map((o) => o["id"]).sort()).toEqual([flat, ac]);
    expect(byId(out.offers, flat)).toMatchObject({
      kind: "energy_tariff",
      tariffType: "ad_hoc",
      priceIncludesVat: false,
      provenance: { upstream: [{ publisher: "EnBW AG", license: "CC-BY-4.0" }] },
    });
    // The connectors' own tariff ids are upstream hashes that name no tariff.
    expect(JSON.stringify(out)).not.toContain("9f1fe2bb765152389c487ad0c5c33d67");
    // The register's site has no association, so no offer.
    expect(out.offers.filter((o) => String(o["id"]).includes(":72555:"))).toEqual([]);
  });

  test("OCPDB: the status role overrides the locations' own states by uid", () => {
    // OCPDB's `evses` endpoint: bare EVSEs, polled more often than the locations.
    const evses = {
      items: [
        // A register row the role now reports live.
        { uid: "259994189", status: "CHARGING", status_last_updated: "2026-10-06T02:50:00Z" },
        // One point of 308745 taken away: its connector and its tariff go with it.
        { uid: "262347507", status: "REMOVED", last_updated: "2026-10-06T02:40:00Z" },
        // Every point of 308744 taken away: the location goes.
        ...["262347500", "262347501", "262347502", "262347503"].map((uid) => ({
          uid,
          status: "REMOVED",
        })),
        // No EVSE of the locations has this uid.
        { uid: "999", status: "AVAILABLE" },
      ],
    };
    const out = parse(catalogFeed("de-bw-mobidata-charging"), {
      ...ocpdbPayloads(),
      status: [Buffer.from(JSON.stringify(evses))],
    });
    expect(keyed(out, "oc:feature:de-bw-mobidata-charging:72555")).toEqual([
      ["259994189", "charging"],
    ]);
    expect(byId(out.features, "oc:feature:de-bw-mobidata-charging:308744")).toBeUndefined();
    expect(readingsOf(out, "oc:feature:de-bw-mobidata-charging:308744")).toEqual([]);
    const site = byId(out.features, "oc:feature:de-bw-mobidata-charging:308745");
    expect(components(site).map((c) => c.key)).not.toContain("262347507");
    expect(keyed(out, "oc:feature:de-bw-mobidata-charging:308745").map(([key]) => key)).toEqual([
      "262347504",
      "262347505",
      "262347508",
      "262347506",
    ]);
    expect(out.offers.map((o) => o["id"])).not.toContain(
      "oc:offer:de-bw-mobidata-charging:308745:138587",
    );
    expect(JSON.stringify(out)).not.toContain('"999"');
  });

  test("NDW: a publish:false location is not emitted; a tariff id used by two parties gives two offers", () => {
    const locations = json("ndw-locations.json") as Record<string, unknown>[];
    const qwc = locations.find((l) => l["party_id"] === "QWC")!;
    // A location of CKE naming its own tariff `238`.
    const cke = { ...qwc, party_id: "CKE", id: "cke-1" };
    const out = parse(catalogFeed("nl-ndw-charging"), {
      main: [Buffer.from(JSON.stringify([...locations, cke]))],
      tariffs: [ocpiFixture("ndw-tariffs.json")],
    });
    expect(JSON.stringify(out.features)).not.toContain("TEU_04554");
    const qwcOffer = byId(out.offers, `oc:offer:nl-ndw-charging:NL*QWC*${qwc["id"]}:238`);
    const ckeOffer = byId(out.offers, "oc:offer:nl-ndw-charging:NL*CKE*cke-1:238");
    // Each party's own tariff 238: QWC charges 0.48 €/kWh, CKE 0.47.
    const energy = (offer: RecordDraft | undefined) =>
      (
        (offer?.["elements"] ?? []) as {
          components: { type: string; price: { amount: string } }[];
        }[]
      )
        .flatMap((e) => e.components)
        .find((c) => c.type === "energy")?.price.amount;
    expect(energy(qwcOffer)).toBe("0.48");
    expect(energy(ckeOffer)).toBe("0.47");
  });

  test("NDW: a connector without power gets V×A×phases", () => {
    const out = parse(catalogFeed("nl-ndw-charging"), {
      main: [ocpiFixture("ndw-locations.json")],
      tariffs: [ocpiFixture("ndw-tariffs.json")],
    });
    const site = byId(out.features, "oc:feature:nl-ndw-charging:NL*PFG*12084");
    expect(components(site).find((c) => c.kind === "connector")?.details).toMatchObject({
      standard: "IEC_62196_T2_COMBO",
      powerType: "DC",
      current: "dc",
      maxVoltage: 500,
      maxAmperage: 120,
      maxPowerKw: 60,
    });
    // `NL.SPI.ECO00317*1` is no eMI3 id: no `emi3:evse`, the uid is the key.
    const evse = components(site).find((c) => c.kind === "evse")!;
    expect(evse.key).toBe("NL.SPI.ECO00317*1");
    expect(evse.externalIds).toBeUndefined();
    // Two EVSEs with connector "1" and "2" each: four distinct components,
    // every reading on its own EVSE.
    const efl = byId(out.features, "oc:feature:nl-ndw-charging:NL*EFL*632b114cad9f2673374358a1");
    expect(components(efl).map((c) => c.key)).toEqual([
      "632b10529d3c68570ab72a6c",
      "632b10529d3c68570ab72a6c/1",
      "632b10529d3c68d523b72a6d",
      "632b10529d3c68d523b72a6d/2",
    ]);
    expect(keyed(out, efl!["id"] as string)).toEqual([
      ["632b10529d3c68570ab72a6c", "out_of_order"],
      ["632b10529d3c68d523b72a6d", "charging"],
    ]);
  });

  test("Lithuania: inline statuses read as of their Vilnius time; one last changed over 30 days back is none", () => {
    const body = json("lt-locations.json") as { data: Record<string, unknown>[] };
    // Location 258's second EVSE last changed on 2026-09-05 at 03:00, Vilnius
    // summer time: 31 days before the fetch.
    const loc258 = body.data.find((l) => l["id"] === 258)!;
    const [first, second] = loc258["evses"] as Record<string, unknown>[];
    loc258["evses"] = [first, { ...second, last_updated: "2026-09-05T03:00:00" }];
    const out = parse(catalogFeed("lt-vialietuva-charging"), {
      main: [Buffer.from(JSON.stringify(body))],
      tariffs: [ocpiFixture("lt-tariffs.json")],
    });
    const readings = readingsOf(out, "oc:feature:lt-vialietuva-charging:LT*IBG*278");
    expect(
      readings.map((o) => [
        (o["subject"] as { componentKey: string }).componentKey,
        o["phenomenonTime"],
      ]),
    ).toEqual([
      // 02:54:07 in Vilnius summer time.
      ["26897", { instant: "2026-10-05T23:54:07Z" }],
      ["26901", { instant: "2026-10-05T23:54:07Z" }],
    ]);
    expect(keyed(out, "oc:feature:lt-vialietuva-charging:LT*IBG*258")).toEqual([
      ["535", "available"],
    ]);
    // Location 440 is IGN's, its tariff 4 is IKR's; the id is unique, so it applies.
    const ign = byId(out.features, "oc:feature:lt-vialietuva-charging:LT*IGN*440");
    expect(components(ign).find((c) => c.kind === "connector")?.details["tariffRefs"]).toEqual([
      "oc:offer:lt-vialietuva-charging:LT*IGN*440:4",
    ]);
    // AC connectors are written `AC_1_PHASE` at 22 000 W: the published power stands.
    expect(components(ign).find((c) => c.kind === "connector")?.details).toMatchObject({
      powerType: "AC_1_PHASE",
      maxPowerKw: 22,
    });
  });

  test("one operator's locations within 15 m are one site, with their readings and tariffs", () => {
    const body = json("lt-locations.json") as { data: Record<string, unknown>[] };
    const loc258 = body.data.find((l) => l["id"] === 258)!;
    // A second location per charger 5 m north, as Lithuania lists them.
    const twin = {
      ...structuredClone(loc258),
      id: 1258,
      coordinates: { latitude: "54.6746020", longitude: "25.2243550" },
      evses: (loc258["evses"] as Record<string, unknown>[]).map((e) => ({
        ...e,
        uid: `${String(e["uid"])}0`,
        evse_id: undefined,
      })),
    };
    body.data.push(twin);
    const out = parse(catalogFeed("lt-vialietuva-charging"), {
      main: [Buffer.from(JSON.stringify(body))],
      tariffs: [ocpiFixture("lt-tariffs.json")],
    });
    expect(byId(out.features, "oc:feature:lt-vialietuva-charging:LT*IBG*1258")).toBeUndefined();
    const site = byId(out.features, "oc:feature:lt-vialietuva-charging:LT*IBG*258");
    expect(site?.["externalIds"]).toEqual([
      { scheme: "provider", id: "LT*IBG*258", authority: "lt-vialietuva-charging" },
      { scheme: "provider", id: "LT*IBG*1258", authority: "lt-vialietuva-charging" },
    ]);
    expect(
      components(site)
        .filter((c) => c.kind === "evse")
        .map((c) => c.key),
    ).toEqual(["535", "12032", "5350", "120320"]);
    expect(keyed(out, "oc:feature:lt-vialietuva-charging:LT*IBG*258").map(([k]) => k)).toEqual([
      "535",
      "12032",
      "5350",
      "120320",
    ]);
    for (const offer of out.offers.filter((o) => String(o["id"]).includes("LT*IBG*1258"))) {
      expect(offer["subject"]).toEqual({ class: "feature", id: site?.["id"] });
    }
  });

  test("OCPDB: the status role alone, through the full parse's index, gives the full parse's readings", () => {
    const evses = {
      items: [
        { uid: "259994189", status: "CHARGING", status_last_updated: "2026-10-06T02:50:00Z" },
        { uid: "262347507", status: "REMOVED", last_updated: "2026-10-06T02:40:00Z" },
        ...["262347500", "262347501", "262347502", "262347503"].map((uid) => ({
          uid,
          status: "REMOVED",
        })),
        { uid: "999", status: "AVAILABLE" },
      ],
    };
    const { full, status } = fullAndStatus(
      "ocpi",
      catalogFeed("de-bw-mobidata-charging"),
      { ...ocpdbPayloads(), status: [Buffer.from(JSON.stringify(evses))] },
      parseContext(FETCHED),
    );
    expect(full.observations.length).toBeGreaterThan(0);
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
    // The removed points left the snapshot's sites, and 999 was never in them.
    expect(status.rejected).toBe(6);
  });

  test("status alone reads a location's own state where the role names no EVSE, on the site it merged into", () => {
    const body = json("lt-locations.json") as { data: Record<string, unknown>[] };
    const loc258 = body.data.find((l) => l["id"] === 258)!;
    // A second location 5 m north whose EVSEs repeat the first's uids.
    const twin = {
      ...structuredClone(loc258),
      id: 1258,
      coordinates: { latitude: "54.6746020", longitude: "25.2243550" },
      evses: (loc258["evses"] as Record<string, unknown>[]).map((e) => ({
        ...e,
        evse_id: undefined,
      })),
    };
    body.data.push(twin);
    const payloads = {
      main: [Buffer.from(JSON.stringify(body))],
      tariffs: [ocpiFixture("lt-tariffs.json")],
      status: [
        Buffer.from(
          JSON.stringify([{ uid: "535", status: "CHARGING", last_updated: "2026-10-06T05:40:00" }]),
        ),
      ],
    };
    const { full, status } = fullAndStatus(
      "ocpi",
      catalogFeed("lt-vialietuva-charging"),
      payloads,
      parseContext(FETCHED),
    );
    // The status of uid 535 reaches both locations' EVSEs; 12032 keeps its own state.
    expect(keyed(full, "oc:feature:lt-vialietuva-charging:LT*IBG*258")).toEqual([
      ["535", "charging"],
      ["LT*IBG*1258:535", "charging"],
      ["12032", "available"],
      ["LT*IBG*1258:12032", "available"],
    ]);
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
    expect(status.rejected).toBe(0);
  });

  test("two tariff ids of one site that reduce to the same offer key stay two offers", () => {
    const tariffs = json("ndw-tariffs.json") as Record<string, unknown>[];
    const base = tariffs.find((t) => t["id"] === "A0")!;
    const locations = json("ndw-locations.json") as Record<string, unknown>[];
    const qwc = structuredClone(locations.find((l) => l["party_id"] === "QWC")!) as {
      evses: { connectors: { tariff_ids: string[] }[] }[];
    } & Record<string, unknown>;
    qwc.evses[0]!.connectors[0]!.tariff_ids = ["a*b", "a/b"];
    const out = parse(catalogFeed("nl-ndw-charging"), {
      main: [Buffer.from(JSON.stringify([qwc]))],
      tariffs: [
        Buffer.from(
          JSON.stringify([
            { ...base, party_id: "QWC", id: "a*b" },
            { ...base, party_id: "QWC", id: "a/b" },
          ]),
        ),
      ],
    });
    const offers = out.offers.map((o) => o["id"]);
    expect(offers).toEqual([
      `oc:offer:nl-ndw-charging:NL*QWC*${qwc["id"]}:a_b`,
      `oc:offer:nl-ndw-charging:NL*QWC*${qwc["id"]}:a_b_2`,
    ]);
    expect(components(out.features[0]).find((c) => c.kind === "connector")?.details).toMatchObject({
      tariffRefs: offers,
    });
  });
});
