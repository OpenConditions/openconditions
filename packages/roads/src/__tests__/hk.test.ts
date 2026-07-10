import { describe, expect, it } from "vitest";
import { parseHkDetectors, parseHkRawFlow } from "../hk.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "hk-td-flow",
  attribution: "Transport Department, HKSAR",
  country: "HK",
  license: "HK-Gov-Open-Data",
} as SourceDescriptor;

// Leading ﻿ mirrors the live file's UTF-8 BOM.
const CSV = `﻿AID_ID_Number,District,Road_EN,Road_TC,Road_SC,Easting,Northing,Latitude,Longitude,Direction,Rotation
AID01101,Southern,Aberdeen Praya Road,x,x,833758,812147,22.248091,114.152525,South East,100
BADLAT,Southern,Road,x,x,0,0,0,0,North,0
`;

const XML = `<?xml version="1.0" encoding="utf-8"?>
<raw_speed_volume_list><periods>
  <period><period_from>01:50:00</period_from><period_to>01:50:30</period_to><detectors>
    <detector><detector_id>AID01101</detector_id><lanes>
      <lane><lane_id>Fast Lane</lane_id><speed>60</speed><volume>1</volume><valid>Y</valid></lane>
    </lanes></detector>
  </detectors></period>
  <period><period_from>01:55:00</period_from><period_to>01:55:30</period_to><detectors>
    <detector><detector_id>AID01101</detector_id><lanes>
      <lane><lane_id>Fast Lane</lane_id><speed>100</speed><volume>3</volume><valid>Y</valid></lane>
      <lane><lane_id>Slow Lane</lane_id><speed>60</speed><volume>1</volume><valid>Y</valid></lane>
      <lane><lane_id>Broken</lane_id><speed>0</speed><volume>0</volume><valid>N</valid></lane>
    </lanes></detector>
  </detectors></period>
</periods></raw_speed_volume_list>`;

describe("parseHkDetectors", () => {
  it("maps AID id → WGS84 Point, strips the BOM, and drops out-of-bounds rows", () => {
    const map = parseHkDetectors(CSV);
    expect(map.size).toBe(1);
    expect(map.get("AID01101")).toEqual({ type: "Point", coordinates: [114.152525, 22.248091] });
  });
});

describe("parseHkRawFlow", () => {
  it("uses the latest period and the volume-weighted mean of valid lanes", () => {
    const siteMap = parseHkDetectors(CSV);
    const { flows } = parseHkRawFlow(XML, src, siteMap);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("hk-td-flow:AID01101");
    // Latest period: (100·3 + 60·1) / (3+1) = 90; the valid=N lane is ignored.
    expect(flows[0]!.speedKph).toBe(90);
    expect(flows[0]!.geometry).toEqual({ type: "Point", coordinates: [114.152525, 22.248091] });
    expect(flows[0]!.dataUpdatedAt).toBe("01:55:30");
  });

  it("skips detectors with no geometry", () => {
    expect(parseHkRawFlow(XML, src, new Map()).flows).toHaveLength(0);
  });

  it("flags a hard parse failure", () => {
    expect(parseHkRawFlow("nope <", src, new Map()).failed).toBe(true);
  });
});
