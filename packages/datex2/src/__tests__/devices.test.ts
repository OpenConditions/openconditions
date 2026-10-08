import { readFileSync } from "node:fs";
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

  test("devices that are not cameras are skipped", () => {
    expect(devices.some((d) => d.id === "9999001")).toBe(false);
  });

  test("a document without a device publication yields nothing", () => {
    expect(parseDatexCameraDevices(parseXmlDocument("<root/>"))).toEqual([]);
  });
});
