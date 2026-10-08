import { feedCredentialNames } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { sourcesOf } from "../api/sources.js";
import { catalogueSources } from "../sources.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";

describe("catalogueSources", () => {
  it("lists every scheduled feed once, with its domain, product and tier", () => {
    const sources = catalogueSources(REPO_CATALOG);
    expect(sources.length).toBe(REPO_CATALOG.feeds.length);
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
    expect(sources.find((s) => s.id === "nl-ndw-events")).toMatchObject({
      domain: "roads",
      product: "events",
      tier: "authoritative",
      format: "datex2",
      country: "NL",
    });
    expect(sources.find((s) => s.id === "nl-ndw-flow")).toMatchObject({ product: "flow" });
    expect(sources.every((s) => s.tier !== undefined && s.rights !== undefined)).toBe(true);
  });
});

describe("the repo catalogue's sources", () => {
  const sources = new Map(sourcesOf(REPO_CATALOG).map((s) => [s.id, s]));

  it("serves the image hosts a camera feed declares, and none for one that declares none", () => {
    expect(sources.get("gb-eng-tfl-cameras")?.imageHosts).toEqual([
      "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
    ]);
    expect(sources.get("tw-tdx-cameras")?.imageHosts).toEqual(["*.thb.gov.tw"]);
    // OpenStreetMap's stills sit on any host a mapper wrote: none is declared.
    expect(sources.get("osm-cameras")).toBeDefined();
    expect(sources.get("osm-cameras")).not.toHaveProperty("imageHosts");
    // A feed of another domain has none either.
    expect(sources.get("nl-ndw-events")).not.toHaveProperty("imageHosts");
  });

  it("reads one account's credentials from one variable for every feed that shares it", () => {
    const envOf = (id: string) => feedCredentialNames(repoFeed(id)).map((c) => c.env);
    expect(envOf("tw-tdx-charging")).toEqual(["TW_TDX_CLIENT_ID", "TW_TDX_CLIENT_SECRET"]);
    expect(envOf("tw-tdx-cameras")).toEqual(["TW_TDX_CLIENT_ID", "TW_TDX_CLIENT_SECRET"]);
    for (const id of [
      "au-nsw-livetraffic-events",
      "au-nsw-tfnsw-parking",
      "au-nsw-livetraffic-cameras",
    ]) {
      expect(envOf(id), id).toEqual(["AU_NSW_TFNSW_API_KEY"]);
    }
    for (const id of [
      "ca-on-511-events",
      "ca-on-511-construction-events",
      "ca-on-511-conditions",
      "ca-on-511-cameras",
    ]) {
      expect(envOf(id), id).toEqual(["CA_ON_511_API_KEY"]);
    }
  });
});
