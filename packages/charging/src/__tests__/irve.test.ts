import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";
import { byReadingId, fullAndStatus } from "./helpers/status-only.js";

const FETCHED = "2026-10-06T02:45:56Z";

function parse(payloads: FeedPayloads, fetchedAt = FETCHED): ParseOutput {
  const out = chargingDomain.formats["irve"]!.parse(
    catalogFeed("fr-irve-charging"),
    payloads,
    parseContext(fetchedAt),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
  externalIds?: { scheme: string; id: string }[];
};
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const site = (out: ParseOutput, id: string) =>
  out.features.find((f) => f["id"] === `oc:feature:fr-irve-charging:${id}`);
const evsesOf = (draft: RecordDraft | undefined) =>
  components(draft).filter((c) => c.kind === "evse");
const readings = (out: ParseOutput) =>
  out.observations.map((o) => ({
    key: (o["subject"] as { componentKey: string }).componentKey,
    value: (o["result"] as { value: string }).value,
    at: (o["phenomenonTime"] as { instant: string }).instant,
  }));

const both = () =>
  parse({ main: [fixture("irve-static.csv")], status: [fixture("irve-dynamic.csv")] });

describe("irve", () => {
  test("IRVE: two PDCs of one station are two EVSEs; 'occupe' is occupied, read at its horodatage", () => {
    const out = both();
    const station = site(out, "FRBFCPVDIUF");
    expect(evsesOf(station).map((e) => e.key)).toEqual(["FRBFCEVDIUF1", "FRBFCEVDIUF2"]);
    expect(evsesOf(station)[0]).toMatchObject({
      externalIds: [{ scheme: "emi3:evse", id: "FRBFCEVDIUF1" }],
      details: { evseId: "FRBFCEVDIUF1" },
    });
    // The PDC's nominal power is the Type 2 plug's; the domestic socket on the
    // same PDC is not rated by it, and a cable the source does not state is left open.
    const plugs = components(station).filter((c) => c.parentKey === "FRBFCEVDIUF2");
    expect(plugs.map((c) => c.details)).toEqual([
      { kind: "connector", v: 1, standard: "DOMESTIC_E", format: "socket", current: "ac" },
      { kind: "connector", v: 1, standard: "IEC_62196_T2", current: "ac", maxPowerKw: 22 },
    ]);
    expect(plugs.map((c) => c.key)).toEqual(["FRBFCEVDIUF2/ef", "FRBFCEVDIUF2/2"]);
    expect(station).toMatchObject({
      name: [{ lang: "fr", text: "SICECO - SEMUR-EN-AUXOIS - Park. Rue Jean Jacques Collenot" }],
      operator: { name: [{ lang: "fr", text: "Citeos Mobilité Electrique Paris - Cogelum IDF" }] },
      location: { geometry: { type: "Point", coordinates: [4.335454, 47.490227] } },
      openingHours: { osm: "24/7" },
      access: { audience: "public" },
    });
    expect(readings(out).filter((r) => r.key.startsWith("FRBFCEVDIUF"))).toEqual([
      // The reading is as of the status time the source gives it.
      { key: "FRBFCEVDIUF1", value: "out_of_order", at: "2026-10-05T16:55:37.034Z" },
      { key: "FRBFCEVDIUF2", value: "occupied", at: "2026-10-06T02:01:51.861Z" },
    ]);
  });

  test("IRVE: one operator's stations within 15 m are one site", () => {
    const lines = fixture("irve-static.csv").toString("utf8").split("\n");
    // The second PDC under a station of its own, 4 m east: one station per charger.
    const second = lines[2]!
      .replace(",FRBFCPVDIUF,", ",FRBFCPVDIUG,")
      .replace('"[4.335454, 47.490227]"', '"[4.335507, 47.490227]"');
    const out = parse({
      main: [Buffer.from([lines[0], lines[1], second, ...lines.slice(3)].join("\n"))],
      status: [fixture("irve-dynamic.csv")],
    });
    expect(site(out, "FRBFCPVDIUG")).toBeUndefined();
    const station = site(out, "FRBFCPVDIUF");
    expect(evsesOf(station).map((e) => e.key)).toEqual(["FRBFCEVDIUF1", "FRBFCEVDIUF2"]);
    expect(readings(out).filter((r) => r.key.startsWith("FRBFCEVDIUF"))).toHaveLength(2);
  });

  test("IRVE: the tarification is the site's tariff text, the horaires OSM hours when they parse", () => {
    const out = both();
    expect(site(out, "FRBFCPVDIUF")?.["details"]).toMatchObject({
      tariffText: [
        {
          lang: "fr",
          text: "par défaut :  prix de départ 1.25€, 0.33334€ par kwh de charge, 0.25€ par heure de charge, 0.25€ par heure d'occupation hors charge",
        },
      ],
    });
    const acelec = site(out, "FR073P777022");
    expect(acelec).toMatchObject({ openingHours: { osm: "Mo-Fr 08:00-19:00" } });
    expect(acelec?.["details"]).toMatchObject({
      tariffText: [{ lang: "fr", text: "0.27€/kWh+0.10€/min pour les non abonnées" }],
    });
    // "08:00-08:00" is no span the grammar can read: the publisher's text stays.
    const unclear = site(out, "FR073PCAMAIEUFR");
    expect(unclear?.["openingHours"]).toBeUndefined();
    expect(unclear?.["details"]).toMatchObject({
      openingHoursText: [{ lang: "fr", text: "Mo-Su 08:00-08:00" }],
    });
    expect(out.offers).toEqual([]);
  });

  test("IRVE: stations without an id are grouped by position; the other statuses map as written", () => {
    const out = both();
    const grouped = out.features.find((f) => components(f).some((c) => c.key === "ATHTBE1012062"));
    expect(grouped?.["id"]).toBe("oc:feature:fr-irve-charging:49.87625,2.36735");
    expect(evsesOf(grouped).map((e) => e.key)).toEqual(["ATHTBE1012062", "ATHTBE1012063"]);
    expect(readings(out).filter((r) => r.key.startsWith("ATHTBE"))).toEqual([
      { key: "ATHTBE1012062", value: "out_of_order", at: "2026-10-05T13:09:46Z" },
      { key: "ATHTBE1012063", value: "available", at: "2026-10-05T13:09:46Z" },
    ]);

    const status = (rows: string) =>
      readings(
        parse({
          main: [fixture("irve-static.csv")],
          status: [Buffer.from(`id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage\n${rows}\n`)],
        }),
      );
    expect(
      status(
        [
          "FRBFCEVDIUF1,en_service,reserve,2026-10-05T10:00:00Z",
          "FRBFCEVDIUF2,en_service,inconnu,2026-10-05T10:00:00Z",
          "ATHTBE1012062,inconnu,libre,2026-10-05T10:00:00Z",
          "UNLISTED,en_service,libre,2026-10-05T10:00:00Z",
        ].join("\n"),
      ).map((r) => [r.key, r.value]),
    ).toEqual([
      ["FRBFCEVDIUF1", "reserved"],
      ["FRBFCEVDIUF2", "unknown"],
      ["ATHTBE1012062", "available"],
    ]);
  });

  test("IRVE: a repeated PDC row is no rejection and a repeated status is one reading of the newest", () => {
    const lines = fixture("irve-static.csv").toString("utf8").split("\n");
    const doubled = Buffer.from([...lines, lines[1]].join("\n"));
    const base = parse({ main: [fixture("irve-static.csv")] });
    const out = parse({
      main: [doubled],
      status: [
        Buffer.from(
          [
            "id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage",
            "FRBFCEVDIUF1,en_service,libre,2026-10-05T10:00:00Z",
            "FRBFCEVDIUF1,en_service,occupe,2026-10-05T12:00:00Z",
            "FRBFCEVDIUF1,hors_service,inconnu,2026-10-05T11:00:00Z",
          ].join("\n"),
        ),
      ],
    });
    expect(out.rejected).toBe(base.rejected);
    expect(readings(out)).toEqual([
      { key: "FRBFCEVDIUF1", value: "occupied", at: "2026-10-05T12:00:00Z" },
    ]);
  });

  test("IRVE: a status the source last changed over thirty days ago is no live reading", () => {
    const out = parse({
      main: [fixture("irve-static.csv")],
      status: [
        Buffer.from(
          [
            "id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage",
            "FRBFCEVDIUF1,en_service,libre,2026-07-30 10:31:30.264000+00:00",
            "FRBFCEVDIUF2,en_service,libre,2026-10-05 10:31:30.264000+00:00",
          ].join("\n"),
        ),
      ],
    });
    expect(readings(out)).toEqual([
      { key: "FRBFCEVDIUF2", value: "available", at: "2026-10-05T10:31:30.264Z" },
    ]);
  });

  test("IRVE: status alone, through the full parse's index, gives the full parse's readings", () => {
    const { full, status } = fullAndStatus(
      "irve",
      catalogFeed("fr-irve-charging"),
      { main: [fixture("irve-static.csv")], status: [fixture("irve-dynamic.csv")] },
      parseContext(FETCHED),
    );
    expect(full.observations.length).toBeGreaterThan(0);
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
  });

  test("IRVE: status alone lands on the site a merged station joined; an unknown PDC is rejected", () => {
    const lines = fixture("irve-static.csv").toString("utf8").split("\n");
    const second = lines[2]!
      .replace(",FRBFCPVDIUF,", ",FRBFCPVDIUG,")
      .replace('"[4.335454, 47.490227]"', '"[4.335507, 47.490227]"');
    const main = Buffer.from([lines[0], lines[1], second, ...lines.slice(3)].join("\n"));
    const rows = [
      "id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage",
      "FRBFCEVDIUF1,en_service,libre,2026-10-05T10:00:00Z",
      "FRBFCEVDIUF2,en_service,occupe,2026-10-05T10:00:00Z",
      "UNLISTED,en_service,libre,2026-10-05T10:00:00Z",
    ].join("\n");
    const { full, status } = fullAndStatus(
      "irve",
      catalogFeed("fr-irve-charging"),
      { main: [main], status: [Buffer.from(rows)] },
      parseContext(FETCHED),
    );
    expect(byReadingId(status.observations)).toEqual(byReadingId(full.observations));
    expect(status.observations.map((o) => o["subject"])).toEqual([
      {
        kind: "feature",
        featureId: "oc:feature:fr-irve-charging:FRBFCPVDIUF",
        componentKey: "FRBFCEVDIUF1",
      },
      {
        kind: "feature",
        featureId: "oc:feature:fr-irve-charging:FRBFCPVDIUF",
        componentKey: "FRBFCEVDIUF2",
      },
    ]);
    expect(status.rejected).toBe(1);
  });
});
