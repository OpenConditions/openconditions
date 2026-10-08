import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import { sealFailures } from "./helpers/seal.js";

// The capture was taken on 2026-10-06 at 04:08 UTC; the KML carries no time.
const FETCHED = "2026-10-06T04:10:00Z";

function parse(body: Buffer = fixture("chargy.kml")): ParseOutput {
  const out = chargingDomain.formats["chargy"]!.parse(
    catalogFeed("lu-chargy-charging"),
    { main: [body] },
    parseContext(FETCHED, 600),
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
  out.features.find((f) => f["id"] === `oc:feature:lu-chargy-charging:${id}`);
const states = (out: ParseOutput) =>
  new Map(
    out.observations.map((o) => [
      (o["subject"] as { componentKey: string }).componentKey,
      (o["result"] as { value: string }).value,
    ]),
  );

/** The KML with one connector's state rewritten. */
const withState = (connectorId: number, state: string) =>
  Buffer.from(
    fixture("chargy.kml")
      .toString("utf8")
      .replace(new RegExp(`("id":${connectorId},[^}]*"description":")[A-Z_]+"`), `$1${state}"`),
  );

describe("chargy", () => {
  test("Chargy: connector OCPP states become connector status readings", () => {
    const out = parse();
    expect(out.features).toHaveLength(6);
    // The placemark is the site, keyed by its first device; each device is a
    // charge point and each of its connectors a plug of unknown standard.
    const brill = site(out, "10644");
    expect(brill).toMatchObject({
      name: [
        {
          lang: "und",
          text: "Esch-sur-Alzette - Parking souterrain Brill - Place de la Résistance",
        },
      ],
      location: {
        geometry: { type: "Point", coordinates: [5.97622, 49.492728] },
        address: { text: "Rue Louis Pasteur, L-4276 Esch-sur-Alzette Luxembourg", country: "LU" },
      },
    });
    expect(
      components(brill).map((c) => [
        c.key,
        c.parentKey,
        c.details["standard"],
        c.details["maxPowerKw"],
      ]),
    ).toEqual([
      ["10644", undefined, undefined, undefined],
      ["10644/59985", "10644", "UNKNOWN", 22.08],
      ["10644/59986", "10644", "UNKNOWN", 22.08],
      ["10645", undefined, undefined, undefined],
      ["10645/59987", "10645", "UNKNOWN", 22.08],
      ["10645/59988", "10645", "UNKNOWN", 22.08],
    ]);

    const read = states(out);
    expect(read.get("10644/59985")).toBe("charging");
    expect(read.get("10645/59988")).toBe("available");
    // Plugged in but not drawing power: in use, not charging.
    expect(read.get("439505/490626")).toBe("occupied"); // PREPARING
    expect(read.get("439906/491449")).toBe("occupied"); // FINISHING
    expect(read.get("439908/491451")).toBe("occupied"); // SUSPENDED_EVSE
    expect(read.get("439572/490831")).toBe("inoperative"); // UNAVAILABLE
    expect(read.get("440274/492057")).toBe("out_of_order"); // FAULT
    expect(read.get("842/50104")).toBe("unknown"); // OFFLINE
    // The file dates no state: every connector is read as of the fetch, and
    // holds while the feed polls (no validity of its own).
    const reading = out.observations.find(
      (o) => (o["subject"] as { componentKey: string }).componentKey === "10644/59985",
    );
    expect(reading).toMatchObject({
      property: "charging.connector_status",
      subject: { kind: "feature", featureId: "oc:feature:lu-chargy-charging:10644" },
      phenomenonTime: { instant: FETCHED },
    });
    expect(reading).not.toHaveProperty("validUntil");
    expect(out.observations.every((o) => o["property"] === "charging.connector_status")).toBe(true);
    expect(out.observations).toHaveLength(24);
  });

  test("Chargy: occupied, reserved and faulted connectors keep their own states", () => {
    expect(states(parse(withState(490832, "OCCUPIED"))).get("439573/490832")).toBe("occupied");
    expect(states(parse(withState(490832, "RESERVED"))).get("439573/490832")).toBe("reserved");
    expect(states(parse(withState(490832, "FAULTED"))).get("439573/490832")).toBe("out_of_order");
  });

  test("Chargy: a device of three connectors is one charge point; a high-power plug is not typed", () => {
    const capellen = site(parse(), "439572");
    const device = components(capellen).filter((c) => c.parentKey === "439628");
    expect(device.map((c) => [c.key, c.details["standard"], c.details["maxPowerKw"]])).toEqual([
      ["439628/490922", "UNKNOWN", 400],
      ["439628/491292", "UNKNOWN", 400],
      ["439628/491293", "UNKNOWN", 400],
    ]);
    expect(device.every((c) => c.details["current"] === undefined)).toBe(true);
  });

  test("Chargy: a placemark whose device ids are not numbers is keyed by the first in string order", () => {
    const kml = fixture("chargy.kml")
      .toString("utf8")
      .replace('{"id":10644,', '{"id":"CP-B",')
      .replace('{"id":10645,', '{"id":"CP-A",');
    const out = parse(Buffer.from(kml));
    expect(out.features).toHaveLength(6);
    expect(out.rejected).toBe(0);
    expect(components(site(out, "CP-A")).map((c) => c.key)).toEqual([
      "CP-B",
      "CP-B/59985",
      "CP-B/59986",
      "CP-A",
      "CP-A/59987",
      "CP-A/59988",
    ]);
  });
});
