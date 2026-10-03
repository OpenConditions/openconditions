import { describe, expect, it } from "vitest";
import { parseHkDetectors } from "../hk.js";
import { flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "hk-td-flow";
const feed = flowFeed(FEED);

// Leading ﻿ mirrors the live file's UTF-8 BOM.
const CSV = `﻿AID_ID_Number,District,Road_EN,Road_TC,Road_SC,Easting,Northing,Latitude,Longitude,Direction,Rotation
AID01101,Southern,Aberdeen Praya Road,x,x,833758,812147,22.248091,114.152525,South East,100
BADLAT,Southern,Road,x,x,0,0,0,0,North,0
`;

const XML = `<?xml version="1.0" encoding="utf-8"?>
<raw_speed_volume_list><date>2026-09-20</date><periods>
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
  it("places each AID detector at its WGS84 point with its road, strips the BOM, drops out-of-bounds rows", () => {
    const sites = parseHkDetectors(CSV);
    expect(sites.size).toBe(1);
    expect(sites.get("AID01101")).toEqual({
      geometry: { type: "Point", coordinates: [114.152525, 22.248091] },
      name: "Aberdeen Praya Road",
      nameLang: "en",
    });
  });
});

describe("HK TD raw speed and volume", () => {
  it("uses the latest period and the volume-weighted mean of valid lanes", () => {
    const out = flows(feed, XML, parseHkDetectors(CSV));
    expect(siteIds(out, FEED)).toEqual(["AID01101"]);
    // Latest period: (100·3 + 60·1) / (3+1) = 90; the valid=N lane is ignored.
    expect(value(out, FEED, "AID01101", "traffic.speed")).toBe(90);
    expect((site(out, FEED, "AID01101")!["location"] as { geometry: unknown }).geometry).toEqual({
      type: "Point",
      coordinates: [114.152525, 22.248091],
    });
    // The document date plus the period, in Hong Kong time.
    expect(readings(out, FEED, "AID01101", "traffic.speed")[0]!["phenomenonTime"]).toEqual({
      start: "2026-09-19T17:55:00.000Z",
      end: "2026-09-19T17:55:30.000Z",
    });
  });

  it("skips detectors with no geometry", () => {
    expect(flows(feed, XML, new Map()).features).toEqual([]);
  });

  it("refuses an unreadable body as a hard parse failure", () => {
    expect(() => flows(feed, "nope <", new Map())).toThrow("hard parse failure");
  });
});
