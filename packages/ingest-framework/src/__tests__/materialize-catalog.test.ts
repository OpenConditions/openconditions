import { afterEach, describe, expect, it } from "vitest";
import type { FeedSourceBase } from "../feed-source.js";
import {
  __resetCatalogResolvers,
  materializeApprovedCatalogChildren,
  registerCatalogResolver,
} from "../index.js";

const parent: FeedSourceBase = {
  id: "us-wzdx",
  name: "US WZDx",
  operator: "wzdx",
  format: "wzdx",
  catalog: { resolver: "test-catalog", approvedChildren: ["wzdx-kansas"] },
  auth: { kind: "bearer", envVar: "WZDX_KEY" },
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "UNKNOWN",
  attribution: "registry",
  country: "US",
  privacyUrl: "https://example.test/privacy",
};

const child = (id: string, approved: boolean): FeedSourceBase => ({
  ...parent,
  id,
  name: id,
  catalog: undefined,
  auth: undefined,
  url: `https://example.test/${id}`,
  parentSourceId: parent.id,
  policyIds: [parent.id, id],
  selectionState: approved ? "approved" : "discovered",
  license: approved ? "CC0-1.0" : "UNKNOWN",
  attribution: id,
  rights: {
    sourceRedistribution: approved ? true : null,
    derivedRedistribution: approved ? true : null,
    commercialUse: approved ? true : null,
    attributionRequired: approved ? false : null,
    retention: approved ? true : null,
  },
});

afterEach(() => __resetCatalogResolvers());

describe("materializeApprovedCatalogChildren", () => {
  it("schedules approved children independently and keeps discoveries visible", () => {
    registerCatalogResolver("roads", {
      id: "test-catalog",
      snapshotPath: "/unused",
      snapshot: [child("wzdx-kansas", true), child("wzdx-washington", false)],
      resolve: async () => [],
    });

    const result = materializeApprovedCatalogChildren([parent]);
    expect(result.scheduled.map((feed) => feed.id)).toEqual(["wzdx-kansas"]);
    expect(result.scheduled[0]).toMatchObject({
      parentSourceId: "us-wzdx",
      auth: { kind: "bearer", envVar: "WZDX_KEY" },
      attribution: "wzdx-kansas",
    });
    expect(result.scheduled.some((feed) => feed.id === "us-wzdx")).toBe(false);
    expect(result.discovered.map((feed) => feed.id)).toEqual(["wzdx-washington"]);
  });

  it("fails startup when configuration approves a child absent from the snapshot", () => {
    registerCatalogResolver("roads", {
      id: "test-catalog",
      snapshotPath: "/unused",
      snapshot: [],
      resolve: async () => [],
    });
    expect(() => materializeApprovedCatalogChildren([parent])).toThrow(/wzdx-kansas.*snapshot/);
  });
});
