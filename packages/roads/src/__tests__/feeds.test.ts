import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";
import { parseOpen511 } from "../open511.js";
import { parseWzdx } from "../wzdx.js";
import { parseAutobahn } from "../autobahn.js";
import { parseDigitraffic } from "../digitraffic.js";
import { parseGeoJson } from "../geojson.js";
import { parseIbi511 } from "../ibi511.js";
import { parseLtaIncidents } from "../lta.js";
import { parseGddkia } from "../gddkia.js";
import { parseFlatJson } from "../flatjson.js";
import { parseTrafikverket } from "../trafikverket.js";
import { resolveFeedUrls, resolvedEnv } from "@openconditions/ingest-framework";
import { FEED_SOURCES, feedToSourceDescriptor, flowParserFor, parserFor } from "../feeds.js";
import { parseElaboratedFlow } from "../flow-elaborated.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("FEED_SOURCES", () => {
  it("includes an ndw entry", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw");
    expect(ndw).toBeDefined();
  });

  it("ndw entry has format datex2", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw")!;
    expect(ndw.format).toBe("datex2");
  });

  it("ndw entry has gzip:true", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw")!;
    expect(ndw.gzip).toBe(true);
  });

  it("ndw entry has license CC0-1.0", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw")!;
    expect(ndw.license).toBe("CC0-1.0");
  });

  it("includes an ndw-flow entry that produces flow with a companion site table", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "nl-ndw-flow");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.produces).toBe("flow");
    expect(feed!.gzip).toBe(true);
    expect(feed!.enabledByDefault).toBe(true);
    expect(feed!.siteTable).toEqual({
      url: "https://opendata.ndw.nu/measurement.xml.gz",
      gzip: true,
    });
    expect(feed!.url).toBe("https://opendata.ndw.nu/trafficspeed.xml.gz");
  });

  it("no longer registers the dead digitraffic-fi-flow feed", () => {
    expect(FEED_SOURCES.find((f) => f.id === "digitraffic-fi-flow")).toBeUndefined();
  });

  it("includes drivebc with format open511 and license OGL-BC", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "ca-bc-drivebc");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("open511");
    expect(feed!.license).toBe("OGL-BC");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes digitraffic-fi with format digitraffic and license CC-BY-4.0", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "fi-digitraffic");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("digitraffic");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes autobahn-de resolving all motorways via the catalog (no static url)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "de-autobahn");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("autobahn");
    expect(feed!.license).toBe("dl-de/by-2-0");
    expect(feed!.enabledByDefault).toBe(true);
    expect(feed!.catalog?.resolver).toBe("autobahn-index");
    expect(feed!.url).toBeUndefined();
  });

  it("includes wzdx enabled, resolving the feed registry via the catalog (no static url)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "us-wzdx");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("wzdx");
    expect(feed!.enabledByDefault).toBe(true);
    expect(feed!.catalog?.resolver).toBe("wzdx-registry");
    expect(feed!.url).toBeUndefined();
  });

  it("includes dgt-es (Spain) as an open DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "es-dgt");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.country).toBe("ES");
    expect(typeof feed!.url).toBe("string");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes svzbw-de (Baden-Württemberg roadworks) as an open DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "de-bw-svzbw");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("dl-de/by-2-0");
    expect(feed!.country).toBe("DE");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes dir-fr (France DIR) as an open DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "fr-dir");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("etalab-2.0");
    expect(feed!.country).toBe("FR");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes hc-hr (Croatia) as a Basic-auth DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "hr-hc");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth).toEqual({
      kind: "basic",
      userEnvVar: "HR_HC_USERNAME",
      passEnvVar: "HR_HC_PASSWORD",
    });
  });

  it("includes nzta-nz (New Zealand) as an open GeoJSON feed with a mapping", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "nz-nzta");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.geojson?.typeField).toBe("eventDescription");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes berlin-de (Berlin VIZ) as an open GeoJSON feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "de-be-berlin");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("dl-de/by-2-0");
    expect(feed!.country).toBe("DE");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes on-511 (Ontario) as a keyless ibi511 feed", () => {
    // The 511on.ca get/event endpoint is open — verified live (HTTP 200, full
    // event set) and the API docs declare no authentication.
    const feed = FEED_SOURCES.find((f) => f.id === "ca-on-511");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("ibi511");
    expect(feed!.auth).toBeUndefined();
    expect(feed!.requiredEnv).toBeUndefined();
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes ny-511 (511NY) as a query-key ibi511 feed", () => {
    // The 511ny.org /api/v2/get/event path requires a key (returns "Invalid Key"
    // without one), unlike Ontario's open endpoint.
    const feed = FEED_SOURCES.find((f) => f.id === "us-ny-511");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("ibi511");
    expect(feed!.auth?.kind).toBe("query-key");
  });

  it("includes lta-sg (Singapore) as a header-key lta feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "sg-lta");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("lta");
    expect(feed!.auth).toEqual({
      kind: "header-key",
      header: "AccountKey",
      envVar: "SG_LTA_ACCOUNT_KEY",
    });
  });

  it("includes mtq-qc (Québec) as an open GeoJSON feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "ca-qc-mtq");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.geojson?.defaultType).toBe("roadworks");
  });

  it("includes gddkia-pl (Poland) as a CC0 gddkia feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "pl-gddkia");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("gddkia");
    expect(feed!.license).toBe("CC0-1.0");
    expect(feed!.country).toBe("PL");
    // Canonical www host — the bare archiwum host redirects (via an http hop)
    // and its DNS proved flaky from the ingest container.
    expect(feed!.url).toBe("https://www.archiwum.gddkia.gov.pl/dane/zima_html/utrdane.xml");
  });

  it("includes vegvesen-no (Norway) as a Basic-auth DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "no-vegvesen");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth?.kind).toBe("basic");
    expect(feed!.country).toBe("NO");
  });

  it("includes vegagerdin-is (Iceland) as a GeoJSON feed with lon/lat fields", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "is-vegagerdin");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.geojson?.lonField).toBe("X");
    expect(feed!.geojson?.latField).toBe("Y");
  });

  it("includes qld-traffic (Queensland) as a query-key GeoJSON feed with a default public key", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "au-qld-traffic");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("CC-BY-4.0");
    // /v1 (clean geometry, no appended area-alert geometry) per the API spec.
    expect(feed!.url).toBe("https://api.qldtraffic.qld.gov.au/v1/events");
    expect(feed!.auth).toMatchObject({
      kind: "query-key",
      param: "apikey",
      envVar: "AU_QLD_TRAFFIC_API_KEY",
      defaultValue: "3e83add325cbb69ac4d8e5bf433d770b",
    });
    // Spec enum casing + severity + freshness mapping.
    expect(feed!.geojson?.typeMap?.["Special event"]).toBe("public_event");
    expect(feed!.geojson?.severityField).toBe("event_priority");
    expect(feed!.geojson?.severityMap?.["Red Alert"]).toBe("critical");
    expect(feed!.geojson?.updatedField).toBe("last_updated");
  });

  it("includes cita-lu (Luxembourg) as a CC0 DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "lu-cita");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.license).toBe("CC0-1.0");
    expect(feed!.country).toBe("LU");
  });

  it("includes brussels-be as a CC0 GeoJSON feed (EPSG:3812 reprojected)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "be-brussels");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.license).toBe("CC0-1.0");
    expect(feed!.country).toBe("BE");
  });

  it("includes flanders-be (Flanders) as a DATEX II feed (EPSG:31370 reprojected)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "be-flanders");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.country).toBe("BE");
  });

  it("includes trafficsa-au (South Australia) as a CC-BY GeoJSON feed (2 layers)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "au-sa-trafficsa");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(Array.isArray(feed!.url)).toBe(true);
    expect(feed!.license).toBe("CC-BY-4.0");
  });

  it("includes livetraffic-nsw (NSW) as a header-key GeoJSON feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "au-nsw-livetraffic");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.auth?.kind).toBe("header-key");
    expect(Array.isArray(feed!.url)).toBe(true);
  });

  it("includes longdo-th (Thailand) as a flatjson feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "th-longdo");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("flatjson");
    expect(feed!.geojson?.lonField).toBe("longitude");
  });

  it("returns parseFlatJson for flatjson", () => {
    expect(parserFor("flatjson")).toBe(parseFlatJson);
  });

  it("returns parseTrafikverket for trafikverket", () => {
    expect(parserFor("trafikverket")).toBe(parseTrafikverket);
  });

  it("includes nap-si (Slovenia) as a Basic-auth DATEX II feed covering events + roadworks", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "si-nap");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth?.kind).toBe("basic");
    expect(feed!.country).toBe("SI");
    // Both DATEX II v3.3 datasets on the B2B host, merged under one source.
    expect(feed!.url).toEqual([
      "https://b2b.ncup.si/data/b2b.events.datexii33",
      "https://b2b.ncup.si/data/b2b.roadworks.datexii33",
    ]);
  });

  it("includes trafikverket-se (Sweden) as a DATEX II GET feed (query-key, lon-lat posList)", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "se-trafikverket");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth).toEqual({
      kind: "query-key",
      param: "authenticationkey",
      envVar: "SE_TRAFIKVERKET_API_KEY",
    });
    expect(Array.isArray(feed!.url)).toBe(true);
    expect((feed!.url as string[])[0]).toContain("/datex2/3.1/roadworks/sit:situation");
    expect(feed!.posListLonLat).toBe(true);
  });

  it("includes ba-cortes-ar (Buenos Aires) as a templated geojson feed gated by requiredEnv", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "ar-ba-cortes")!;
    expect(feed.format).toBe("geojson");
    expect(typeof feed.url).toBe("string");
    expect(feed.requiredEnv).toContain("AR_BA_CLIENT_ID");
    expect(
      resolveFeedUrls(feed, resolvedEnv({ AR_BA_CLIENT_ID: "cid", AR_BA_CLIENT_SECRET: "csec" }))
    ).toEqual([
      "https://apitransporte.buenosaires.gob.ar/transito/v1/cortes?client_id=cid&client_secret=csec",
    ]);
  });

  it("includes nationalhighways-gb (England) as a header-key DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "gb-nationalhighways");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth).toEqual({
      kind: "header-key",
      header: "Ocp-Apim-Subscription-Key",
      envVar: "GB_NATIONALHIGHWAYS_API_KEY",
    });
    expect(feed!.country).toBe("GB");
  });

  it("includes vejdirektoratet-dk (Denmark) as a query-key DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "dk-vejdirektoratet");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth?.kind).toBe("query-key");
    expect(feed!.license).toBe("CC-BY-4.0");
    expect(feed!.country).toBe("DK");
  });

  it("includes asfinag-at (Austria) as a Basic-auth DATEX II feed covering planned + unplanned events", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "at-asfinag");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth?.kind).toBe("basic");
    expect(feed!.country).toBe("AT");
    // Both event records (planned roadworks + unplanned/safety) under one source.
    expect(Array.isArray(feed!.url)).toBe(true);
    expect((feed!.url as string[]).length).toBe(2);
  });

  it("includes tarktee-ee (Estonia) as a query-key DATEX II feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "ee-tarktee");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth?.kind).toBe("query-key");
    expect(feed!.country).toBe("EE");
  });

  it("includes verkehr-nrw-de (Straßen.NRW) as an mTLS DATEX II feed gated by requiredEnv", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "de-nw-verkehr");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("datex2");
    expect(feed!.auth).toEqual({
      kind: "mtls",
      certEnvVar: "MOBILITHEK_CERT",
      keyEnvVar: "MOBILITHEK_KEY",
    });
    expect(typeof feed!.url).toBe("string");
    expect(feed!.expandEnv).toBe("DE_NW_VERKEHR_SUBSCRIPTION_ID");
    expect(feed!.requiredEnv).toContain("DE_NW_VERKEHR_SUBSCRIPTION_ID");
    expect(feed!.license).toBe("dl-de/zero-2-0");
    expect(feed!.country).toBe("DE");
    // One client-pull URL per comma-separated subscription id, matching the
    // subscription's HTTPS Zugriffspunkt — the plain-HTTPS pull (no `/soap/`),
    // id in both path and query — plus the mandatory Accept-Encoding: gzip.
    expect(
      resolveFeedUrls(feed!, resolvedEnv({ DE_NW_VERKEHR_SUBSCRIPTION_ID: "2000001, 2000002" }))
    ).toEqual([
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/2000001/clientPullService?subscriptionID=2000001",
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/2000002/clientPullService?subscriptionID=2000002",
    ]);
    expect(feed!.requestHeaders?.["Accept-Encoding"]).toBe("gzip");
  });

  it("registers the German state Mobilithek feeds, all sharing the org cert and gated by a per-region subscription id", () => {
    const regions = FEED_SOURCES.filter(
      (f) => f.id === "de-nw-verkehr" || f.id.includes("-mobilithek")
    );
    // NRW-LVZ + NRW-kommunal + NRW-Mobidrom + 13 states.
    expect(regions.length).toBeGreaterThanOrEqual(16);
    const subEnvVars = new Set<string>();
    for (const feed of regions) {
      expect(feed.format).toBe("datex2");
      // Every region reuses the single org machine certificate.
      expect(feed.auth).toEqual({
        kind: "mtls",
        certEnvVar: "MOBILITHEK_CERT",
        keyEnvVar: "MOBILITHEK_KEY",
      });
      expect(feed.country).toBe("DE");
      expect(feed.requestHeaders?.["Accept-Encoding"]).toBe("gzip");
      expect(feed.attribution).toBeTruthy();
      expect(feed.license).toBeTruthy();
      // Gated by exactly one subscription-id env var, which must be unique so the
      // regions can be activated independently as the operator subscribes.
      expect(feed.requiredEnv).toHaveLength(1);
      const subEnvVar = feed.requiredEnv![0];
      expect(subEnvVar).toMatch(/^DE_[A-Z_]+_SUBSCRIPTION_ID$/);
      expect(subEnvVars.has(subEnvVar)).toBe(false);
      subEnvVars.add(subEnvVar);
      // Dormant until its subscription id is set — no id → no URLs.
      expect(feed.expandEnv).toBe(feed.requiredEnv![0]);
      expect(resolveFeedUrls(feed, resolvedEnv({}))).toEqual([]);
      // The Mobidrom bundle is CC-BY-SA and must stay isolated in its own feed.
      if (feed.id === "de-nw-mobilithek-mobidrom") expect(feed.license).toBe("CC-BY-SA-4.0");
    }
  });

  it("registers unique feed ids", () => {
    const ids = FEED_SOURCES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("loads every feed from the data files (all 70 migrated)", () => {
    expect(FEED_SOURCES.length).toBe(70);
    expect(new Set(FEED_SOURCES.map((f) => f.id)).size).toBe(FEED_SOURCES.length);
  });

  it("includes the two Autobahn GmbH BAB LoS Verkehrslage feeds, datex-elaborated flow, disabled by default", () => {
    const ids = ["de-nw-autobahn-loslane", "de-bw-autobahn-los"];
    for (const id of ids) {
      const f = FEED_SOURCES.find((s) => s.id === id);
      expect(f, id).toBeDefined();
      expect(f!.format).toBe("datex-elaborated");
      expect(f!.produces).toBe("flow");
      expect(f!.enabledByDefault).toBe(false);
      expect(f!.siteTable?.format).toBe("datex-predefined-locations");
    }
  });

  it("includes the five Autobahn GmbH BAB flow feeds, all datex-elaborated flow, GeoNutzV, disabled by default", () => {
    const ids = [
      "de-hh-autobahn-nord",
      "de-nw-autobahn-fahrstreifen",
      "de-he-autobahn-vzd",
      "de-bw-autobahn-suedwest",
      "de-by-autobahn",
    ];
    for (const id of ids) {
      const f = FEED_SOURCES.find((s) => s.id === id);
      expect(f, id).toBeDefined();
      expect(f!.format).toBe("datex-elaborated");
      expect(f!.produces).toBe("flow");
      expect(f!.license).toBe("GeoNutzV");
      expect(f!.enabledByDefault).toBe(false);
      expect(f!.auth).toEqual({
        kind: "mtls",
        certEnvVar: "MOBILITHEK_CERT",
        keyEnvVar: "MOBILITHEK_KEY",
      });
    }
  });

  it("wires PredefinedLocations site tables for the four with external geometry (not Bayern)", () => {
    for (const id of [
      "de-hh-autobahn-nord",
      "de-nw-autobahn-fahrstreifen",
      "de-he-autobahn-vzd",
      "de-bw-autobahn-suedwest",
    ]) {
      const f = FEED_SOURCES.find((s) => s.id === id)!;
      expect(f.siteTable?.format, id).toBe("datex-predefined-locations");
    }
    expect(FEED_SOURCES.find((s) => s.id === "de-by-autobahn")!.siteTable).toBeUndefined();
  });

  it("registers a flow parser for datex-elaborated", () => {
    expect(flowParserFor("datex-elaborated")).toBe(parseElaboratedFlow);
  });

  it("includes de-hh-polizei as a keyless open geojson police-incident feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "de-hh-polizei");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("geojson");
    expect(feed!.country).toBe("DE");
    expect(feed!.license).toBe("dl-de/by-2-0");
    expect(feed!.attribution).toBe("Freie und Hansestadt Hamburg, Polizei Hamburg");
    expect(feed!.auth).toBeUndefined();
    expect(feed!.url).toContain("api.hamburg.de");
    expect(feed!.geojson?.typeField).toBe("art");
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes nyc-dot-speed-us as a keyless nyc-dot flow feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "us-nyc-dot");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("nyc-dot");
    expect(feed!.produces).toBe("flow");
    expect(feed!.license).toBe("NYC-Open-Data");
    expect(feed!.country).toBe("US");
    expect(feed!.auth).toBeUndefined();
    expect(feed!.enabledByDefault).toBe(true);
  });

  it("includes ohgo-oh-us as a keyed ohgo flow feed", () => {
    const feed = FEED_SOURCES.find((f) => f.id === "us-oh-ohgo");
    expect(feed).toBeDefined();
    expect(feed!.format).toBe("ohgo");
    expect(feed!.produces).toBe("flow");
    expect(feed!.license).toBe("US-Gov-Public-Domain");
    expect(feed!.country).toBe("US");
    expect(feed!.auth).toEqual({
      kind: "header-key",
      header: "Authorization",
      envVar: "US_OH_OHGO_API_KEY",
      valuePrefix: "APIKEY ",
    });
    expect(feed!.enabledByDefault).toBe(true);
    expect(feed!.setup?.["US_OH_OHGO_API_KEY"]).toBeDefined();
  });
});

describe("parserFor", () => {
  it("returns parseDatexSituations for datex2", () => {
    expect(parserFor("datex2")).toBe(parseDatexSituations);
  });

  it("returns parseOpen511 for open511", () => {
    expect(parserFor("open511")).toBe(parseOpen511);
  });

  it("returns parseWzdx for wzdx", () => {
    expect(parserFor("wzdx")).toBe(parseWzdx);
  });

  it("returns parseGeoJson for geojson", () => {
    expect(parserFor("geojson")).toBe(parseGeoJson);
  });

  it("returns parseIbi511 for ibi511", () => {
    expect(parserFor("ibi511")).toBe(parseIbi511);
  });

  it("returns parseLtaIncidents for lta", () => {
    expect(parserFor("lta")).toBe(parseLtaIncidents);
  });

  it("returns parseGddkia for gddkia", () => {
    expect(parserFor("gddkia")).toBe(parseGddkia);
  });

  it("returns parseAutobahn for autobahn", () => {
    expect(parserFor("autobahn")).toBe(parseAutobahn);
  });

  it("returns parseDigitraffic for digitraffic", () => {
    expect(parserFor("digitraffic")).toBe(parseDigitraffic);
  });

  it("throws for an unsupported format", () => {
    expect(() => parserFor("traff" as never)).toThrow(/No parser registered/);
  });
});

describe("Buffer tolerance", () => {
  const drivebc_src = {
    id: "ca-bc-drivebc",
    attribution: "DriveBC",
    country: "CA",
    license: "OGL-BC",
  } as const;
  const wzdx_src = {
    id: "test-dot",
    attribution: "TestDOT",
    country: "US",
    license: "CC0-1.0",
  } as const;
  const autobahn_src = {
    id: "de-autobahn",
    attribution: "Autobahn GmbH des Bundes",
    country: "DE",
    license: "dl-de/by-2-0",
  } as const;
  const digitraffic_src = {
    id: "fi-digitraffic",
    attribution: "Fintraffic / Digitraffic",
    country: "FI",
    license: "CC-BY-4.0",
  } as const;

  it("parseOpen511 accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "drivebc/events.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseOpen511(obj, drivebc_src);
    const fromBuf = parseOpen511(buf, drivebc_src);
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });

  it("parseWzdx accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "wzdx/feed.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseWzdx(obj, wzdx_src);
    const fromBuf = parseWzdx(buf, wzdx_src);
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });

  it("parseAutobahn accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "autobahn/warning.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseAutobahn(obj, autobahn_src, "warning");
    const fromBuf = parseAutobahn(buf, autobahn_src, "warning");
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });

  it("parseDigitraffic accepts a Buffer and yields the same event count as the object", () => {
    const obj = JSON.parse(readFileSync(join(FIXTURES, "digitraffic/messages.json"), "utf8"));
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    const fromObj = parseDigitraffic(obj, digitraffic_src);
    const fromBuf = parseDigitraffic(buf, digitraffic_src);
    expect(fromBuf.length).toBeGreaterThan(0);
    expect(fromBuf.length).toBe(fromObj.length);
  });
});

describe("feedToSourceDescriptor", () => {
  it("maps ndw feed to a SourceDescriptor with matching license", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.license).toBe("CC0-1.0");
  });

  it("maps ndw feed id and attribution correctly", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.id).toBe("nl-ndw");
    expect(desc.attribution).toBe("NDW / Rijkswaterstaat");
  });

  it("includes licenseUrl when present", () => {
    const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw")!;
    const desc = feedToSourceDescriptor(ndw);
    expect(desc.licenseUrl).toBeDefined();
  });
});
