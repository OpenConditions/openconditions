import { describe, expect, it, vi } from "vitest";
import { feedPatternsFromEnv, ingestRoleFromEnv, planIngest } from "../ingest-role.js";
import { testFeed } from "./helpers/catalog.js";

const catalog = {
  feeds: [
    testFeed({ id: "nl-ndw-events" }),
    testFeed({ id: "nl-ndw-flow" }),
    testFeed({ id: "nl-ndw-charging" }),
    testFeed({ id: "be-wallonia-events" }),
    testFeed({ id: "fr-ocm-charging", accessMode: "on_demand" }),
  ],
  disabled: [testFeed({ id: "de-old-events" })],
  discovered: [testFeed({ id: "fr-child-parking" })],
};

const ids = (feeds: readonly { id: string }[]) => feeds.map((f) => f.id);
const quiet = () => ({ warn: vi.fn(), info: vi.fn() });

describe("ingestRoleFromEnv", () => {
  it("is the primary unless the environment says feeds", () => {
    expect(ingestRoleFromEnv({})).toBe("primary");
    expect(ingestRoleFromEnv({ OPENCONDITIONS_INGEST_ROLE: "" })).toBe("primary");
    expect(ingestRoleFromEnv({ OPENCONDITIONS_INGEST_ROLE: "primary" })).toBe("primary");
    expect(ingestRoleFromEnv({ OPENCONDITIONS_INGEST_ROLE: " Feeds " })).toBe("feeds");
  });

  it("fails on any other value", () => {
    expect(() => ingestRoleFromEnv({ OPENCONDITIONS_INGEST_ROLE: "heavy" })).toThrow(
      /OPENCONDITIONS_INGEST_ROLE/,
    );
  });
});

describe("feedPatternsFromEnv", () => {
  it("reads comma-separated ids and patterns, ignoring blanks", () => {
    expect(
      feedPatternsFromEnv(
        { OPENCONDITIONS_INGEST_FEEDS: " nl-ndw-flow, nl-ndw-*,,  " },
        "OPENCONDITIONS_INGEST_FEEDS",
      ),
    ).toEqual(["nl-ndw-flow", "nl-ndw-*"]);
    expect(feedPatternsFromEnv({}, "OPENCONDITIONS_INGEST_FEEDS")).toEqual([]);
  });

  it("fails on what cannot name a feed", () => {
    for (const bad of ["NL-NDW-FLOW", "nl ndw", "nl-ndw-?", "roads/nl-ndw-flow"]) {
      expect(() =>
        feedPatternsFromEnv(
          { OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: bad },
          "OPENCONDITIONS_INGEST_FEEDS_EXCLUDE",
        ),
      ).toThrow(/OPENCONDITIONS_INGEST_FEEDS_EXCLUDE/);
    }
  });
});

describe("planIngest", () => {
  it("polls every polled feed and owns every source by default", () => {
    const plan = planIngest(catalog, {}, quiet());
    expect(plan.role).toBe("primary");
    expect(ids(plan.feeds)).toEqual([
      "nl-ndw-events",
      "nl-ndw-flow",
      "nl-ndw-charging",
      "be-wallonia-events",
    ]);
    expect(plan.scope).toEqual({ except: [] });
  });

  it("leaves the excluded feeds, and their leftovers, to another process", () => {
    const log = quiet();
    const plan = planIngest(
      catalog,
      { OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: "nl-ndw-flow,nl-ndw-charging" },
      log,
    );
    expect(plan.role).toBe("primary");
    expect(ids(plan.feeds)).toEqual(["nl-ndw-events", "be-wallonia-events"]);
    expect(plan.scope).toEqual({ except: ["nl-ndw-flow", "nl-ndw-charging"] });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("nl-ndw-flow, nl-ndw-charging"));
  });

  it("gives a feeds process only the feeds it names, and only their leftovers", () => {
    const plan = planIngest(
      catalog,
      { OPENCONDITIONS_INGEST_ROLE: "feeds", OPENCONDITIONS_INGEST_FEEDS: "nl-ndw-*" },
      quiet(),
    );
    expect(plan.role).toBe("feeds");
    expect(ids(plan.feeds)).toEqual(["nl-ndw-events", "nl-ndw-flow", "nl-ndw-charging"]);
    expect(plan.scope).toEqual({ only: ["nl-ndw-events", "nl-ndw-flow", "nl-ndw-charging"] });
  });

  it("applies the exclusions after the inclusions", () => {
    const plan = planIngest(
      catalog,
      {
        OPENCONDITIONS_INGEST_ROLE: "feeds",
        OPENCONDITIONS_INGEST_FEEDS: "nl-ndw-*",
        OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: "nl-ndw-events",
      },
      quiet(),
    );
    expect(ids(plan.feeds)).toEqual(["nl-ndw-flow", "nl-ndw-charging"]);
  });

  it("splits the catalogue exactly when both processes read the same list", () => {
    const list = "nl-ndw-flow, nl-ndw-charging";
    const primary = planIngest(catalog, { OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: list }, quiet());
    const feeds = planIngest(
      catalog,
      { OPENCONDITIONS_INGEST_ROLE: "feeds", OPENCONDITIONS_INGEST_FEEDS: list },
      quiet(),
    );
    const both = [...ids(primary.feeds), ...ids(feeds.feeds)];
    expect(new Set(both).size).toBe(both.length);
    expect(both.sort()).toEqual(ids(planIngest(catalog, {}, quiet()).feeds).sort());
  });

  it("never polls an on-demand feed, which the primary's API reads through", () => {
    const log = quiet();
    expect(() =>
      planIngest(
        catalog,
        { OPENCONDITIONS_INGEST_ROLE: "feeds", OPENCONDITIONS_INGEST_FEEDS: "fr-ocm-charging" },
        log,
      ),
    ).toThrow(/polls no feed/);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("fr-ocm-charging"));
    const primary = planIngest(
      catalog,
      { OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: "fr-ocm-charging" },
      quiet(),
    );
    expect(primary.scope).toEqual({ except: [] });
  });

  it("fails a feeds process that names no feeds", () => {
    expect(() => planIngest(catalog, { OPENCONDITIONS_INGEST_ROLE: "feeds" }, quiet())).toThrow(
      /OPENCONDITIONS_INGEST_FEEDS/,
    );
  });

  it("fails on an included name the catalogue does not know, and warns on an excluded one", () => {
    expect(() =>
      planIngest(
        catalog,
        {
          OPENCONDITIONS_INGEST_ROLE: "feeds",
          OPENCONDITIONS_INGEST_FEEDS: "nl-ndw-flow,nl-nwd-*",
        },
        quiet(),
      ),
    ).toThrow(/"nl-nwd-\*" matches no feed/);
    const log = quiet();
    const plan = planIngest(catalog, { OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: "nl-nwd-flow" }, log);
    expect(ids(plan.feeds)).toHaveLength(4);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"nl-nwd-flow" matches no feed'));
  });

  it("knows the disabled and discovered feeds, though it polls none", () => {
    const log = quiet();
    const plan = planIngest(
      catalog,
      {
        OPENCONDITIONS_INGEST_ROLE: "feeds",
        OPENCONDITIONS_INGEST_FEEDS: "nl-ndw-flow,de-old-events,fr-child-parking",
      },
      log,
    );
    expect(ids(plan.feeds)).toEqual(["nl-ndw-flow"]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
