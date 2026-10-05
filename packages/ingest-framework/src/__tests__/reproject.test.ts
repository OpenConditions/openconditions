import { describe, expect, it } from "vitest";
import { epsgCode, mercToWgs84, reprojectorFor } from "../reproject.js";

describe("reproject", () => {
  it("reprojects EPSG:3812 (Belgian Lambert 2008) to WGS84 (Brussels control point)", () => {
    const fn = reprojectorFor("EPSG:3812")!;
    expect(fn).toBeTypeOf("function");
    const [lon, lat] = fn([648008.25588407, 669870.036804775]);
    expect(lon).toBeCloseTo(4.34, 1);
    expect(lat).toBeCloseTo(50.84, 1);
  });

  it("reprojects EPSG:31370 (Belgian Lambert 72, with datum shift) into Belgium", () => {
    const fn = reprojectorFor("urn:ogc:def:crs:EPSG::31370")!;
    const [lon, lat] = fn([154002.27, 214715.4]);
    expect(lon).toBeGreaterThan(2);
    expect(lon).toBeLessThan(7);
    expect(lat).toBeGreaterThan(49);
    expect(lat).toBeLessThan(52);
  });

  it("uses the closed-form Mercator transform for EPSG:3857", () => {
    const fn = reprojectorFor("urn:ogc:def:crs:EPSG::3857")!;
    expect(fn).toBe(mercToWgs84);
  });

  it("returns null for WGS84 / unknown CRS (caller leaves coords as-is)", () => {
    expect(reprojectorFor("urn:ogc:def:crs:OGC:1.3:CRS84")).toBeNull();
    expect(reprojectorFor("EPSG:4326")).toBeNull();
    expect(reprojectorFor(undefined)).toBeNull();
    expect(reprojectorFor("EPSG:9999")).toBeNull(); // not registered
  });

  it("normalises CRS name forms to EPSG codes", () => {
    expect(epsgCode("urn:ogc:def:crs:EPSG::3812")).toBe("EPSG:3812");
    expect(epsgCode("EPSG:31370")).toBe("EPSG:31370");
    expect(epsgCode("EPSG:4326")).toBeNull();
  });
});
