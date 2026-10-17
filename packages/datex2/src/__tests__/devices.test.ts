import { readFileSync } from "node:fs";
import { drainSkipped } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { parseDatexCameraDevices, parseXmlDocument } from "../index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseDatexCameraDevices", () => {
  const devices = parseDatexCameraDevices(parseXmlDocument(fixture("es-dgt-cameras.xml")));

  test("reads DGT camera devices with their image URL and road", () => {
    expect(devices.map((d) => d.id)).toEqual(["176130", "2", "167979"]);
    expect(devices[0]).toEqual({
      id: "176130",
      version: "2",
      updatedAt: "2025-10-28T14:19:42.000+01:00",
      country: "ES",
      point: [-3.9403, 42.2624],
      roadName: "A-62",
      roadDestination: "BURGOS",
      kilometrePoint: 25.3,
      province: "BURGOS",
      directionRoad: "negative",
      imageUrl: "https://etraffic.dgt.es/camarasEtraffic/176130.jpg",
    });
  });

  test("a device without a destination omits it and keeps a both-way road direction", () => {
    const ap6 = devices[2]!;
    expect(ap6).toMatchObject({
      id: "167979",
      roadName: "AP-6",
      kilometrePoint: 52.978,
      directionRoad: "both",
    });
    expect(ap6).not.toHaveProperty("roadDestination");
  });

  test("reads DGT's autonomous community, province and municipality, and counts a direction it cannot read", () => {
    const doc = (direction: string) =>
      parseXmlDocument(
        `<d2:payload xmlns:d2="http://levelC/schema/3/d2Payload" xmlns:ns2="http://levelC/schema/3/faultAndStatus" xmlns:com="http://levelC/schema/3/common" xmlns:loc="http://levelC/schema/3/locationReferencing" xmlns:lse="http://levelC/schema/3/locationReferencingSpanishExtension" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns2:DevicePublication"><com:publicationCreator><com:country>es</com:country><com:nationalIdentifier>DGT</com:nationalIdentifier></com:publicationCreator><ns2:device id="7"><ns2:typeOfDevice>camera</ns2:typeOfDevice><ns2:pointLocation><loc:tpegPointLocation><loc:point><loc:pointCoordinates><loc:latitude>40</loc:latitude><loc:longitude>-3.6</loc:longitude></loc:pointCoordinates><loc:_tpegNonJunctionPointExtension><loc:extendedTpegNonJunctionPoint><lse:autonomousCommunity>Castilla - La Mancha</lse:autonomousCommunity><lse:kilometerPoint>37.1</lse:kilometerPoint><lse:municipality>Ontígola</lse:municipality><lse:province>Toledo</lse:province></loc:extendedTpegNonJunctionPoint></loc:_tpegNonJunctionPointExtension></loc:point><loc:_tpegSimplePointExtension><loc:extendedTpegSimplePoint><lse:tpegDirectionRoad>${direction}</lse:tpegDirectionRoad></loc:extendedTpegSimplePoint></loc:_tpegSimplePointExtension></loc:tpegPointLocation></ns2:pointLocation></ns2:device></d2:payload>`,
      );
    const [read] = parseDatexCameraDevices(doc("unknown"), { sourceId: "xx-dgt" });
    expect(read).toMatchObject({
      country: "ES",
      autonomousCommunity: "Castilla - La Mancha",
      province: "Toledo",
      municipality: "Ontígola",
    });
    expect(read).not.toHaveProperty("directionRoad");
    expect(drainSkipped("xx-dgt")).toEqual({});
    const [extended] = parseDatexCameraDevices(doc("_extended"), { sourceId: "xx-dgt" });
    expect(extended).not.toHaveProperty("directionRoad");
    expect(drainSkipped("xx-dgt")).toEqual({ unknown_value: 1 });
  });

  test("devices that are not cameras are skipped", () => {
    expect(devices.some((d) => d.id === "9999001")).toBe(false);
  });

  test("a document without a device publication yields nothing", () => {
    expect(parseDatexCameraDevices(parseXmlDocument("<root/>"))).toEqual([]);
  });
});
