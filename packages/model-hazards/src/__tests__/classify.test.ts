import { describe, expect, it } from "vitest";
import { capClassification } from "../classify.js";

describe("capClassification", () => {
  it("classifies a tornado warning's update by its VTEC phenomenon, not its generic SAME code", () => {
    const eventCodes = [
      { valueName: "SAME", value: "SVS" },
      { valueName: "NationalWeatherService", value: "TOW" },
    ];
    const parameters = [
      { valueName: "VTEC", value: "/O.CON.KICT.TO.W.0030.000000T0000Z-261001T0000Z/" },
    ];
    expect(capClassification(eventCodes, parameters)).toEqual({
      kind: "alert",
      type: "thunderstorm",
      subtype: "tornado",
    });
    expect(capClassification(eventCodes)).toEqual({ kind: "alert", type: "thunderstorm" });
  });

  it("reads each publisher's list, whatever the case or spelling of the words", () => {
    expect(capClassification([{ valueName: "II", value: "36" }])).toEqual({
      kind: "alert",
      type: "thunderstorm",
    });
    expect(
      capClassification([{ valueName: "profile:CAP-CP:Event:0.4", value: "STORMSURGE" }]),
    ).toEqual({ kind: "alert", type: "coastal", subtype: "storm_surge" });
    expect(capClassification([], [{ valueName: "awareness_type", value: "1; wind" }])).toEqual({
      kind: "alert",
      type: "wind",
    });
    expect(capClassification([{ valueName: "SAME", value: "TOR" }])).toEqual({
      kind: "alert",
      type: "thunderstorm",
      subtype: "tornado",
    });
  });

  it("prefers DWD's own code to a MeteoAlarm group", () => {
    expect(
      capClassification(
        [{ valueName: "II", value: "85" }],
        [{ valueName: "awareness_type", value: "2; snow-ice" }],
      ),
    ).toEqual({ kind: "alert", type: "snow_ice", subtype: "black_ice" });
  });

  it("reads NWS's product code after VTEC and before the generic SAME code", () => {
    expect(
      capClassification([
        { valueName: "NationalWeatherService", value: "AQA" },
        { valueName: "SAME", value: "NWS" },
      ]),
    ).toEqual({ kind: "alert", type: "air_quality" });
    expect(
      capClassification(
        [
          { valueName: "SAME", value: "SVS" },
          { valueName: "NationalWeatherService", value: "SVW" },
        ],
        [{ valueName: "VTEC", value: "/O.CON.KICT.TO.W.0030.000000T0000Z-261001T0000Z/" }],
      ),
    ).toEqual({ kind: "alert", type: "thunderstorm", subtype: "tornado" });
    expect(
      capClassification([
        { valueName: "SAME", value: "FFA" },
        { valueName: "NationalWeatherService", value: "FAA" },
      ]),
    ).toEqual({ kind: "alert", type: "flood" });
    expect(capClassification([{ valueName: "NationalWeatherService", value: "ESF" }])).toEqual({
      kind: "alert",
      type: "flood",
      subtype: "hydrologic",
    });
    expect(capClassification([{ valueName: "NationalWeatherService", value: "MWS" }])).toEqual({
      kind: "alert",
      type: "marine",
    });
    expect(capClassification([{ valueName: "NationalWeatherService", value: "TST" }])).toEqual({
      kind: "alert",
      type: "administrative",
      subtype: "test",
    });
    expect(
      capClassification([{ valueName: "NationalWeatherService", value: "SPS" }]),
    ).toBeUndefined();
  });

  it("leaves an alert whose codes name no hazard, or no list it knows, unclassified", () => {
    expect(
      capClassification([{ valueName: "profile:CAP-CP:Event:0.4", value: "other" }]),
    ).toBeUndefined();
    expect(capClassification([{ valueName: "SAME", value: "SPS" }])).toBeUndefined();
    expect(capClassification([{ valueName: "SAME", value: "NWS" }])).toBeUndefined();
    expect(
      capClassification([], [{ valueName: "awareness_type", value: "11; unused" }]),
    ).toBeUndefined();
    expect(capClassification([{ valueName: "SIVS", value: "wind" }])).toBeUndefined();
  });
});
