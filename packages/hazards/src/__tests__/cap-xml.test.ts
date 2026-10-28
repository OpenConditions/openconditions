import { spawnSync } from "node:child_process";
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

  describe("binds namespace declarations to the parsed document element", () => {
    const ns = "urn:oasis:names:tc:emergency:cap:1.2";
    const read = (xml: string) => readCapXml(Buffer.from(xml));
    const message = (attrs: string) => `<alert ${attrs}><identifier>x</identifier></alert>`;

    test.each([
      '<!-- <A xmlns="urn:example:other"> -->',
      '<?audit <A xmlns="urn:example:other"> ?>',
      '<!DOCTYPE alert SYSTEM "urn:example:<A xmlns=other>">',
      '<!DOCTYPE alert [<!-- <A xmlns="urn:example:other"> ] --> <!ELEMENT alert ANY>]>',
      '<![CDATA[<A xmlns="urn:example:other">]]>',
      'text xmlns="urn:example:other" ',
    ])("ignores namespace-like prolog data: %s", (prolog) => {
      expect(read(prolog + message(`xmlns="${ns}"`)).identifier).toBe("x");
    });

    test.each(["c.a", "é", "气", "_cap", "cap-1"])('checks the actual "%s" prefix', (prefix) => {
      const xml = (uri: string) =>
        `<${prefix}:alert xmlns:${prefix}="${uri}"><${prefix}:identifier>x</${prefix}:identifier></${prefix}:alert>`;
      expect(read(xml(ns)).identifier).toBe("x");
      expect(() => read(xml("urn:example:other"))).toThrow(/not CAP 1.2's namespace/);
      expect(() => read(xml("urn:oasis:names:tc:emergency:cap:1.1"))).toThrow(
        expect.objectContaining({ reason: "unsupported_version" }),
      );
    });

    test.each(["\r\n", "\r", "\n"])(
      "maps source offsets across %j prolog line endings",
      (newline) => {
        const prolog = `<?xml version="1.0"?>${newline}<!-- note${newline} -->${newline}`;
        expect(read(prolog + message(`xmlns="${ns}"`)).identifier).toBe("x");
        expect(() => read(prolog + message('xmlns="urn:example:other"'))).toThrow(
          /not CAP 1.2's namespace/,
        );
      },
    );

    test("quoted attributes cannot supply or hide the namespace declaration", () => {
      expect(read(message(`note=" xmlns='urn:example:other'" xmlns="${ns}"`)).identifier).toBe("x");
      expect(() => read(message(`note="<A xmlns='${ns}'>" xmlns="urn:example:other"`))).toThrow(
        /not CAP 1.2's namespace/,
      );
      expect(() => read(message('note=">" xmlns="urn:example:other"'))).toThrow(
        /not CAP 1.2's namespace/,
      );
      expect(read(message(`xmlns="${ns}" note=" xmlns='urn:example:other'"`)).identifier).toBe("x");
    });

    test.each(["/ignored", "/"])(
      "an ignored %s attribute cannot hide a declaration",
      (attribute) => {
        expect(() => read(message(`${attribute} xmlns="urn:example:other"`))).toThrow(
          /not CAP 1.2's namespace/,
        );
      },
    );

    test("keeps absent versus explicit-empty declarations and ignores other prefixes/children", () => {
      expect(read(message('xmlns:other="urn:example:other"')).identifier).toBe("x");
      expect(
        read('<alert><identifier xmlns="urn:example:other">x</identifier></alert>').identifier,
      ).toBe("x");
      expect(read(message("xmlns=urn:example:other")).identifier).toBe("x");
      expect(read(message("note='x'xmlns='urn:example:other'")).identifier).toBe("x");
      expect(() => read(message('flag xmlns="urn:example:other"'))).toThrow(
        /not CAP 1.2's namespace/,
      );
      expect(
        read(
          `<p:alert xmlns="urn:example:other" xmlns:p="${ns}"><identifier>x</identifier></p:alert>`,
        ).identifier,
      ).toBe("x");
      expect(() =>
        read(
          `<p:alert xmlns="${ns}" xmlns:p="urn:example:other"><identifier>x</identifier></p:alert>`,
        ),
      ).toThrow(/not CAP 1.2's namespace/);
      expect(() => read(message('xmlns=""'))).toThrow(/not CAP 1.2's namespace/);
      expect(() => read('<p:alert xmlns:p=""><identifier>x</identifier></p:alert>')).toThrow(
        /not CAP 1.2's namespace/,
      );
      expect(() =>
        read(`<alert xmlns="urn:example:other"><identifier xmlns="${ns}">x</identifier></alert>`),
      ).toThrow(/not CAP 1.2's namespace/);
    });

    test("preserves the first quoted declaration and raw declaration values", () => {
      expect(read(message(`xmlns="${ns}" xmlns="urn:example:other"`)).identifier).toBe("x");
      expect(() => read(message(`xmlns="urn:example:other" xmlns="${ns}"`))).toThrow(
        /not CAP 1.2's namespace/,
      );
      expect(() => read(message('xmlns="urn:oasis:names:tc:emergency:cap:1.&#50;"'))).toThrow(
        /not CAP 1.2's namespace/,
      );
    });

    test("the parsed alert must be the first document element", () => {
      expect(() => read(`<other/><alert xmlns="${ns}"><identifier>x</identifier></alert>`)).toThrow(
        /root is other, not alert/,
      );
    });

    test("does not expose parser metadata in the returned projection", () => {
      const check = (value: unknown): void => {
        if (value === null || typeof value !== "object") return;
        expect(Object.getOwnPropertySymbols(value)).toEqual([]);
        for (const child of Object.values(value)) check(child);
      };
      check(readCapXml(fixture("dwd-thunderstorm.xml")));
    });

    test("handles bounded comment and quoted-attribute data through built public exports", () => {
      const child = spawnSync(
        process.execPath,
        [
          "--max-old-space-size=96",
          "--input-type=module",
          "-e",
          `import assert from "node:assert/strict";
         const { readCapXml } = await import(process.argv[1]);
         const read = (xml) => readCapXml(Buffer.from(xml));
         const doc = '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>x</identifier></alert>';
         assert.equal(read(doc).identifier, "x");
         assert.throws(() => read(doc.replace('cap:1.2', 'cap:1.1')), { reason: 'unsupported_version' });
         console.log("control passed");
         assert.equal(read('<!--' + '<A '.repeat(20000) + '-->' + doc).identifier, "x");
         const attrs = '<alert note="' + '>'.repeat(40000) + ' xmlns=other" xmlns="urn:example:other"><identifier>x</identifier></alert>';
         assert.throws(() => read(attrs), { reason: 'malformed' });
         const prefix = "é".repeat(10000);
         assert.throws(() => read('<' + prefix + ':alert xmlns:' + prefix + '="urn:example:other"><identifier>x</identifier></' + prefix + ':alert>'), { reason: 'malformed' });
         console.log("decoded");`,
          new URL("../../dist/index.js", import.meta.url).href,
        ],
        { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
      );
      expect(child.stdout).toContain("control passed");
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe("control passed\ndecoded");
    });
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
