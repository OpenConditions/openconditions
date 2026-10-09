import { describe, expect, test } from "vitest";
import { readCapXml } from "../cap/xml.js";
import { fixture } from "./helpers/hazards-feed.js";

describe("readCapXml", () => {
  test("reads a message in CAP's shape: repeatable elements as lists, values as strings", () => {
    const alert = readCapXml(fixture("dwd-thunderstorm.xml"));
    expect(alert.identifier).toBe(
      "2.49.0.0.276.0.DWD.PVW.1790658060000.7cb973e0-bf11-4ad7-9803-29756f997052.DEU",
    );
    expect(alert.msgType).toBe("Alert");
    expect(alert.code).toEqual([
      "id:2.49.0.0.276.0.DWD.PVW.1790658060000.7cb973e0-bf11-4ad7-9803-29756f997052",
    ]);
    const [info] = alert.info!;
    expect(info!.category).toEqual(["Met"]);
    expect(info!.responseType).toEqual(["Prepare"]);
    expect(info!.eventCode).toContainEqual({ valueName: "II", value: "36" });
    // Never a number, even where the text reads as one.
    for (const area of info!.area!) {
      for (const g of area.geocode ?? []) expect(typeof g.value).toBe("string");
    }
  });

  test("reads every language of a multilingual message", () => {
    const alert = readCapXml(fixture("dwd-coastal-gusts-mul.xml"));
    expect(alert.info!.map((i) => i.language)).toEqual([
      "de-DE",
      "en",
      "fr",
      "es",
      "ar",
      "ru",
      "tr",
      "pl",
    ]);
    expect(alert.references).toMatch(/^opendata@dwd\.de,/);
  });

  test("reads ECCC's namespaced CAP-CP message", () => {
    const alert = readCapXml(fixture("eccc-fog.xml"));
    expect(alert.code).toContain("profile:CAP-CP:0.4");
    expect(alert.info!.map((i) => i.language)).toEqual(["en-CA", "fr-CA"]);
  });

  test("refuses a document that declares entities", () => {
    const body = Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE alert [<!ENTITY a "aaaa">]><alert><identifier>&a;</identifier></alert>',
    );
    expect(() => readCapXml(body)).toThrow(/entity/);
  });

  test("refuses a document that is no CAP message", () => {
    expect(() => readCapXml(Buffer.from("<html><body>Not Found</body></html>"))).toThrow(
      /root is html, not alert/,
    );
    expect(() => readCapXml(Buffer.from(""))).toThrow(/not alert/);
  });
});
