import { describe, expect, it } from "vitest";
import { parseFranceComptageStations } from "../stations-france.js";

const CSV = `code_pme;source;axe;longueur;nb_voies;x_deb;y_deb;x_fin;y_fin;code_traficolor
MUM76.h1;DIRNO;A28;3035;0;569981.6;6938140.0;568217.6;6935783.5;RO76
NOGEO.h1;DIRN;A1;0;0;;;;;RO1
`;

describe("parseFranceComptageStations", () => {
  it("reprojects Lambert-93 start/end into a WGS84 LineString keyed by code_pme", () => {
    const map = parseFranceComptageStations(CSV);
    // The row with empty coords is skipped.
    expect(map.size).toBe(1);
    const geom = map.get("MUM76.h1");
    expect(geom?.type).toBe("LineString");
    const coords = (geom as { coordinates: number[][] }).coordinates;
    expect(coords).toHaveLength(2);
    // Lambert-93 ~(569982, 6938140) is in Normandy: ~1.1°E, 49.6°N.
    for (const [lon, lat] of coords) {
      expect(lon).toBeGreaterThan(0);
      expect(lon).toBeLessThan(2);
      expect(lat).toBeGreaterThan(49);
      expect(lat).toBeLessThan(50);
    }
  });

  it("returns an empty map for a headerless or empty body", () => {
    expect(parseFranceComptageStations("").size).toBe(0);
    expect(parseFranceComptageStations("code_pme;x_deb\nA;1").size).toBe(0);
  });
});
