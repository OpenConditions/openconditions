import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDatexSituations, parseDatexSnapshot } from "../datex.js";
import { locationOf } from "../situation/location.js";
import type { SourceDescriptor } from "../types.js";

const source: SourceDescriptor = {
  id: "nl-ndw-events",
  country: "NL",
  attribution: "NDW",
  license: "CC0-1.0",
};
const alert = (primary = "22370", extras = "", type = "AlertCMethod2Point") =>
  `<alertCPoint xsi:type="${type}"><alertCLocationCountryCode>8</alertCLocationCountryCode><alertCLocationTableNumber>6.13</alertCLocationTableNumber><alertCLocationTableVersion>A</alertCLocationTableVersion><alertCMethod2PrimaryPointLocation><alertCLocation><specificLocation>${primary}</specificLocation></alertCLocation></alertCMethod2PrimaryPointLocation>${extras}</alertCPoint>`;
const document = (location: string) =>
  `<d2LogicalModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><payloadPublication xsi:type="SituationPublication"><situation id="s"><situationRecord xsi:type="Accident" id="r"><validity><validityStatus>active</validityStatus></validity><groupOfLocations xsi:type="Point">${location}</groupOfLocations></situationRecord></situation></payloadPublication></d2LogicalModel>`;

describe("DATEX VILD fallback", () => {
  it("keeps native identity, complete edition and coarse precision in canonical locations", () => {
    const event = parseDatexSituations(document(alert()), source)[0]!;
    expect(event).toBeDefined();
    expect(locationOf(event, source)).toMatchObject({
      geometry: { type: "Point", coordinates: [5.717227, 50.8408564] },
      geometryOrigin: "tmc_table",
      fuzziness: "low_res",
      tmc: { country: "8", table: 6, version: "6.13.A", code: 22370 },
      locationTable: { ref: "VILD", version: "6.13.A", license: "CC0-1.0" },
    });
  });
  it.each(["22370junk", "22370.9", "-1", ""])("rejects a malformed primary code %j", (primary) => {
    expect(parseDatexSituations(document(alert(primary)), source)).toEqual([]);
  });
  it.each([
    "<offsetDistance/>",
    "<offsetDistance>1</offsetDistance>",
    "<alertCMethod2SecondaryPointLocation/>",
  ])("refuses offset/secondary presence even when unreadable: %s", (extra) => {
    expect(parseDatexSituations(document(alert("22370", extra)), source)).toEqual([]);
  });
  it("preserves supplied coordinates instead of replacing them with the coded junction", () => {
    const event = parseDatexSituations(
      document(
        `${alert()}<pointByCoordinates><pointCoordinates><latitude>52.37</latitude><longitude>4.9</longitude></pointCoordinates></pointByCoordinates>`,
      ),
      source,
    )[0]!;
    expect(event.geometry).toEqual({ type: "Point", coordinates: [4.9, 52.37] });
    expect(event.locationTable).toBeUndefined();
    expect(locationOf(event, source)["fuzziness"]).toBe("exact");
  });
  it("accepts all nine formerly unlocated source records in the captured publication", () => {
    const snapshot = parseDatexSnapshot(
      readFileSync(new URL("./fixtures/vild/ndw-method2-points.xml", import.meta.url)),
      source,
    );
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.records).toHaveLength(9);
    expect(snapshot.records.every((r) => r.disposition === "accepted")).toBe(true);
    expect(
      snapshot.records.every(
        (r) => r.event?.locationTable?.ref === "VILD" && r.event.fuzziness === "low_res",
      ),
    ).toBe(true);
  });
});
