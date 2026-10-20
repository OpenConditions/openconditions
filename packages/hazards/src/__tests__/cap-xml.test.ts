import { describe, expect, test } from "vitest";
import { CapReadError, readCapXml } from "../cap/xml.js";
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

  test("refuses a message of an earlier CAP version, and an alert of another namespace", () => {
    const reasonOf = (xml: string) => {
      try {
        readCapXml(Buffer.from(xml));
        return undefined;
      } catch (error) {
        return error instanceof CapReadError ? error.reason : "other";
      }
    };
    const dwd = fixture("dwd-thunderstorm.xml").toString("utf8");
    expect(reasonOf(dwd.replace("emergency:cap:1.2", "emergency:cap:1.1"))).toBe(
      "unsupported_version",
    );
    expect(
      reasonOf(
        '<cap:alert xmlns:cap="http://www.incident.com/cap/1.0"><cap:identifier>x</cap:identifier></cap:alert>',
      ),
    ).toBe("unsupported_version");
    expect(reasonOf('<alert xmlns="urn:example:alerts"><identifier>x</identifier></alert>')).toBe(
      "malformed",
    );
    expect(reasonOf("<html><body>Not Found</body></html>")).toBe("malformed");
  });

  test("reads CAP 1.2 under any prefix, and an alert that declares no namespace", () => {
    const ns = "urn:oasis:names:tc:emergency:cap:1.2";
    const prefixed = readCapXml(
      Buffer.from(
        `<?xml version="1.0"?>\n<!-- a CAP message -->\n<c.a:alert xmlns:c.a="${ns}"><c.a:identifier>x</c.a:identifier></c.a:alert>`,
      ),
    );
    expect(prefixed.identifier).toBe("x");
    expect(readCapXml(Buffer.from("<alert><identifier>y</identifier></alert>")).identifier).toBe(
      "y",
    );
  });

  describe("decodes the text as the document is encoded", () => {
    const message = (declaration: string) =>
      `${declaration}<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>x</identifier><info><event>Abducción de Niño</event></info></alert>`;
    const eventOf = (body: Buffer) => readCapXml(body).info![0]!.event;

    test("in UTF-8, declared or not", () => {
      expect(eventOf(Buffer.from(message('<?xml version="1.0" encoding="UTF-8"?>')))).toBe(
        "Abducción de Niño",
      );
      expect(eventOf(Buffer.from(`﻿${message("")}`))).toBe("Abducción de Niño");
    });

    test("in the single-byte encoding its declaration names", () => {
      const latin1 = Buffer.from(message("<?xml version='1.0' encoding='ISO-8859-1'?>"), "latin1");
      expect(eventOf(latin1)).toBe("Abducción de Niño");
    });

    test("in UTF-16, by its byte-order mark", () => {
      const le = Buffer.from(`﻿${message('<?xml version="1.0" encoding="UTF-16"?>')}`, "utf16le");
      expect(eventOf(le)).toBe("Abducción de Niño");
    });

    // OASIS's CAP 1.2 example A.4 is written so.
    test("as Windows-1252 where bytes declared UTF-8 are no UTF-8", () => {
      const mislabelled = Buffer.from(
        message('<?xml version = "1.0" encoding = "UTF-8"?>'),
        "latin1",
      );
      expect(eventOf(mislabelled)).toBe("Abducción de Niño");
    });
  });
});
