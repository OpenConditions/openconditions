import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { datexPublications, parseXmlDocument } from "../index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("datexPublications", () => {
  test("finds a v2 table inside a generic publication extension", () => {
    const [p] = datexPublications(parseXmlDocument(fixture("ndw-truck-table.xml")));
    expect(p).toMatchObject({
      version: 2,
      type: "ParkingTablePublication",
      publicationTime: "2026-04-29T13:07:49.531Z",
    });
    expect(Object.keys(p!.body)).toContain("parkingTable");
  });

  test("reads a v3 payload by its xsi:type", () => {
    const [p] = datexPublications(parseXmlDocument(fixture("ndw-truck-status.xml")));
    expect(p).toMatchObject({
      version: 3,
      type: "ParkingStatusPublication",
      publicationTime: "2026-09-22T11:07:51.885888972Z",
    });
  });

  test("reads a v2 status publication from CITA's generic extension", () => {
    const publications = datexPublications(parseXmlDocument(fixture("cita-dynamic.xml")));
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ version: 2, type: "ParkingStatusPublication" });
  });

  test("reads the same document whether or not namespace prefixes were stripped", () => {
    const stripped = datexPublications(
      parseXmlDocument(fixture("ndw-truck-status.xml"), { removeNSPrefix: true }),
    );
    expect(stripped[0]).toMatchObject({ version: 3, type: "ParkingStatusPublication" });
  });

  test("reads a v3 payload inside a message container", () => {
    const xml = `<?xml version="1.0"?>
      <mc:messageContainer xmlns:mc="http://datex2.eu/schema/3/messageContainer"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <mc:payload xsi:type="sit:SituationPublication">
          <com:publicationTime xmlns:com="http://datex2.eu/schema/3/common">2026-10-01T00:00:00Z</com:publicationTime>
        </mc:payload>
      </mc:messageContainer>`;
    expect(datexPublications(parseXmlDocument(xml))).toEqual([
      expect.objectContaining({
        version: 3,
        type: "SituationPublication",
        publicationTime: "2026-10-01T00:00:00Z",
      }),
    ]);
  });

  test("unwraps a SOAP envelope", () => {
    const xml = `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <d2LogicalModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
            <payloadPublication xsi:type="SituationPublication">
              <publicationTime>2026-10-01T00:00:00Z</publicationTime>
            </payloadPublication>
          </d2LogicalModel>
        </soap:Body>
      </soap:Envelope>`;
    expect(datexPublications(parseXmlDocument(xml))).toEqual([
      expect.objectContaining({ version: 2, type: "SituationPublication" }),
    ]);
  });

  test("a document with no DATEX publication has none", () => {
    expect(datexPublications(parseXmlDocument("<root><a>1</a></root>"))).toEqual([]);
  });
});
