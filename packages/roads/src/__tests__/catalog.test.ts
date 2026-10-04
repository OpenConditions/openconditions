import path from "node:path";
import {
  type CatalogFeed,
  type CatalogFile,
  deriveFeedId,
  feedCredentialNames,
  licenseInfo,
  lintCatalog,
  readCatalogDir,
  resolveEndpointUrls,
  type SharedCredentials,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { roadsDomain } from "../domain.js";

const repoFeedsDir = path.resolve(import.meta.dirname, "../../../../feeds");

let loaded: { files: CatalogFile[]; credentials: SharedCredentials } | undefined;

/** The repo catalogue's roads files (the other domains' directories unread) and its shared credentials. */
function repoCatalog(): { files: CatalogFile[]; credentials: SharedCredentials } {
  loaded ??= readCatalogDir(repoFeedsDir, [roadsDomain], { otherDomains: "ignore" });
  return loaded;
}

let resolvedFeeds: CatalogFeed[] | undefined;
let feedsById: Map<string, CatalogFeed> | undefined;

/** Every feed of the repo catalogue, resolved as the service sees it. */
function allFeeds(): CatalogFeed[] {
  resolvedFeeds ??= repoCatalog().files.flatMap((file) =>
    file.feeds.map((def) =>
      toCatalogFeed(def, {
        domain: file.domain,
        region: file.region,
        file: file.path,
        maintainers: file.maintainers,
      }),
    ),
  );
  return resolvedFeeds;
}

function feed(id: string): CatalogFeed {
  feedsById ??= new Map(allFeeds().map((f) => [f.id, f]));
  const found = feedsById.get(id);
  if (!found) throw new Error(`no feed ${id} in the catalogue`);
  return found;
}

const main = (id: string) => feed(id).endpoints["main"]!;
const sites = (id: string) => feed(id).endpoints["sites"];

const MOBILITHEK_MTLS = { kind: "mtls", cert: "@mobilithek.cert", key: "@mobilithek.key" };

const AUTOBAHN_FLOW = [
  "de-hh-autobahn-flow",
  "de-nw-autobahn-flow",
  "de-he-autobahn-flow",
  "de-bw-autobahn-flow",
  "de-by-autobahn-flow",
  "de-nw-autobahn-los-flow",
  "de-bw-autobahn-los-flow",
];

describe("the roads catalogue", () => {
  test("the catalogue holds the 86 roads feeds under their new ids", () => {
    const { files, credentials } = repoCatalog();
    const ids = files.flatMap((f) => f.feeds.map((d) => deriveFeedId({ region: f.region, ...d })));
    expect(ids).toHaveLength(86);
    expect(ids).toEqual(
      expect.arrayContaining([
        "nl-ndw-events",
        "de-hh-autobahn-flow",
        "us-oh-ohgo-events",
        "ca-on-511-conditions",
      ]),
    );
    // The issues of the roads files. Whether a shared group serves enough feeds
    // depends on every domain's feeds, so `feeds:lint` judges it on the whole
    // catalogue; read alone, the roads files leave the other domains' groups unused.
    const roadsFiles = new Set(files.map((f) => f.path));
    expect(
      lintCatalog(files, credentials, [roadsDomain]).filter(
        (i) => i.level === "error" && roadsFiles.has(i.file),
      ),
    ).toEqual([]);
  });

  test("one Mobilithek setup guide serves every Mobilithek feed", () => {
    const { credentials } = repoCatalog();
    expect(Object.keys(credentials.groups.mobilithek!)).toEqual(["cert", "key"]);
  });

  test("every feed id is the one the id table gives it", () => {
    expect(
      allFeeds()
        .map((f) => f.id)
        .sort(),
    ).toEqual(
      [
        "ar-ba-cortes-events",
        "at-asfinag-events",
        "au-nsw-livetraffic-events",
        "au-sa-trafficsa-events",
        "au-qld-traffic-events",
        "au-vic-vicroads-flow",
        "au-vic-transportvic-planned-events",
        "au-vic-transportvic-unplanned-events",
        "be-flanders-events",
        "be-brussels-events",
        "be-miv-flow",
        "ca-bc-drivebc-events",
        "ca-on-511-events",
        "ca-on-511-construction-events",
        "ca-on-511-conditions",
        "ca-qc-mtq-events",
        "ca-qc-mtq-warnings-events",
        "de-autobahn-events",
        "de-bw-svzbw-events",
        "de-be-berlin-events",
        "de-nw-verkehr-events",
        "de-nw-duesseldorf-events",
        "de-nw-koeln-events",
        "de-nw-unna-events",
        "de-nw-mobidrom-events",
        "de-by-mobilithek-events",
        "de-bw-mobilithek-events",
        "de-be-mobilithek-events",
        "de-bb-mobilithek-events",
        "de-hb-mobilithek-events",
        "de-hh-mobilithek-events",
        "de-hh-polizei-events",
        "de-he-mobilithek-events",
        "de-mv-mobilithek-events",
        "de-ni-nlstbv-events",
        "de-ni-hannover-events",
        "de-sn-mobilithek-events",
        "de-st-mobilithek-events",
        "de-sh-mobilithek-events",
        "de-th-mobilithek-events",
        "de-nw-bonn-flow",
        ...AUTOBAHN_FLOW,
        "dk-vejdirektoratet-events",
        "ee-tarktee-events",
        "es-dgt-events",
        "es-madrid-flow",
        "es-bcn-ajuntament-flow",
        "fi-digitraffic-events",
        "fi-fintraffic-flow",
        "fr-dir-events",
        "fr-dir-flow",
        "fr-rennesmetropole-flow",
        "fr-bordeauxmetropole-flow",
        "gb-nationalhighways-events",
        "hk-td-flow",
        "hr-hc-roadworks-events",
        "hr-hc-events",
        "is-vegagerdin-conditions",
        "is-vegagerdin-lines-conditions",
        "it-turin-flow",
        "lu-cita-events",
        "nl-ndw-events",
        "nl-ndw-flow",
        "no-vegvesen-events",
        "no-vegvesen-flow",
        "nz-nzta-events",
        "pl-gddkia-events",
        "se-trafikverket-events",
        "se-trafikverket-flow",
        "sg-lta-events",
        "sg-lta-flow",
        "si-nap-events",
        "th-longdo-events",
        "us-wzdx-events",
        "us-ny-511-events",
        "us-ny-511-conditions",
        "us-nyc-dot-flow",
        "us-oh-ohgo-flow",
        "us-oh-ohgo-construction-events",
        "us-oh-ohgo-events",
      ].sort(),
    );
  });

  test("every feed's licence is in the registry", () => {
    expect(allFeeds().filter((f) => !licenseInfo(f.license))).toEqual([]);
  });

  test("the shared credential groups are Mobilithek's, one per operator account and the Overpass setting", () => {
    const groups = repoCatalog().credentials.groups;
    expect(Object.keys(groups).sort()).toEqual([
      "au-vic-transportvic",
      "hr-hc",
      "mobilithek",
      "no-vegvesen",
      "overpass",
      "se-trafikverket",
      "sg-lta",
      "us-ny-511",
      "us-oh-ohgo",
    ]);
    expect(Object.keys(groups["hr-hc"]!)).toEqual(["user", "password"]);
    expect(Object.keys(groups["no-vegvesen"]!)).toEqual(["user", "password"]);
    for (const group of ["au-vic-transportvic", "se-trafikverket", "sg-lta", "us-ny-511"]) {
      expect(Object.keys(groups[group]!), group).toEqual(["api_key"]);
    }
  });

  test("reference endpoints refresh every six hours and carry a decoder", () => {
    for (const f of allFeeds()) {
      const ref = f.endpoints["sites"];
      if (!ref) continue;
      expect(ref.cadenceSec, f.id).toBe(21600);
      expect(ref.decoder, f.id).toBeDefined();
    }
  });
});

describe("NDW", () => {
  test("polls the event feed over the verified https endpoint, gzipped", () => {
    const ndw = feed("nl-ndw-events");
    expect(ndw.format).toBe("datex2");
    expect(ndw.product).toBe("events");
    expect(main("nl-ndw-events")).toEqual({
      url: "https://opendata.ndw.nu/actueel_beeld.xml.gz",
      gzip: true,
      cadenceSec: 60,
    });
    expect(ndw.freshnessWindowSec).toBe(300);
  });

  test("declares the event feed as a complete DATEX situation publication", () => {
    expect(feed("nl-ndw-events").snapshot).toEqual({
      completeness: "complete",
      rootElement: "messageContainer",
      publicationElement: "payload",
      publicationType: "SituationPublication",
      recordElement: "situationRecord",
    });
  });

  test("carries the CC0 grant and canonical licence link", () => {
    const ndw = feed("nl-ndw-events");
    expect(ndw.license).toBe("CC0-1.0");
    expect(ndw.licenseUrl).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(ndw.attribution).toBe("NDW / Rijkswaterstaat");
    expect(ndw.terms).toEqual({
      url: "https://www.ndw.nu/service/copyright",
      reviewedAt: "2026-09-12",
    });
    expect(ndw.rights).toMatchObject({
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      attributionRequired: false,
      retention: true,
    });
  });

  test("measures flow from trafficspeed joined to the gzipped measurement site table", () => {
    const flow = feed("nl-ndw-flow");
    expect(flow.format).toBe("datex2-measured");
    expect(flow.product).toBe("flow");
    expect(flow.snapshot).toBeUndefined();
    expect(flow.terms).toBeUndefined();
    expect(flow.licenseUrl).toBe("https://www.ndw.nu");
    expect(main("nl-ndw-flow")).toEqual({
      url: "https://opendata.ndw.nu/trafficspeed.xml.gz",
      gzip: true,
      cadenceSec: 60,
    });
    expect(sites("nl-ndw-flow")).toEqual({
      url: "https://opendata.ndw.nu/measurement.xml.gz",
      gzip: true,
      decoder: "datex2-sites",
      cadenceSec: 21600,
    });
  });

  test("only NDW numbers lanes from the left", () => {
    const leftFirst = allFeeds()
      .filter((f) => (f as { laneNumbering?: string }).laneNumbering === "left_first")
      .map((f) => f.id);
    expect(leftFirst.sort()).toEqual(["nl-ndw-events", "nl-ndw-flow"]);
  });
});

describe("Digitraffic and Fintraffic", () => {
  test("polls the four supported v2 collections and no v1 endpoint", () => {
    const urls = main("fi-digitraffic-events").urls!;
    expect(urls).toEqual([
      "https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements",
      "https://tie.digitraffic.fi/api/traffic-message/v2/roadworks",
      "https://tie.digitraffic.fi/api/traffic-message/v2/weight-restrictions",
      "https://tie.digitraffic.fi/api/traffic-message/v2/exempted-transports",
    ]);
    for (const url of urls) {
      expect(url, url).not.toContain("/v1/");
      // v2 rejects the v1 query parameters, and the unfiltered collection is
      // what keeps the snapshot nationally complete.
      expect(new URL(url).search, url).toBe("");
    }
  });

  test("declares the request headers the publisher requires", () => {
    expect(main("fi-digitraffic-events").headers).toEqual({
      "Digitraffic-User": "OpenConditions/1.0",
      "Accept-Encoding": "gzip",
    });
  });

  test("declares a complete features snapshot at the reviewed cadence", () => {
    const f = feed("fi-digitraffic-events");
    expect(f.format).toBe("digitraffic");
    expect(f.snapshot).toEqual({ completeness: "complete", recordsPath: "features" });
    expect(main("fi-digitraffic-events").cadenceSec).toBe(120);
    expect(f.freshnessWindowSec).toBe(600);
  });

  test("carries the CC BY 4.0 grant", () => {
    const f = feed("fi-digitraffic-events");
    expect(f.license).toBe("CC-BY-4.0");
    expect(f.licenseUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(f.attribution).toBe("Fintraffic / Digitraffic");
    expect(f.country).toBe("FI");
    expect(f.rights).toMatchObject({
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      attributionRequired: true,
      retention: true,
    });
  });

  test("reads TMS flow joined to the station registry, with the user header on both", () => {
    const tms = feed("fi-fintraffic-flow");
    expect(tms.format).toBe("fintraffic-tms");
    expect(tms.product).toBe("flow");
    expect(tms.snapshot).toBeUndefined();
    expect(main("fi-fintraffic-flow").url).toBe(
      "https://tie.digitraffic.fi/api/tms/v1/stations/data",
    );
    expect(sites("fi-fintraffic-flow")).toEqual({
      url: "https://tie.digitraffic.fi/api/tms/v1/stations",
      headers: { "Digitraffic-User": "OpenConditions/1.0" },
      decoder: "fintraffic-stations",
      cadenceSec: 21600,
    });
  });
});

describe("Mobilithek", () => {
  const mobilithekFeeds = () =>
    allFeeds().filter((f) => f.auth?.kind === "mtls" && f.auth.cert === "@mobilithek.cert");

  test("LVZ.NRW fans out one client pull per subscription id", () => {
    const f = feed("de-nw-verkehr-events");
    expect(f.format).toBe("datex2");
    expect(f.auth).toEqual(MOBILITHEK_MTLS);
    expect(f.license).toBe("DL-DE-ZERO-2.0");
    expect(f.country).toBe("DE");
    expect(main(f.id).expand).toBe("subscription_id");
    // One client-pull URL per comma-separated subscription id, matching the
    // subscription's HTTPS Zugriffspunkt: the plain-HTTPS pull (no `/soap/`),
    // the id in both path and query, plus the mandatory Accept-Encoding: gzip.
    expect(
      resolveEndpointUrls(f, "main", {
        DE_NW_VERKEHR_EVENTS_SUBSCRIPTION_ID: "2000001, 2000002",
      }),
    ).toEqual([
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/2000001/clientPullService?subscriptionID=2000001",
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/2000002/clientPullService?subscriptionID=2000002",
    ]);
    expect(main(f.id).headers?.["Accept-Encoding"]).toBe("gzip");
  });

  test("the regional situation feeds share the org certificate, each gated by its own subscription id", () => {
    // Selected by the certificate they share rather than by a substring of
    // their id: the municipal feeds are named for their city. Autobahn GmbH's
    // flow feeds ride the same certificate but are a different publisher family.
    const regions = mobilithekFeeds().filter((f) => f.operator !== "autobahn");
    // NRW-LVZ + Düsseldorf + Köln + Kreis Unna + NRW.Mobidrom + NLStBV + Hannover + 12 states.
    expect(regions).toHaveLength(19);
    const envNames = new Set<string>();
    for (const f of regions) {
      expect(f.format, f.id).toBe("datex2");
      expect(f.product, f.id).toBe("events");
      expect(f.country, f.id).toBe("DE");
      expect(f.auth, f.id).toEqual(MOBILITHEK_MTLS);
      expect(main(f.id).headers?.["Accept-Encoding"], f.id).toBe("gzip");
      expect(f.attribution, f.id).toBeTruthy();
      expect(Object.keys(f.credentials ?? {}), f.id).toEqual(["subscription_id"]);
      expect(main(f.id).expand, f.id).toBe("subscription_id");
      const names = feedCredentialNames(f).map((n) => n.env);
      expect(names.sort(), f.id).toEqual(
        [
          "MOBILITHEK_CERT",
          "MOBILITHEK_KEY",
          `${f.id.toUpperCase().replaceAll("-", "_")}_SUBSCRIPTION_ID`,
        ].sort(),
      );
      const own = names.find((n) => n.endsWith("_SUBSCRIPTION_ID"))!;
      expect(envNames.has(own), f.id).toBe(false);
      envNames.add(own);
      // Dormant until its subscription id is set: no id, no URLs.
      expect(resolveEndpointUrls(f, "main", {}), f.id).toEqual([]);
    }
  });

  test("the NRW.Mobidrom bundle stays isolated under its ShareAlike licence", () => {
    const f = feed("de-nw-mobidrom-events");
    expect(f.license).toBe("CC-BY-SA-4.0");
    expect(f.tier).toBe("aggregator");
  });

  test("Köln and NLStBV tolerate one lapsed offer", () => {
    expect(main("de-nw-koeln-events").fanout).toBe("tolerant");
    expect(main("de-ni-nlstbv-events").fanout).toBe("tolerant");
  });

  test("Mecklenburg-Vorpommern declares its UTM grid", () => {
    expect((feed("de-mv-mobilithek-events") as { srsName?: string }).srsName).toBe("EPSG:5650");
  });
});

describe("Autobahn GmbH", () => {
  test("the event feed enumerates every motorway from the road index", () => {
    const f = feed("de-autobahn-events");
    expect(f.format).toBe("autobahn");
    expect(f.license).toBe("DL-DE-BY-2.0");
    expect(f.catalog?.resolver).toBe("autobahn-index");
    // No approved list: the parent fans its children out at fetch time.
    expect(f.catalog?.approvedChildren).toBeUndefined();
    expect(main(f.id).url).toBe("https://verkehr.autobahn.de/o/autobahn/");
  });

  test("the seven flow feeds: GeoNutzV, Mobilithek mTLS, the DATEX profile each region serves", () => {
    // NRW serves the ElaboratedDataPublication profile; the rest serve
    // MeasuredDataPublication, verified per region against live payloads.
    const elaborated = new Set(["de-nw-autobahn-flow", "de-nw-autobahn-los-flow"]);
    for (const id of AUTOBAHN_FLOW) {
      const f = feed(id);
      expect(f.format, id).toBe(elaborated.has(id) ? "datex2-elaborated" : "datex2-measured");
      expect(f.product, id).toBe("flow");
      expect(f.license, id).toBe("LicenseRef-GeoNutzV");
      expect(f.auth, id).toEqual(MOBILITHEK_MTLS);
      expect(main(id).cadenceSec, id).toBe(60);
      expect(main(id).headers?.["Accept-Encoding"], id).toBe("gzip");
    }
  });

  test("wires a Verortung for every flow feed", () => {
    for (const id of AUTOBAHN_FLOW.filter((id) => id !== "de-by-autobahn-flow")) {
      const ref = sites(id)!;
      expect(ref.url, id).toBe(
        "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/${sites_subscription_id}/clientPullService?subscriptionID=${sites_subscription_id}",
      );
      expect(ref.decoder, id).toBe(id.startsWith("de-nw-") ? "datex2-locations" : "datex2-sites");
      expect(Object.keys(feed(id).credentials ?? {}).sort(), id).toEqual([
        "sites_subscription_id",
        "subscription_id",
      ]);
    }
    // Bayern's site table is a public, versioned reference file on the offer.
    expect(sites("de-by-autobahn-flow")).toEqual({
      reference: {
        kind: "mobilithek",
        offerId: "748580849261105152",
        fileNamePrefix: "D2MSTPub_LVE_",
      },
      decoder: "datex2-sites",
      cadenceSec: 21600,
    });
  });

  test("names the flow credentials by the new feed ids", () => {
    const names = feedCredentialNames(feed("de-hh-autobahn-flow")).map((n) => n.env);
    expect(names.sort()).toEqual([
      "DE_HH_AUTOBAHN_FLOW_SITES_SUBSCRIPTION_ID",
      "DE_HH_AUTOBAHN_FLOW_SUBSCRIPTION_ID",
      "MOBILITHEK_CERT",
      "MOBILITHEK_KEY",
    ]);
  });
});

describe("catalogue feeds", () => {
  test("WZDx resolves the registry and approves Kansas by its child id", () => {
    const f = feed("us-wzdx-events");
    expect(f.format).toBe("wzdx");
    expect(f.catalog).toEqual({
      resolver: "wzdx-registry",
      approvedChildren: ["us-wzdx-fe9b3423ea03546f-events"],
    });
    expect(f.license).toBe("NOASSERTION");
    expect(f.terms?.note).toMatch(/registry/);
    expect(f.terms?.url).toContain("datahub.transportation.gov");
  });
});

describe("one feed per publisher", () => {
  test("DriveBC paginates: the endpoint's default page is 50 of ~250 events", () => {
    const f = feed("ca-bc-drivebc-events");
    expect(f.format).toBe("open511");
    expect(f.license).toBe("LicenseRef-OGL-BC");
    expect(main(f.id).url).toContain("limit=500");
    expect(main(f.id).pagination).toEqual({
      skipParam: "offset",
      pageSize: 500,
      recordsPath: "events",
    });
  });

  test("DGT Spain is an open DATEX II feed", () => {
    const f = feed("es-dgt-events");
    expect(f.format).toBe("datex2");
    expect(f.license).toBe("CC-BY-4.0");
    expect(f.country).toBe("ES");
    expect(typeof main(f.id).url).toBe("string");
  });

  test("MobiData BW roadworks is an open DATEX II feed", () => {
    const f = feed("de-bw-svzbw-events");
    expect(f.format).toBe("datex2");
    expect(f.license).toBe("DL-DE-BY-2.0");
  });

  test("France DIR is an open, complete DATEX II publication under etalab", () => {
    const f = feed("fr-dir-events");
    expect(f.format).toBe("datex2");
    expect(f.license).toBe("etalab-2.0");
    expect(f.country).toBe("FR");
    expect(f.rights).toMatchObject({
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      retention: true,
    });
  });

  test("France DIR flow joins the comptage registry", () => {
    expect(feed("fr-dir-flow").format).toBe("datex2-measured");
    expect(sites("fr-dir-flow")?.decoder).toBe("france-comptage-csv");
  });

  test("CITA is CC0 with its reusable-source grant", () => {
    const f = feed("lu-cita-events");
    expect(f.format).toBe("datex2");
    expect(f.license).toBe("CC0-1.0");
    expect(f.country).toBe("LU");
    expect(f.rights).toMatchObject({
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      retention: true,
    });
  });

  test("Hrvatske ceste's two publications share one B2B account", () => {
    for (const id of ["hr-hc-roadworks-events", "hr-hc-events"]) {
      expect(feed(id).format, id).toBe("datex2");
      expect(feed(id).auth, id).toEqual({
        kind: "basic",
        user: "@hr-hc.user",
        password: "@hr-hc.password",
      });
    }
  });

  test("NZTA is an open GeoJSON feed with a mapping", () => {
    const f = feed("nz-nzta-events");
    expect(f.format).toBe("geojson");
    expect(f.license).toBe("CC-BY-4.0");
    expect((f as { geojson?: { typeField?: string } }).geojson?.typeField).toBe("eventDescription");
  });

  test("VIZ Berlin is an open GeoJSON feed", () => {
    const f = feed("de-be-berlin-events");
    expect(f.format).toBe("geojson");
    expect(f.license).toBe("DL-DE-BY-2.0");
    expect(f.country).toBe("DE");
  });

  test("Ontario 511 needs no key", () => {
    const f = feed("ca-on-511-events");
    expect(f.format).toBe("ibi511");
    expect(f.auth).toBeUndefined();
    expect(f.credentials).toBeUndefined();
  });

  test("511NY events and winter roads share one documented API key", () => {
    for (const id of ["us-ny-511-events", "us-ny-511-conditions"]) {
      expect(feed(id).auth, id).toEqual({
        kind: "query-key",
        param: "key",
        credential: "@us-ny-511.api_key",
      });
    }
    expect(feed("us-ny-511-events").format).toBe("ibi511");
    expect(feed("us-ny-511-conditions").format).toBe("ibi511-conditions");
    const key = repoCatalog().credentials.groups["us-ny-511"]!["api_key"]!;
    expect(key.title).toBeTruthy();
    expect(key.setup?.url).toContain("511ny.org");
  });

  test("LTA incidents and speed bands share one AccountKey", () => {
    expect(feed("sg-lta-events").format).toBe("lta");
    for (const id of ["sg-lta-events", "sg-lta-flow"]) {
      expect(feed(id).auth, id).toEqual({
        kind: "header-key",
        header: "AccountKey",
        credential: "@sg-lta.api_key",
      });
    }
    expect(main("sg-lta-flow").pagination).toEqual({
      skipParam: "$skip",
      pageSize: 500,
      maxPages: 200,
    });
  });

  test("MTQ roadworks is an open GeoJSON feed", () => {
    const f = feed("ca-qc-mtq-events");
    expect(f.format).toBe("geojson");
    expect(f.license).toBe("CC-BY-4.0");
    expect((f as { geojson?: { defaultType?: string } }).geojson?.defaultType).toBe("roadworks");
  });

  test("GDDKiA uses the canonical www host", () => {
    const f = feed("pl-gddkia-events");
    expect(f.format).toBe("gddkia");
    expect(f.license).toBe("CC0-1.0");
    expect(f.country).toBe("PL");
    // The bare archiwum host redirects via an http hop and its DNS proved
    // flaky from the ingest container.
    expect(main(f.id).url).toBe("https://www.archiwum.gddkia.gov.pl/dane/zima_html/utrdane.xml");
  });

  test("Statens vegvesen events and flow share one DATEX account", () => {
    for (const id of ["no-vegvesen-events", "no-vegvesen-flow"]) {
      expect(feed(id).auth, id).toEqual({
        kind: "basic",
        user: "@no-vegvesen.user",
        password: "@no-vegvesen.password",
      });
    }
    expect(feed("no-vegvesen-events").format).toBe("datex2");
    expect(feed("no-vegvesen-flow").format).toBe("datex2-measured");
    expect(sites("no-vegvesen-flow")?.decoder).toBe("datex2-sites");
  });

  test("Vegagerðin points read lon/lat fields", () => {
    const f = feed("is-vegagerdin-conditions") as CatalogFeed & {
      geojson?: { lonField?: string; latField?: string };
    };
    expect(f.format).toBe("geojson");
    expect(f.product).toBe("conditions");
    expect(f.geojson?.lonField).toBe("X");
    expect(f.geojson?.latField).toBe("Y");
  });

  test("QLDTraffic ships the published public key as the default", () => {
    const f = feed("au-qld-traffic-events") as CatalogFeed & {
      geojson?: {
        typeMap?: Record<string, string>;
        severityField?: string;
        severityMap?: Record<string, string>;
        updatedField?: string;
      };
    };
    expect(f.format).toBe("geojson");
    expect(f.license).toBe("CC-BY-4.0");
    // /v1: clean geometry, no appended area-alert geometry.
    expect(main(f.id).url).toBe("https://api.qldtraffic.qld.gov.au/v1/events");
    expect(f.auth).toEqual({ kind: "query-key", param: "apikey", credential: "api_key" });
    expect(f.credentials?.["api_key"]?.default).toBe("3e83add325cbb69ac4d8e5bf433d770b");
    expect(feedCredentialNames(f)).toEqual([
      {
        ref: "api_key",
        env: "AU_QLD_TRAFFIC_EVENTS_API_KEY",
        optional: false,
        default: "3e83add325cbb69ac4d8e5bf433d770b",
      },
    ]);
    expect(f.geojson?.typeMap?.["Special event"]).toBe("public_event");
    expect(f.geojson?.severityField).toBe("event_priority");
    expect(f.geojson?.severityMap?.["Red Alert"]).toBe("critical");
    expect(f.geojson?.updatedField).toBe("last_updated");
  });

  test("Brussels and Flanders are Belgian feeds", () => {
    expect(feed("be-brussels-events").format).toBe("geojson");
    expect(feed("be-brussels-events").license).toBe("CC0-1.0");
    expect(feed("be-brussels-events").country).toBe("BE");
    expect(feed("be-flanders-events").format).toBe("datex2");
  });

  test("Traffic SA polls two layers", () => {
    const f = feed("au-sa-trafficsa-events");
    expect(f.format).toBe("geojson");
    expect(f.license).toBe("CC-BY-4.0");
    expect(main(f.id).urls).toHaveLength(2);
  });

  test("Live Traffic NSW sends its key as a header", () => {
    const f = feed("au-nsw-livetraffic-events");
    expect(f.format).toBe("geojson");
    expect(f.auth).toEqual({
      kind: "header-key",
      header: "Authorization",
      credential: "api_key",
      valuePrefix: "apikey ",
    });
    expect(main(f.id).urls).toHaveLength(6);
  });

  test("Transport Victoria's three feeds share one portal key", () => {
    for (const id of [
      "au-vic-vicroads-flow",
      "au-vic-transportvic-planned-events",
      "au-vic-transportvic-unplanned-events",
    ]) {
      expect(feed(id).auth, id).toEqual({
        kind: "header-key",
        header: "Ocp-Apim-Subscription-Key",
        credential: "@au-vic-transportvic.api_key",
      });
    }
  });

  test("Longdo is a flatjson feed", () => {
    const f = feed("th-longdo-events") as CatalogFeed & { geojson?: { lonField?: string } };
    expect(f.format).toBe("flatjson");
    expect(f.geojson?.lonField).toBe("longitude");
  });

  test("NAP Slovenia merges both DATEX II v3.3 datasets", () => {
    const f = feed("si-nap-events");
    expect(f.format).toBe("datex2");
    expect(f.auth?.kind).toBe("basic");
    expect(f.country).toBe("SI");
    expect(main(f.id).urls).toEqual([
      "https://b2b.ncup.si/data/b2b.events.datexii33",
      "https://b2b.ncup.si/data/b2b.roadworks.datexii33",
    ]);
  });

  test("Trafikverket situations: query key, lon-lat posList", () => {
    const f = feed("se-trafikverket-events") as CatalogFeed & { posListLonLat?: boolean };
    expect(f.format).toBe("datex2");
    expect(f.auth).toEqual({
      kind: "query-key",
      param: "authenticationkey",
      credential: "@se-trafikverket.api_key",
    });
    expect(main(f.id).urls![0]).toContain("/datex2/3.1/roadworks/sit:situation");
    expect(f.posListLonLat).toBe(true);
  });

  test("Trafikverket flow sends the shared key in its POST body", () => {
    const flow = main("se-trafikverket-flow");
    expect(flow.method).toBe("POST");
    expect(flow.body).toContain('authenticationkey="${@se-trafikverket.api_key}"');
    expect(feed("se-trafikverket-flow").auth).toBeUndefined();
  });

  test("Buenos Aires puts its client id and secret in the URL", () => {
    const f = feed("ar-ba-cortes-events");
    expect(f.format).toBe("geojson");
    expect(Object.keys(f.credentials ?? {})).toEqual(["client_id", "client_secret"]);
    expect(
      resolveEndpointUrls(f, "main", {
        AR_BA_CORTES_EVENTS_CLIENT_ID: "cid",
        AR_BA_CORTES_EVENTS_CLIENT_SECRET: "csec",
      }),
    ).toEqual([
      "https://apitransporte.buenosaires.gob.ar/transito/v1/cortes?client_id=cid&client_secret=csec",
    ]);
  });

  test("National Highways sends its key as a header", () => {
    const f = feed("gb-nationalhighways-events");
    expect(f.format).toBe("datex2");
    expect(f.auth).toEqual({
      kind: "header-key",
      header: "Ocp-Apim-Subscription-Key",
      credential: "api_key",
    });
    expect(f.country).toBe("GB");
  });

  test("Vejdirektoratet is a query-key DATEX II feed", () => {
    const f = feed("dk-vejdirektoratet-events");
    expect(f.format).toBe("datex2");
    expect(f.auth?.kind).toBe("query-key");
    expect(f.license).toBe("CC-BY-4.0");
    expect(f.country).toBe("DK");
  });

  test("ASFINAG covers planned and unplanned events", () => {
    const f = feed("at-asfinag-events");
    expect(f.format).toBe("datex2");
    expect(f.auth?.kind).toBe("basic");
    expect(f.country).toBe("AT");
    expect(main(f.id).urls).toHaveLength(2);
  });

  test("Tark Tee is a query-key DATEX II feed", () => {
    const f = feed("ee-tarktee-events");
    expect(f.format).toBe("datex2");
    expect(f.auth?.kind).toBe("query-key");
    expect(f.country).toBe("EE");
  });

  test("Polizei Hamburg is a keyless open GeoJSON incident feed", () => {
    const f = feed("de-hh-polizei-events") as CatalogFeed & { geojson?: { typeField?: string } };
    expect(f.format).toBe("geojson");
    expect(f.country).toBe("DE");
    expect(f.license).toBe("DL-DE-BY-2.0");
    expect(f.attribution).toBe("Freie und Hansestadt Hamburg, Polizei Hamburg");
    expect(f.auth).toBeUndefined();
    expect(main(f.id).url).toContain("api.hamburg.de");
    expect(f.geojson?.typeField).toBe("art");
  });

  test("NYC DOT speeds are a keyless flow feed", () => {
    const f = feed("us-nyc-dot-flow");
    expect(f.format).toBe("nyc-dot");
    expect(f.product).toBe("flow");
    expect(f.license).toBe("LicenseRef-NYC-Open-Data");
    expect(f.country).toBe("US");
    expect(f.auth).toBeUndefined();
  });

  test("OHGO's three feeds share one documented API key", () => {
    const f = feed("us-oh-ohgo-flow");
    expect(f.format).toBe("ohgo");
    expect(f.product).toBe("flow");
    expect(f.license).toBe("LicenseRef-US-Gov-Public-Domain");
    expect(f.country).toBe("US");
    for (const id of ["us-oh-ohgo-flow", "us-oh-ohgo-construction-events", "us-oh-ohgo-events"]) {
      expect(feed(id).auth, id).toEqual({
        kind: "header-key",
        header: "Authorization",
        credential: "@us-oh-ohgo.api_key",
        valuePrefix: "APIKEY ",
      });
    }
    expect(repoCatalog().credentials.groups["us-oh-ohgo"]?.["api_key"]?.setup).toBeDefined();
  });

  test("the station-registry flow feeds name their registry decoder", () => {
    expect(sites("be-miv-flow")?.decoder).toBe("miv-config");
    expect(sites("hk-td-flow")?.decoder).toBe("hk-detector-csv");
    expect(sites("es-bcn-ajuntament-flow")?.decoder).toBe("bcn-trams-csv");
  });
});

describe("source tiers", () => {
  test("only the relays are aggregators", () => {
    const aggregators = allFeeds()
      .filter((f) => f.tier === "aggregator")
      .map((f) => f.id);
    expect(aggregators.sort()).toEqual(["de-nw-mobidrom-events", "th-longdo-events"]);
  });
});
