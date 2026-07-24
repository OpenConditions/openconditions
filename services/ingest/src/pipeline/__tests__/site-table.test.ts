import { describe, expect, it } from "vitest";
import type { FeedSource } from "@openconditions/roads";
import { clearSiteTableCache, loadSiteTable } from "../site-table.js";

describe("loadSiteTable — URL template expansion", () => {
  it("returns undefined (dormant) when the site-table URL has an unset ${VAR}", async () => {
    const src = {
      id: "de-he-autobahn-vzd",
      requiredEnv: ["DE_HE_AUTOBAHN_VERORTUNG_SUBSCRIPTION_ID"],
      siteTable: {
        url: "https://x/subscription/${DE_HE_AUTOBAHN_VERORTUNG_SUBSCRIPTION_ID}/verortung",
      },
    } as unknown as FeedSource;
    clearSiteTableCache();
    const map = await loadSiteTable(src);
    expect(map).toBeUndefined();
  });
});
