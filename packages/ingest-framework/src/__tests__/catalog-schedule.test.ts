import { describe, expect, test } from "vitest";
import { dueRoles } from "../catalog/schedule.js";
import type { CatalogFeed } from "../catalog/types.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const feedWith = (endpoints: CatalogFeed["endpoints"]) => catalogFeed({ endpoints });

describe("dueRoles", () => {
  test("reference endpoints are not polled on the data cadence", () => {
    const feed = feedWith({
      main: { url: "https://a", cadenceSec: 60 },
      sites: { url: "https://s", decoder: "datex2-sites", cadenceSec: 21600 },
    });
    expect(dueRoles(feed, {}, 0)).toEqual(["main"]);
    expect(dueRoles(feed, { main: 0 }, 30_000)).toEqual([]);
    expect(dueRoles(feed, { main: 0 }, 60_000)).toEqual(["main"]);
  });

  test("every data role is due on the first poll, then each on its own cadence", () => {
    const feed = feedWith({
      main: { url: "https://a", cadenceSec: 60 },
      detail: { url: "https://d", cadenceSec: 300 },
    });
    expect(dueRoles(feed, {}, 1_000_000)).toEqual(["main", "detail"]);
    expect(dueRoles(feed, { main: 0, detail: 0 }, 120_000)).toEqual(["main"]);
    expect(dueRoles(feed, { main: 120_000, detail: 0 }, 300_000)).toEqual(["main", "detail"]);
  });
});
