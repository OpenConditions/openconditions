import { describe, expect, it } from "vitest";
import { parseMivConfig, parseMivFlow } from "../miv.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "be-miv",
  attribution: "Agentschap Wegen en Verkeer / Vlaams Verkeerscentrum",
  country: "BE",
  license: "CC-BY-4.0",
} as SourceDescriptor;

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
  it("maps unieke_id → WGS84 Point (comma decimals, lon=lengtegraad)", () => {
    const map = parseMivConfig(CONFIG);
    expect(map.size).toBe(2);
    expect(map.get("4970")).toEqual({ type: "Point", coordinates: [4.4842054, 50.9828171] });
    expect(map.get("29")).toEqual({ type: "Point", coordinates: [3.7, 51.05] });
  });
});

describe("parseMivFlow", () => {
  it("uses the highest-intensity valid class's harmonic speed, joined to config geometry", () => {
    const siteMap = parseMivConfig(CONFIG);
    const { flows } = parseMivFlow(DATA, src, siteMap);
    // meetpunt 29 has no valid class (intensity 0 + the 252 no-data sentinel) → skipped.
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("be-miv:4970");
    // Class 2 has the higher intensity (120 > 30) → its 88 km/h wins.
    expect(flows[0]!.speedKph).toBe(88);
    expect(flows[0]!.sourceFormat).toBe("miv");
    expect(flows[0]!.geometry).toEqual({ type: "Point", coordinates: [4.4842054, 50.9828171] });
    expect(flows[0]!.dataUpdatedAt).toBe("2026-07-10T16:21:00+01:00");
  });

  it("skips points with no config geometry", () => {
    const { flows } = parseMivFlow(DATA, src, new Map());
    expect(flows).toHaveLength(0);
  });

  it("flags a hard parse failure", () => {
    expect(parseMivFlow("not xml <", src, new Map()).failed).toBe(true);
  });
});
