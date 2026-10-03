import { describe, expect, it } from "vitest";
import { parseMivConfig } from "../miv.js";
import { flowFeed, flows, readings, siteIds, value } from "./flow-fixtures.js";

const FEED = "be-miv";
const feed = flowFeed(FEED);

const CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<mivconfig>
  <meetpunt unieke_id="4970">
    <beschrijvende_id>H292L20</beschrijvende_id>
    <lengtegraad_EPSG_4326>4,4842054</lengtegraad_EPSG_4326>
    <breedtegraad_EPSG_4326>50,9828171</breedtegraad_EPSG_4326>
  </meetpunt>
  <meetpunt unieke_id="29">
    <beschrijvende_id>H222L10</beschrijvende_id>
    <lengtegraad_EPSG_4326>3,7</lengtegraad_EPSG_4326>
    <breedtegraad_EPSG_4326>51,05</breedtegraad_EPSG_4326>
  </meetpunt>
</mivconfig>`;

const DATA = `<?xml version="1.0" encoding="UTF-8"?>
<miv>
  <meetpunt unieke_id="4970">
    <tijd_waarneming>2026-07-10T16:21:00+01:00</tijd_waarneming>
    <defect>0</defect><geldig>1</geldig>
    <meetdata klasse_id="1"><verkeersintensiteit>30</verkeersintensiteit><voertuigsnelheid_harmonisch>95</voertuigsnelheid_harmonisch></meetdata>
    <meetdata klasse_id="2"><verkeersintensiteit>120</verkeersintensiteit><voertuigsnelheid_harmonisch>88</voertuigsnelheid_harmonisch></meetdata>
  </meetpunt>
  <meetpunt unieke_id="29">
    <defect>0</defect><geldig>0</geldig>
    <meetdata klasse_id="1"><verkeersintensiteit>0</verkeersintensiteit><voertuigsnelheid_harmonisch>252</voertuigsnelheid_harmonisch></meetdata>
  </meetpunt>
</miv>`;

describe("parseMivConfig", () => {
  it("places each unieke_id at its WGS84 point (comma decimals, lon=lengtegraad)", () => {
    const sites = parseMivConfig(CONFIG);
    expect(sites.size).toBe(2);
    expect(sites.get("4970")).toEqual({
      geometry: { type: "Point", coordinates: [4.4842054, 50.9828171] },
    });
    expect(sites.get("29")).toEqual({ geometry: { type: "Point", coordinates: [3.7, 51.05] } });
  });
});

describe("MIV traffic data", () => {
  it("uses the highest-intensity valid class's harmonic speed, joined to the configured point", () => {
    const out = flows(feed, DATA, parseMivConfig(CONFIG));
    // meetpunt 29 has no valid class (intensity 0 + the 252 no-data sentinel) → skipped.
    expect(siteIds(out, FEED)).toEqual(["4970"]);
    // Class 2 has the higher intensity (120 > 30) → its 88 km/h wins.
    expect(value(out, FEED, "4970", "traffic.speed")).toBe(88);
    expect(readings(out, FEED, "4970", "traffic.speed")[0]!["phenomenonTime"]).toMatchObject({
      end: "2026-07-10T15:21:00.000Z",
    });
  });

  it("skips points with no configured location", () => {
    expect(flows(feed, DATA, new Map()).features).toEqual([]);
  });

  it("refuses an unreadable body as a hard parse failure", () => {
    expect(() => flows(feed, "not xml <", new Map())).toThrow("hard parse failure");
  });
});
