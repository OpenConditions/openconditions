import { proposeLink } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { BORDER_CROSSINGS, crossingOfCbpPort, crossingOfCbsaOffice } from "../crossings.js";
import { parseCbp } from "../formats/cbp.js";
import { parseCbsa } from "../formats/cbsa.js";
import { cbpFeed, cbsaFeed, fixture, parseContext } from "./helpers/border-feed.js";
import { borderRegistry } from "./helpers/seal.js";

const { crossings } = BORDER_CROSSINGS;

describe("the crossing table", () => {
  it("names each Wikidata item, CBP port and CBSA office once", () => {
    const once = (ids: string[]) => expect(new Set(ids).size).toBe(ids.length);
    once(crossings.map((c) => c.wikidata));
    once(crossings.flatMap((c) => c.cbp));
    once(crossings.flatMap((c) => c.cbsa));
    expect(BORDER_CROSSINGS.license).toBe("CC0-1.0");
    expect(BORDER_CROSSINGS.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("joins the U.S. to Canada or Mexico, in a zone and a place on that border", () => {
    for (const c of crossings) {
      expect(c.wikidata).toMatch(/^Q\d+$/);
      expect(c.name).not.toBe("");
      expect([
        ["CA", "US"],
        ["MX", "US"],
      ]).toContainEqual([...c.countries]);
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: c.zone })).not.toThrow();
      expect(c.cbp.length + c.cbsa.length).toBeGreaterThan(0);
      if (c.cbsa.length > 0) expect(c.countries).toContain("CA");
      const northern = c.countries.includes("CA");
      expect(c.lat).toBeGreaterThan(northern ? 41.5 : 25.5);
      expect(c.lat).toBeLessThan(northern ? 49.1 : 32.8);
      expect(c.lon).toBeGreaterThan(-125);
      expect(c.lon).toBeLessThan(-66.9);
    }
  });

  it("covers every port and office of the live captures but CBP's El Paso without a crossing", () => {
    const ports = (
      JSON.parse(fixture("cbp-bwtnew.json").toString("utf8")) as { port_number: string }[]
    ).map((p) => p.port_number);
    expect(ports.filter((p) => crossingOfCbpPort(p) === undefined)).toEqual(["240221"]);
    const offices = fixture("cbsa-bwt-eng.csv")
      .toString("utf8")
      .split(/\r?\n/)
      .slice(1)
      .map((row) => row.split(";;")[0]!.trim())
      .filter(Boolean);
    expect(offices).toHaveLength(30);
    expect(offices.filter((o) => crossingOfCbsaOffice(o) === undefined)).toEqual([]);
  });
});

describe("linking", () => {
  const rules = borderRegistry().kind("feature", "border_crossing")?.linking;
  const cbp = parseCbp(
    cbpFeed(),
    { main: [fixture("cbp-bwtnew.json")] },
    parseContext("2026-10-14T23:38:05Z"),
  );
  const cbsa = parseCbsa(
    cbsaFeed(),
    { main: [fixture("cbsa-bwt-eng.csv")] },
    parseContext("2026-10-14T23:38:07Z"),
  );
  const feature = (features: typeof cbp.features, id: string) =>
    features.find((f) => f["id"] === id) as never;

  it("links the two agencies' features of one crossing, which share its place", () => {
    const link = proposeLink(
      feature(cbp.features, "oc:feature:us-cbp-waits:090101"),
      feature(cbsa.features, "oc:feature:ca-cbsa-waits:peace-bridge"),
      rules,
    );
    expect(link).toMatchObject({ status: "accepted" });
  });

  it("never links two CBP ports, even at one place", () => {
    const otay = parseCbp(
      cbpFeed(),
      {
        main: [
          Buffer.from(
            JSON.stringify(
              ["250601", "250602"].map((port_number) => ({
                port_number,
                port_name: "Otay Mesa",
                date: "10/14/2026",
                time: "16:33:33",
                port_status: "Open",
                commercial_vehicle_lanes: { maximum_lanes: "5" },
              })),
            ),
          ),
        ],
      },
      parseContext("2026-10-14T23:38:05Z"),
    );
    expect(otay.features).toHaveLength(2);
    expect(
      proposeLink(otay.features[0] as never, otay.features[1] as never, rules),
    ).toBeUndefined();
  });
});
