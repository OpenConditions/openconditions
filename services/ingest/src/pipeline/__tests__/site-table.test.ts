import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FeedSource } from "@openconditions/roads";
import { clearSiteTableCache, loadSiteTable } from "../site-table.js";

const VERORTUNG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication xsi:type="PredefinedLocationsPublication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <predefinedLocationContainer>
      <predefinedLocation id="MQ_A1_0042">
        <location xsi:type="Point">
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>53.60864</latitude>
              <longitude>10.05740</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </location>
      </predefinedLocation>
    </predefinedLocationContainer>
  </payloadPublication>
</d2LogicalModel>`;

describe("loadSiteTable — parser selection by siteTable.format", () => {
  it("parses a PredefinedLocations site table when format is datex-predefined-locations", async () => {
    const factory = async (): Promise<Readable> => Readable.from([VERORTUNG_XML]);
    const src = {
      id: "de-hh-autobahn",
      siteTable: { url: "https://x/verortung", format: "datex-predefined-locations" },
    } as unknown as FeedSource;
    clearSiteTableCache();
    const map = await loadSiteTable(src, factory);
    expect(map?.get("MQ_A1_0042")).toEqual({ type: "Point", coordinates: [10.0574, 53.60864] });
  });

  it("returns undefined (dormant) when the site-table URL has an unset ${VAR}", async () => {
    const factory = async (): Promise<Readable> => Readable.from([VERORTUNG_XML]);
    const src = {
      id: "de-hh-autobahn",
      requiredEnv: ["DE_HH_AUTOBAHNNORD_VERORTUNG_SUBSCRIPTION_ID"],
      siteTable: {
        url: "https://x/subscription/${DE_HH_AUTOBAHNNORD_VERORTUNG_SUBSCRIPTION_ID}/verortung",
        format: "datex-predefined-locations",
      },
    } as unknown as FeedSource;
    clearSiteTableCache();
    const map = await loadSiteTable(src, factory);
    expect(map).toBeUndefined();
  });
});
