import type { SourceFormat } from "@openconditions/core";
import type { FeedAuth, FeedSourceBase } from "@openconditions/ingest-framework";
import type { GeoJsonMapping } from "./model.js";
import type { SiteGeometry } from "./siteTable.js";
import { parseDatexSituations } from "./datex.js";
import { parseGeoJson } from "./geojson.js";
import { parseFlatJson } from "./flatjson.js";
import { parseTrafikverket } from "./trafikverket.js";
import { parseIbi511 } from "./ibi511.js";
import { parseGddkia } from "./gddkia.js";
import { parseLtaIncidents } from "./lta.js";
import { parseOpen511 } from "./open511.js";
import { parseWzdx } from "./wzdx.js";
import { parseAutobahn } from "./autobahn.js";
import { parseDigitraffic } from "./digitraffic.js";
import { parseDigitrafficFlow, parseDatexMeasuredData } from "./flow.js";
import type { FlowParseResult } from "./flow.js";
import { discoverAutobahnRoads, discoverWzdxFeeds } from "./discover.js";
import type { SourceDescriptor } from "./types.js";

// FeedAuth now lives in @openconditions/ingest-framework; re-exported here so
// existing consumers of @openconditions/roads are unaffected.
export type { FeedAuth };

/**
 * Describes a remote data feed that the ingest service polls periodically.
 * Extends the domain-agnostic {@link FeedSourceBase} (id, name, format, auth,
 * cadence, license, etc. — see `@openconditions/ingest-framework`) with the
 * road-specific mapping fields and the still-function-valued transport fields
 * `url`/`body`/`discover` (removed by the L6/L1 declarative-feed work).
 *
 * `url` may be:
 *  - a static string (most feeds)
 *  - a function receiving the runtime env (for feeds needing an API key in the URL)
 *  - a string array (for feeds served as multiple regional files)
 */
export type FeedSource = Omit<FeedSourceBase, "url"> & {
  format: SourceFormat;
  /**
   * The feed's URL(s). Optional when `discover` is set (the URL set is then
   * resolved dynamically at fetch time). When both are present, `discover` wins.
   *
   * The function form may return a single URL or an array — e.g. one
   * client-pull URL per comma-separated Mobilithek subscription id, where each
   * URL must embed a secret from env and so cannot be a static `string[]`.
   */
  url?: string | string[] | ((env: Record<string, string | undefined>) => string | string[]);
  /**
   * Resolves the concrete URL set to fetch at request time (e.g. enumerate
   * every motorway, or pull a feed registry). The ingest service fans the
   * returned URLs out with bounded concurrency and per-URL tolerance, so one
   * failing sub-feed never wipes the source.
   */
  discover?: (fetchFn: typeof fetch) => Promise<string[]>;
  /**
   * A companion DATEX II MeasurementSiteTablePublication that supplies the
   * geometry for measurement sites keyed only by id in the data feed (the NDW
   * layout). The ingest service fetches and caches it, then joins it into the
   * flow parser. Only meaningful for `produces: "flow"` datex2 feeds.
   *
   * Set `gzip: true` when the URL serves a gzip-compressed body (e.g. an
   * `.xml.gz` file). The streaming site-table loader honours this flag and does
   * NOT magic-byte-sniff the response, so a gzipped body without `gzip: true`
   * would stream corrupt bytes into the parser (yielding an empty map).
   */
  siteTable?: { url: string; gzip?: boolean };
  /** Request body for a POST feed. A function so it can embed credentials from env. */
  body?: (env: Record<string, string | undefined>) => string;
  /** Field mapping for `format: "geojson"` feeds (passed to the generic reader). */
  geojson?: GeoJsonMapping;
  /**
   * For `datex2` feeds whose GML `posList` is "lon lat" rather than the WGS84
   * "lat lon" default (e.g. Trafikverket). Passed through to the parser.
   */
  posListLonLat?: boolean;
  bbox?: [number, number, number, number];
  /**
   * Marks a reference-only feed whose records carry OpenLR but no coordinate, so
   * the ingest resolve stage map-matches them via the openlr-resolver service.
   * No current feed sets this: the open feeds we ingest carry coordinates or
   * Alert-C/TMC, not OpenLR (which is largely a commercial-feed scheme). The
   * resolver is ready infrastructure awaiting such a source — see
   * services/openlr-resolver/README.md "Status".
   */
  openlrResolver?: boolean;
};

/**
 * Mobilithek (Germany's National Access Point) brokers DATEX II road-condition
 * data from nearly every state + many cities. They ALL share one organisation
 * machine certificate (mutual TLS) — MOBILITHEK_CERT/KEY — so a new region needs
 * no new credential beyond its subscription id. Each region has its own
 * comma-separated `<…>_SUBSCRIPTION_ID` env var (one id per subscribed offer);
 * we fan out one HTTPS client-pull per id. To add a region: subscribe to its
 * offer(s) on mobilithek.info, set the subscription id(s), and the feed activates.
 *
 * Licenses were clarified per region (2026-07, from the Mobilithek catalog + each
 * publisher's own terms): `dl-de/zero-2-0` (no attribution); `dl-de/by-2-0`,
 * `GeoNutzV` and `CC-BY-4.0` (attribution); `CC-BY-SA-4.0` (attribution + the
 * Mobidrom bundle is ShareAlike — isolated in its own feed so it never folds into
 * a more permissive one).
 */
const MOBILITHEK_CERT_ENV = "MOBILITHEK_CERT";
const MOBILITHEK_KEY_ENV = "MOBILITHEK_KEY";

interface MobilithekRegion {
  id: string;
  name: string;
  /** Comma-separated Mobilithek subscription id(s) — one per subscribed offer. */
  subEnvVar: string;
  attribution: string;
  license: string;
  licenseUrl: string;
  privacyUrl?: string;
}

const GEONUTZV_URL = "https://www.gesetze-im-internet.de/geonutzv/";
const DL_BY_URL = "https://www.govdata.de/dl-de/by-2-0";
const DL_ZERO_URL = "https://www.govdata.de/dl-de/zero-2-0";
const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/";
const CC_BY_SA_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

const MOBILITHEK_REGIONS: MobilithekRegion[] = [
  // NRW — LVZ.NRW state network (the original feed; keeps its `verkehr-nrw-de`
  // source id for DB/provider continuity). Offers: roadworks 648508602333433856
  // + incidents 648512079906336768 (+ optional detours 648509554457178112).
  {
    id: "verkehr-nrw-de",
    name: "LVZ.NRW (Nordrhein-Westfalen) via Mobilithek",
    subEnvVar: "MOBILITHEK_NRW_SUBSCRIPTION_ID",
    attribution: "Landesverkehrszentrale NRW (Straßen.NRW)",
    license: "dl-de/zero-2-0",
    licenseUrl: DL_ZERO_URL,
    privacyUrl: "https://www.strassen.nrw.de/de/datenschutz.html",
  },
  // NRW municipalities — Düsseldorf/dmotion 110000000002056000, Köln 110000000002900004
  // /110000000002899004/110000000003011002, Kreis Unna 930448553981730816 (all dl-de/zero).
  {
    id: "mobilithek-nrw-kommunal",
    name: "NRW municipalities (Düsseldorf, Köln, Kreis Unna) via Mobilithek",
    subEnvVar: "MOBILITHEK_NRW_KOMMUNAL_SUBSCRIPTION_ID",
    attribution: "Städte und Kreise in Nordrhein-Westfalen (via Mobilithek)",
    license: "dl-de/zero-2-0",
    licenseUrl: DL_ZERO_URL,
  },
  // NRW.Mobidrom bundled roadworks 884461110418108416 — CC-BY-SA → isolated.
  {
    id: "mobilithek-nrw-mobidrom",
    name: "NRW.Mobidrom bundled roadworks via Mobilithek",
    subEnvVar: "MOBILITHEK_NRW_MOBIDROM_SUBSCRIPTION_ID",
    attribution: "NRW.Mobidrom",
    license: "CC-BY-SA-4.0",
    licenseUrl: CC_BY_SA_URL,
  },
  // Bayern — Bayerische Straßenbauverwaltung 110000000002506000 + 110000000002507001 (GeoNutzV).
  {
    id: "mobilithek-bayern",
    name: "Bayern via Mobilithek",
    subEnvVar: "MOBILITHEK_BAYERN_SUBSCRIPTION_ID",
    attribution: "Bayerische Straßenbauverwaltung",
    license: "GeoNutzV",
    licenseUrl: GEONUTZV_URL,
  },
  // Baden-Württemberg — Landesmeldestelle (Innenministerium BW) 857127500689977344 (dl-de/by).
  {
    id: "mobilithek-bw",
    name: "Baden-Württemberg via Mobilithek",
    subEnvVar: "MOBILITHEK_BW_SUBSCRIPTION_ID",
    attribution: "Innenministerium Baden-Württemberg (Landesmeldestelle)",
    license: "dl-de/by-2-0",
    licenseUrl: DL_BY_URL,
  },
  // Berlin — SenMVKU 801096621061234688 (dl-de/by).
  {
    id: "mobilithek-berlin",
    name: "Berlin via Mobilithek",
    subEnvVar: "MOBILITHEK_BERLIN_SUBSCRIPTION_ID",
    attribution: "Senatsverwaltung für Mobilität, Verkehr, Klimaschutz und Umwelt Berlin",
    license: "dl-de/by-2-0",
    licenseUrl: DL_BY_URL,
  },
  // Brandenburg — Landesbetrieb Straßenwesen 636547428851101696 (dl-de/by).
  {
    id: "mobilithek-brandenburg",
    name: "Brandenburg via Mobilithek",
    subEnvVar: "MOBILITHEK_BRANDENBURG_SUBSCRIPTION_ID",
    attribution: "Landesbetrieb Straßenwesen Brandenburg",
    license: "dl-de/by-2-0",
    licenseUrl: DL_BY_URL,
  },
  // Bremen — Verkehrsmanagementzentrale Bremen 608390979298140160 (dl-de/by).
  {
    id: "mobilithek-bremen",
    name: "Bremen via Mobilithek",
    subEnvVar: "MOBILITHEK_BREMEN_SUBSCRIPTION_ID",
    attribution: "Verkehrsmanagementzentrale Bremen",
    license: "dl-de/by-2-0",
    licenseUrl: DL_BY_URL,
  },
  // Hamburg — LSBG 110000000003540000 (dl-de/by).
  {
    id: "mobilithek-hamburg",
    name: "Hamburg via Mobilithek",
    subEnvVar: "MOBILITHEK_HAMBURG_SUBSCRIPTION_ID",
    attribution: "Landesbetrieb Straßen, Brücken und Gewässer Hamburg (LSBG)",
    license: "dl-de/by-2-0",
    licenseUrl: DL_BY_URL,
  },
  // Hessen — Hessen Mobil 841292914668498944/862010418143330304 + C-ITS 110000000002716000 (GeoNutzV).
  {
    id: "mobilithek-hessen",
    name: "Hessen via Mobilithek",
    subEnvVar: "MOBILITHEK_HESSEN_SUBSCRIPTION_ID",
    attribution: "Hessen Mobil – Straßen- und Verkehrsmanagement",
    license: "GeoNutzV",
    licenseUrl: GEONUTZV_URL,
  },
  // Mecklenburg-Vorpommern — LSBV M-V 110000000002802000 + 818137060259840000 (GeoNutzV).
  {
    id: "mobilithek-mv",
    name: "Mecklenburg-Vorpommern via Mobilithek",
    subEnvVar: "MOBILITHEK_MV_SUBSCRIPTION_ID",
    attribution: "Landesamt für Straßenbau und Verkehr Mecklenburg-Vorpommern",
    license: "GeoNutzV",
    licenseUrl: GEONUTZV_URL,
  },
  // Niedersachsen — NLStBV 110000000002749000/951153778962972672/656880550985773056
  // + Hannover 633691473746571264 (dl-de/zero).
  {
    id: "mobilithek-niedersachsen",
    name: "Niedersachsen via Mobilithek",
    subEnvVar: "MOBILITHEK_NIEDERSACHSEN_SUBSCRIPTION_ID",
    attribution: "Niedersächsische Landesbehörde für Straßenbau und Verkehr (NLStBV)",
    license: "dl-de/zero-2-0",
    licenseUrl: DL_ZERO_URL,
  },
  // Sachsen — LASuV 608439575154401280 (CC-BY-4.0) + Leipzig 952541268382826496.
  {
    id: "mobilithek-sachsen",
    name: "Sachsen via Mobilithek",
    subEnvVar: "MOBILITHEK_SACHSEN_SUBSCRIPTION_ID",
    attribution: "Landesamt für Straßenbau und Verkehr Sachsen (LASuV)",
    license: "CC-BY-4.0",
    licenseUrl: CC_BY_URL,
  },
  // Sachsen-Anhalt — LSBB 110000000003150000 (dl-de/by).
  {
    id: "mobilithek-sachsen-anhalt",
    name: "Sachsen-Anhalt via Mobilithek",
    subEnvVar: "MOBILITHEK_SACHSEN_ANHALT_SUBSCRIPTION_ID",
    attribution: "Landesstraßenbaubehörde Sachsen-Anhalt",
    license: "dl-de/by-2-0",
    licenseUrl: DL_BY_URL,
  },
  // Schleswig-Holstein — LBV.SH 110000000003237002 + 110000000003387000 (CC-BY-4.0).
  {
    id: "mobilithek-sh",
    name: "Schleswig-Holstein via Mobilithek",
    subEnvVar: "MOBILITHEK_SH_SUBSCRIPTION_ID",
    attribution: "Landesbetrieb Straßenbau und Verkehr Schleswig-Holstein (LBV.SH)",
    license: "CC-BY-4.0",
    licenseUrl: CC_BY_URL,
  },
  // Thüringen — TLBV 110000000003051000 (GeoNutzV).
  {
    id: "mobilithek-thueringen",
    name: "Thüringen via Mobilithek",
    subEnvVar: "MOBILITHEK_THUERINGEN_SUBSCRIPTION_ID",
    attribution: "Thüringer Landesamt für Bau und Verkehr",
    license: "GeoNutzV",
    licenseUrl: GEONUTZV_URL,
  },
];

/**
 * A Mobilithek region → a credential-gated DATEX II client-pull feed. All share
 * the org machine cert; each is activated by setting its subscription-id env var.
 * The URL is the subscription's HTTPS Zugriffspunkt (plain-HTTPS client-pull, NOT
 * the `/soap/` SOAP binding); Mobilithek REQUIRES `Accept-Encoding: gzip` (without
 * it the broker returns HTTP 400) and serves gzipped DATEX II (fetchOne gunzips).
 */
function mobilithekFeed(r: MobilithekRegion): FeedSource {
  return {
    id: r.id,
    name: r.name,
    format: "datex2",
    url: (env) =>
      (env[r.subEnvVar] ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map(
          (id) =>
            `https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/${id}/clientPullService?subscriptionID=${id}`
        ),
    auth: { kind: "mtls", certEnvVar: MOBILITHEK_CERT_ENV, keyEnvVar: MOBILITHEK_KEY_ENV },
    requiredEnv: [r.subEnvVar],
    requestHeaders: { "Accept-Encoding": "gzip" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: r.license,
    licenseUrl: r.licenseUrl,
    attribution: r.attribution,
    country: "DE",
    privacyUrl: r.privacyUrl ?? "https://mobilithek.info/datenschutz",
    enabledByDefault: true,
  };
}

/**
 * All registered feed sources.
 */
export const FEED_SOURCES: FeedSource[] = [
  {
    id: "ndw",
    name: "NDW (Netherlands)",
    format: "datex2",
    url: "http://opendata.ndw.nu/actueel_beeld.xml.gz",
    gzip: true,
    cadenceSec: 60,
    freshnessWindowSec: 300,
    license: "CC0-1.0",
    licenseUrl: "https://www.ndw.nu",
    attribution: "NDW / Rijkswaterstaat",
    country: "NL",
    privacyUrl: "https://www.ndw.nu/privacy",
    enabledByDefault: true,
  },
  {
    id: "drivebc",
    name: "DriveBC (British Columbia)",
    format: "open511",
    url: "https://api.open511.gov.bc.ca/events?format=json",
    cadenceSec: 120,
    freshnessWindowSec: 600,
    license: "OGL-BC",
    attribution:
      "Contains information licensed under the Open Government Licence – British Columbia",
    country: "CA",
    privacyUrl: "https://www2.gov.bc.ca/gov/content/home/privacy",
    enabledByDefault: true,
  },
  {
    id: "digitraffic-fi",
    name: "Digitraffic (Finland)",
    format: "digitraffic-json",
    url: [
      "https://tie.digitraffic.fi/api/traffic-message/v1/messages?inactiveHours=0&includeAreaGeometry=false&situationType=TRAFFIC_ANNOUNCEMENT",
      "https://tie.digitraffic.fi/api/traffic-message/v1/messages?inactiveHours=0&includeAreaGeometry=false&situationType=ROAD_WORK",
    ],
    cadenceSec: 120,
    freshnessWindowSec: 600,
    license: "CC-BY-4.0",
    attribution: "Fintraffic / Digitraffic",
    country: "FI",
    privacyUrl: "https://www.fintraffic.fi/en/fintraffic/data-protection",
    enabledByDefault: true,
  },
  {
    id: "autobahn-de",
    name: "Autobahn GmbH (Germany)",
    format: "autobahn-json",
    discover: discoverAutobahnRoads,
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "dl-de/by-2-0",
    attribution: "Quelle: Die Autobahn GmbH des Bundes",
    country: "DE",
    privacyUrl: "https://www.autobahn.de/datenschutz",
    enabledByDefault: true,
  },
  {
    id: "wzdx",
    name: "WZDx (United States)",
    format: "wzdx",
    discover: discoverWzdxFeeds,
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "WZDx publishers",
    country: "US",
    privacyUrl: "https://www.transportation.gov/privacy",
    enabledByDefault: true,
  },
  {
    // Separate source id from "ndw" (events) so that atomicSwap stays
    // source-id–scoped and the two NDW feeds never clobber each other's rows.
    // The trafficspeed feed carries measurements keyed by site id only; the
    // companion measurement.xml.gz site table supplies each site's geometry.
    id: "ndw-flow",
    name: "NDW traffic speed (Netherlands)",
    format: "datex2",
    produces: "flow",
    url: "https://opendata.ndw.nu/trafficspeed.xml.gz",
    gzip: true,
    siteTable: { url: "https://opendata.ndw.nu/measurement.xml.gz", gzip: true },
    cadenceSec: 60,
    freshnessWindowSec: 300,
    license: "CC0-1.0",
    licenseUrl: "https://www.ndw.nu",
    attribution: "NDW / Rijkswaterstaat",
    country: "NL",
    privacyUrl: "https://www.ndw.nu/privacy",
    enabledByDefault: true,
  },
  {
    // Spain's national DGT incidents feed (DATEX II v3 SituationPublication).
    // Open, no key. Nationwide incidents/closures/roadworks/weather.
    id: "dgt-es",
    name: "DGT (Spain)",
    format: "datex2",
    url: "https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v36.xml",
    cadenceSec: 120,
    freshnessWindowSec: 600,
    license: "CC-BY-4.0",
    licenseUrl: "https://nap.dgt.es",
    attribution: "Dirección General de Tráfico (DGT)",
    country: "ES",
    privacyUrl: "https://www.dgt.es/protecciondedatos/",
    enabledByDefault: true,
  },
  {
    // MobiData BW roadworks (DATEX II v2). Covers Bundes-/Landes-/Kreisstraßen —
    // complements the federal Autobahn feed (which excludes roadworks), so there
    // is no motorway overlap to dedupe. Open (dl-de/by-2-0), no key.
    id: "svzbw-de",
    name: "MobiData BW roadworks (Baden-Württemberg)",
    format: "datex2",
    url: "https://api.mobidata-bw.de/datasets/traffic/roadworks/roadworks_svzbw.datex2.xml",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "dl-de/by-2-0",
    licenseUrl: "https://www.mobidata-bw.de",
    attribution: "MobiData BW / Ministerium für Verkehr Baden-Württemberg (SVZ-BW)",
    country: "DE",
    privacyUrl: "https://www.mobidata-bw.de/pages/datenschutz",
    enabledByDefault: true,
  },
  {
    // France national roads (DIR / Bison Futé). DATEX II v2 incidents, wrapped in
    // a SOAP envelope (unwrapped by the parser). The resource URL is HTTPS and
    // 302-redirects to the upstream file. Open (Licence Ouverte 2.0), no key.
    id: "dir-fr",
    name: "DIR / Bison Futé (France national roads)",
    format: "datex2",
    url: "https://transport.data.gouv.fr/resources/79174/download",
    cadenceSec: 600,
    freshnessWindowSec: 1800,
    license: "etalab-2.0",
    licenseUrl: "https://www.etalab.gouv.fr/licence-ouverte-open-licence",
    attribution: "DIR / Bison Futé",
    country: "FR",
    privacyUrl: "https://www.bison-fute.gouv.fr/",
    enabledByDefault: true,
  },
  {
    // Croatia state-road roadworks (Hrvatske ceste). DATEX II v2, open licence,
    // but the live B2B endpoint is HTTP-Basic gated — set HC_HR_USERNAME /
    // HC_HR_PASSWORD to activate (the scheduler skips it until both are present).
    id: "hc-hr",
    name: "Hrvatske ceste roadworks (Croatia)",
    format: "datex2",
    url: "https://b2b.promet-info.hr/dc/b2b.hc.roadworks.datex",
    auth: { kind: "basic", userEnvVar: "HC_HR_USERNAME", passEnvVar: "HC_HR_PASSWORD" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "OD-HR",
    licenseUrl: "https://data.gov.hr/otvorena-dozvola",
    attribution: "Hrvatske ceste",
    country: "HR",
    privacyUrl: "https://www.hrvatske-ceste.hr/",
    enabledByDefault: true,
  },
  {
    // New Zealand state-highway road events (NZTA Waka Kotahi), served as ArcGIS
    // GeoJSON (WGS84). Open (CC-BY 4.0), no key. Parsed by the generic reader.
    id: "nzta-nz",
    name: "NZTA Road Events (New Zealand)",
    format: "geojson",
    url: "https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::road-events.geojson",
    geojson: {
      idField: "eventId",
      typeField: "eventDescription",
      typeMap: {
        Crash: "accident",
        Breakdown: "broken_down_vehicle",
        Slip: "hazard",
        Maintenance: "roadworks",
        "Pavement Repairs": "roadworks",
        "Bridge Repairs": "roadworks",
        Resurfacing: "roadworks",
        "Road Construction": "roadworks",
        Services: "roadworks",
      },
      defaultType: "other",
      headlineField: "eventDescription",
      descriptionField: "eventComments",
      severityField: "impact",
      severityMap: { "Road Closed": "high", Delays: "medium", Caution: "low" },
      updatedField: "eventModified",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://opendata-nzta.opendata.arcgis.com/",
    attribution: "NZ Transport Agency Waka Kotahi",
    country: "NZ",
    privacyUrl: "https://www.nzta.govt.nz/privacy-policy/",
    enabledByDefault: true,
  },
  {
    // Berlin roadworks + closures (VIZ Berlin), GeoJSON (WGS84), dl-de/by-2-0,
    // no key. City/non-motorway — complements the federal Autobahn feed.
    id: "berlin-de",
    name: "VIZ Berlin roadworks & closures",
    format: "geojson",
    url: "https://api.viz.berlin.de/daten/baustellen_sperrungen_viz.json",
    geojson: {
      idField: "id",
      typeField: "subtype",
      typeMap: {
        Baustelle: "roadworks",
        Bauarbeiten: "roadworks",
        Sperrung: "road_closure",
        Störung: "obstruction",
      },
      defaultType: "other",
      headlineField: "content",
      roadField: "street",
      severityField: "severity",
      severityMap: {
        Vollsperrung: "high",
        Fahrtrichtungssperrung: "medium",
        "keine Sperrung": "low",
      },
      updatedField: "tstore",
    },
    cadenceSec: 600,
    freshnessWindowSec: 1800,
    license: "dl-de/by-2-0",
    licenseUrl: "https://daten.berlin.de/",
    attribution: "Verkehrsinformationszentrale Berlin (VIZ)",
    country: "DE",
    privacyUrl: "https://www.berlin.de/datenschutzerklaerung/",
    enabledByDefault: true,
  },
  {
    // Ontario 511 (iPeloton/IBI511 platform). Open Government Licence – Ontario
    // (commercial OK). The public get/event endpoint is keyless — verified live
    // (HTTP 200, full event set, no key) and the API docs declare no auth.
    id: "on-511",
    name: "Ontario 511 (Canada)",
    format: "ibi511-json",
    url: "https://511on.ca/api/v2/get/event?format=json",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "OGL-ON",
    licenseUrl: "https://www.ontario.ca/page/open-government-licence-ontario",
    attribution: "Contains information licensed under the Open Government Licence – Ontario",
    country: "CA",
    privacyUrl: "https://www.ontario.ca/page/privacy-statement",
    enabledByDefault: true,
  },
  {
    // 511NY (iPeloton/IBI511 platform). Its Developer Access Agreement permits
    // commercial redistribution. Needs a free API key → set NY_511_API_KEY.
    id: "ny-511",
    name: "511NY (New York)",
    format: "ibi511-json",
    url: "https://511ny.org/api/v2/get/event?format=json",
    auth: { kind: "query-key", param: "key", envVar: "NY_511_API_KEY" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "511NY-DAA",
    licenseUrl: "https://511ny.org/developers/daa",
    attribution: "Powered by 511NY",
    country: "US",
    privacyUrl: "https://511ny.org/privacy",
    enabledByDefault: true,
  },
  {
    // Singapore LTA DataMall traffic incidents. Singapore Open Data Licence
    // (commercial OK). header-key auth (AccountKey) → set LTA_ACCOUNT_KEY.
    id: "lta-sg",
    name: "LTA DataMall Traffic Incidents (Singapore)",
    format: "lta-json",
    url: "https://datamall2.mytransport.sg/ltaodataservice/TrafficIncidents",
    auth: { kind: "header-key", header: "AccountKey", envVar: "LTA_ACCOUNT_KEY" },
    cadenceSec: 120,
    freshnessWindowSec: 600,
    license: "Singapore-ODL-1.0",
    licenseUrl: "https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html",
    attribution: "Land Transport Authority (Singapore)",
    country: "SG",
    privacyUrl: "https://www.lta.gov.sg/content/ltagov/en/privacy.html",
    enabledByDefault: true,
  },
  {
    // Québec roadworks (MTQ chantiers), WFS→GeoJSON. Served in EPSG:3857 — the
    // reader reprojects to WGS84. CC-BY 4.0, no key.
    id: "mtq-qc",
    name: "MTQ roadworks (Québec)",
    format: "geojson",
    url: "https://ws.mapserver.transports.gouv.qc.ca/swtq?service=WFS&version=2.0.0&request=GetFeature&typename=ms:chantiers_mtmdet&outputformat=geojson",
    geojson: {
      idField: "identifiant",
      defaultType: "roadworks",
      headlineField: "identificationDesTravaux",
      descriptionField: "descriptionFrancais",
      roadField: "routeAutoroute",
      updatedField: "miseAJour",
    },
    cadenceSec: 600,
    freshnessWindowSec: 1800,
    license: "CC-BY-4.0",
    licenseUrl: "https://www.donneesquebec.ca/",
    attribution: "Ministère des Transports du Québec (MTQ)",
    country: "CA",
    privacyUrl: "https://www.transports.gouv.qc.ca/fr/Pages/confidentialite.aspx",
    enabledByDefault: true,
  },
  {
    // Flanders — Verkeerscentrum Vlaanderen (DATEX II v3). GML geometry is
    // EPSG:31370 (Belgian Lambert 72) → the DATEX parser reprojects to WGS84 via
    // proj4. Open (commercial OK), no key.
    id: "flanders-be",
    name: "Verkeerscentrum Vlaanderen (Flanders)",
    format: "datex2",
    url: "https://www.verkeerscentrum.be/uitwisseling/datex2v3full",
    cadenceSec: 120,
    freshnessWindowSec: 600,
    license: "CC-BY-4.0",
    licenseUrl: "https://www.verkeerscentrum.be/",
    attribution: "Verkeerscentrum Vlaanderen",
    country: "BE",
    privacyUrl: "https://www.verkeerscentrum.be/",
    enabledByDefault: true,
  },
  {
    // Brussels — Bruxelles Mobilité traffic events (OGC API Features → GeoJSON).
    // Geometry is EPSG:3812 (Belgian Lambert 2008, per-geometry crs) → reader
    // reprojects to WGS84 via proj4. CC0, no key.
    id: "brussels-be",
    name: "Bruxelles Mobilité traffic events",
    format: "geojson",
    url: "https://data.mobility.brussels/datasets/v1/traffic/collections/traffic_events/items?f=json&limit=1000",
    geojson: {
      idField: "fid",
      typeField: "datex_codes",
      typeMap: { RWK: "roadworks", EMR: "public_event", ACC: "accident", JAM: "congestion" },
      defaultType: "other",
      headlineField: "consequences_fr",
      roadField: "location_fr",
      severityField: "importance",
      severityMap: { "0": "low", "1": "low", "2": "medium", "3": "high", "4": "critical" },
      updatedField: "last_update",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    licenseUrl: "https://data.mobility.brussels/",
    attribution: "Bruxelles Mobilité / Brussel Mobiliteit",
    country: "BE",
    privacyUrl: "https://mobilite-mobiliteit.brussels/en/privacy",
    enabledByDefault: true,
  },
  {
    // Luxembourg — CITA traffic events (DATEX II v3.6). CC0, no key.
    id: "cita-lu",
    name: "CITA (Luxembourg)",
    format: "datex2",
    url: "https://cita.lu/info_trafic/datex/situationrecord36",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    licenseUrl: "https://data.public.lu/en/datasets/cita-evenements-trafic-en-datex-ii-v3-6/",
    attribution: "CITA (Luxembourg)",
    country: "LU",
    privacyUrl: "https://data.public.lu/en/pages/legal_notice/",
    enabledByDefault: true,
  },
  {
    // Iceland — Vegagerðin road-condition point incidents (GeoServer WFS). The
    // geometry is EPSG:3057 (Icelandic grid) but each feature carries WGS84 X/Y
    // properties, so the reader builds points from those. Open, no key.
    id: "vegagerdin-is",
    name: "Vegagerðin road conditions (Iceland)",
    format: "geojson",
    url: "https://gagnaveita.vegagerdin.is/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=gis:roadconditions_pointincident&outputFormat=application/json",
    geojson: {
      lonField: "X",
      latField: "Y",
      typeField: "DESCRIPTION",
      typeMap: {
        Closed: "road_closure",
        "Road repairs": "roadworks",
        "Uneven road": "road_condition",
        "Flying gravel": "hazard",
        "Animals on the road": "hazard",
        "Holes in road": "road_condition",
        "Total axle weight limit": "dimension_restriction",
      },
      defaultType: "hazard",
      headlineField: "DESCRIPTION",
      updatedField: "CREATIONTIME",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://www.vegagerdin.is/",
    attribution: "Vegagerðin (Icelandic Road and Coastal Administration)",
    country: "IS",
    privacyUrl: "https://www.vegagerdin.is/",
    enabledByDefault: true,
  },
  {
    // Sweden — Trafikverket DATEX II situations (CC0). NOTE: the road incident/
    // roadworks data is NOT in the object API (/v2/data.json has no `Situation`
    // objecttype) — it's the dedicated DATEX II URL endpoint
    // /v2/datex2/{schemaversion}/{namespace}/sit:situation, a plain GET returning
    // DATEX II v3 (con:messageContainer). The Situation data is split into
    // namespaces; we pull the two coordinate-bearing road ones: `roadworks`
    // (roadworks + closures, the bulk) and `accident`. (`trafficmessages` —
    // general warnings — also exists but rejects sit:situation without separate
    // provider approval; `roadSurfaceConditions`/`frostdamage` are Alert-C only.)
    // Auth = the key as `?authenticationkey=`. Trafikverket publishes posList in
    // lon-lat order → posListLonLat. Replaces the old POST object-query feed.
    id: "trafikverket-se",
    name: "Trafikverket (Sweden)",
    format: "datex2",
    url: [
      "https://api.trafikinfo.trafikverket.se/v2/datex2/3.1/roadworks/sit:situation",
      "https://api.trafikinfo.trafikverket.se/v2/datex2/3.1/accident/sit:situation",
    ],
    auth: { kind: "query-key", param: "authenticationkey", envVar: "TRAFIKVERKET_API_KEY" },
    posListLonLat: true,
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    licenseUrl: "https://data.trafikverket.se/",
    attribution: "Trafikverket",
    country: "SE",
    privacyUrl: "https://www.trafikverket.se/integritetspolicy/",
    enabledByDefault: true,
  },
  {
    // Slovenia — NAP/NCUP DATEX II (DARS + DRSI), served from the B2B host
    // b2b.ncup.si. Two DATEX II v3.3 datasets merged under one source: Traffic
    // events (b2b.events.datexii33) + Roadworks (b2b.roadworks.datexii33) — the
    // two "Other contents" records to request on nap.si. CC-BY-SA (commercial
    // OK; ShareAlike applies to re-emitted data). The B2B host is credential-
    // gated (HTTP 403 without auth); access comes with the NAP account → set
    // NAP_SI_USERNAME / NAP_SI_PASSWORD (HTTP Basic). Confirm the exact scheme
    // against the B2B access instructions when access is granted.
    id: "nap-si",
    name: "NAP Slovenia (promet.si)",
    format: "datex2",
    url: [
      "https://b2b.ncup.si/data/b2b.events.datexii33",
      "https://b2b.ncup.si/data/b2b.roadworks.datexii33",
    ],
    auth: { kind: "basic", userEnvVar: "NAP_SI_USERNAME", passEnvVar: "NAP_SI_PASSWORD" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-SA-4.0",
    licenseUrl: "https://nap.si/",
    attribution: "DARS / DRSI (NAP Slovenia)",
    country: "SI",
    privacyUrl: "https://nap.si/",
    enabledByDefault: true,
  },
  {
    // Norway — Statens vegvesen DATEX II v3 (nationwide). NLOD (commercial OK).
    // Endpoint confirmed live (HTTP 401 without auth); free account → Basic auth.
    // Set NO_VEGVESEN_USERNAME / NO_VEGVESEN_PASSWORD to activate.
    id: "vegvesen-no",
    name: "Statens vegvesen (Norway)",
    format: "datex2",
    url: "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullSnapshotData",
    auth: { kind: "basic", userEnvVar: "NO_VEGVESEN_USERNAME", passEnvVar: "NO_VEGVESEN_PASSWORD" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "NLOD-2.0",
    licenseUrl: "https://data.norge.no/nlod/en/2.0",
    attribution: "Statens vegvesen",
    country: "NO",
    privacyUrl:
      "https://www.vegvesen.no/en/about-us/about-the-norwegian-public-roads-administration/privacy/",
    enabledByDefault: true,
  },
  {
    // New South Wales — Live Traffic Hazards (TfNSW Open Data), GeoJSON across
    // the hazard categories. CC-BY (commercial OK). Needs a free API key sent as
    // `Authorization: apikey <key>` → set NSW_TRANSPORT_API_KEY. Mapping is
    // best-effort from the docs; verify field names against a live response.
    id: "livetraffic-nsw",
    name: "Live Traffic NSW (New South Wales)",
    format: "geojson",
    url: [
      "https://api.transport.nsw.gov.au/v1/live/hazards/incident/open",
      "https://api.transport.nsw.gov.au/v1/live/hazards/roadwork/open",
      "https://api.transport.nsw.gov.au/v1/live/hazards/flood/open",
      "https://api.transport.nsw.gov.au/v1/live/hazards/fire/open",
      "https://api.transport.nsw.gov.au/v1/live/hazards/majorevent/open",
      "https://api.transport.nsw.gov.au/v1/live/hazards/alpine/open",
    ],
    auth: {
      kind: "header-key",
      header: "Authorization",
      envVar: "NSW_TRANSPORT_API_KEY",
      valuePrefix: "apikey ",
    },
    geojson: {
      typeField: "mainCategory",
      typeMap: {
        Incident: "accident",
        "Road Work": "roadworks",
        Flooding: "weather",
        Fire: "hazard",
        "Major Event": "public_event",
        Alpine: "weather",
      },
      defaultType: "other",
      headlineField: "headline",
      descriptionField: "otherAdvice",
    },
    cadenceSec: 180,
    freshnessWindowSec: 600,
    license: "CC-BY-4.0",
    licenseUrl: "https://opendata.transport.nsw.gov.au/dataset/live-traffic-hazards",
    attribution: "Transport for NSW",
    country: "AU",
    privacyUrl: "https://www.transport.nsw.gov.au/privacy-statement",
    enabledByDefault: true,
  },
  {
    // South Australia — Traffic SA roadworks/incidents (ArcGIS MapServer, both
    // layers). f=geojson returns WGS84. CC-BY, no key.
    id: "trafficsa-au",
    name: "Traffic SA (South Australia)",
    format: "geojson",
    url: [
      "https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/0/query?where=1%3D1&outFields=*&f=geojson",
      "https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/1/query?where=1%3D1&outFields=*&f=geojson",
    ],
    geojson: {
      idField: "ROADWORKS_AND_INCIDENTS_ID",
      typeField: "REC_TYPE",
      typeMap: {
        ROADWORKS: "roadworks",
        "24HR ROADWORKS": "roadworks",
        "EMERGENCY WATERWORKS": "roadworks",
        "SIGNAL FAULT": "equipment_fault",
        INCIDENT: "obstruction",
        COLLISION: "accident",
        CRASH: "accident",
        FLOODING: "weather",
        EVENT: "public_event",
        "ROAD CLOSURE": "road_closure",
        HAZARD: "hazard",
      },
      defaultType: "other",
      headlineField: "DESCRIPTION",
      roadField: "ROAD_NO",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://data.sa.gov.au/data/dataset/roadworks-and-incidents-real-time-information",
    attribution: "Department for Infrastructure and Transport (South Australia)",
    country: "AU",
    privacyUrl: "https://www.dit.sa.gov.au/footer/privacy",
    enabledByDefault: true,
  },
  {
    // Queensland QLDTraffic — statewide hazards/crashes/congestion/flooding/
    // roadworks/special events as GeoJSON (CC-BY 4.0, commercial OK). Mapped from
    // the official API spec v1.10. The /v1/events endpoint is used deliberately:
    // each feature's geometry is a GeometryCollection of LineString/Point road
    // segments, while /v2/events additionally appends an area-alert geometry as
    // the last member when area_alert=true — which the generic reader cannot
    // separate from the road geometry, so v1 keeps the geometry clean.
    // Ships the published public API key as the default (shared + globally rate-
    // limited to 100 req/min); set QLD_TRAFFIC_API_KEY to override with a
    // registered key and avoid the shared quota.
    id: "qld-traffic",
    name: "QLDTraffic (Queensland)",
    format: "geojson",
    url: "https://api.qldtraffic.qld.gov.au/v1/events",
    auth: {
      kind: "query-key",
      param: "apikey",
      envVar: "QLD_TRAFFIC_API_KEY",
      defaultValue: "3e83add325cbb69ac4d8e5bf433d770b",
    },
    geojson: {
      idField: "id",
      typeField: "event_type",
      // event_type is a fixed enum in the spec (§4.3): exactly these six values.
      typeMap: {
        Hazard: "hazard",
        Crash: "accident",
        Congestion: "congestion",
        Roadworks: "roadworks",
        "Special event": "public_event",
        Flooding: "weather",
      },
      defaultType: "other",
      headlineField: "description",
      descriptionField: "information",
      roadField: "road_summary.road_name",
      // event_priority (§4.3): Red Alert | High | Medium | Low.
      severityField: "event_priority",
      severityMap: { "Red Alert": "critical", High: "high", Medium: "medium", Low: "low" },
      updatedField: "last_updated",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://www.qldtraffic.qld.gov.au/",
    attribution: "State of Queensland (Department of Transport and Main Roads)",
    country: "AU",
    privacyUrl: "https://www.qld.gov.au/legal/privacy",
    enabledByDefault: true,
  },
  {
    // Buenos Aires — road closures ("cortes de tránsito"), GeoJSON via the city
    // transit API. CC-BY-2.5-AR. Auth is client_id + client_secret query params
    // (a url function injects them from env); gated via requiredEnv. Geometry
    // comes straight from the features; verify the property field names when keyed.
    id: "ba-cortes-ar",
    name: "Buenos Aires road closures (cortes)",
    format: "geojson",
    url: (env) =>
      `https://apitransporte.buenosaires.gob.ar/transito/v1/cortes?client_id=${env["BA_CLIENT_ID"] ?? ""}&client_secret=${env["BA_CLIENT_SECRET"] ?? ""}`,
    requiredEnv: ["BA_CLIENT_ID", "BA_CLIENT_SECRET"],
    geojson: {
      defaultType: "road_closure",
      headlineField: "nombre",
      descriptionField: "descripcion",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-2.5-AR",
    licenseUrl: "https://data.buenosaires.gob.ar/",
    attribution: "Gobierno de la Ciudad de Buenos Aires",
    country: "AR",
    privacyUrl: "https://www.buenosaires.gob.ar/politicas-de-privacidad",
    enabledByDefault: true,
  },
  {
    // Thailand — Longdo / iTIC traffic events (flat JSON array). CC-BY, no key.
    // Parsed by the generic flat-JSON reader (point from lon/lat fields). type
    // codes are numeric — only 3=accident confirmed; verify the rest.
    id: "longdo-th",
    name: "Longdo Traffic Events (Thailand)",
    format: "flatjson",
    url: "https://event.longdo.com/feed/json",
    geojson: {
      lonField: "longitude",
      latField: "latitude",
      idField: "eid",
      typeField: "type",
      typeMap: { "3": "accident" },
      defaultType: "other",
      headlineField: "title_en",
      descriptionField: "description_en",
      updatedField: "start",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://www.longdo.com/",
    attribution: "Longdo Traffic / iTIC Foundation",
    country: "TH",
    privacyUrl: "https://map.longdo.com/",
    enabledByDefault: true,
  },
  {
    // Poland GDDKiA road obstructions (utrudnienia). Proprietary XML, WGS84
    // points, CC0 — no key. Use the canonical `www.archiwum` host: the bare
    // `archiwum.gddkia.gov.pl` 301/302-redirects (via an http hop) to it, which
    // the bare host's flaky DNS made unreliable. The feed is year-round despite
    // the `zima_html` (winter) path.
    id: "gddkia-pl",
    name: "GDDKiA road obstructions (Poland)",
    format: "gddkia-xml",
    url: "https://www.archiwum.gddkia.gov.pl/dane/zima_html/utrdane.xml",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    licenseUrl: "https://dane.gov.pl/",
    attribution: "GDDKiA",
    country: "PL",
    privacyUrl: "https://www.gov.pl/web/gddkia",
    enabledByDefault: true,
  },
  {
    // England — National Highways NTIS "Road and Lane Closures" v2.0 DATEX II
    // (since 2025 it also publishes closures from unplanned events). OGL-UK-3.0
    // (commercial OK). Subscribe free to the "unlimited" product on the developer
    // portal (one product grants the APIM key for all NTIS DATEX feeds) → the
    // Ocp-Apim-Subscription-Key shown in your profile goes in NH_API_KEY. Host +
    // header are the standard NTIS APIM ones; confirm the exact closures path
    // against the subscription's Postman collection when keyed.
    id: "nationalhighways-gb",
    name: "National Highways NTIS (England)",
    format: "datex2",
    url: "https://api.data.nationalhighways.co.uk/roads/v2.0/closures",
    auth: { kind: "header-key", header: "Ocp-Apim-Subscription-Key", envVar: "NH_API_KEY" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "OGL-UK-3.0",
    licenseUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution: "Contains National Highways data © Crown copyright and database right",
    country: "GB",
    privacyUrl: "https://nationalhighways.co.uk/privacy-notice/",
    enabledByDefault: true,
  },
  {
    // Denmark — Vejdirektoratet "Traffic Events and Road Works" DATEX II, served
    // through the national data exchanger (NAP). CC-BY-4.0 (commercial OK). Free
    // API key from nap.vd.dk → set DK_VD_API_KEY. Subscribe to the SNAPSHOT
    // dataset (#416, du-portal-ui.dataudveksler.app.vd.dk/data/416/overview): one
    // DATEX II XML file with all current events + roadworks, refreshed every
    // 10 min — NOT the "changes" dataset (#415), which is AMQP-only and can't be
    // HTTP-polled. The base host is the NAP data service; replace this URL with
    // the snapshot file URL issued on subscription and confirm whether the key is
    // a query param or header (set gzip:true if the file is served gzipped).
    id: "vejdirektoratet-dk",
    name: "Vejdirektoratet (Denmark)",
    format: "datex2",
    url: "https://data.vd-nap.dk/api/datex2/traffic-events",
    auth: { kind: "query-key", param: "api-key", envVar: "DK_VD_API_KEY" },
    // Snapshot refreshes every 10 min upstream; no point polling faster.
    cadenceSec: 600,
    freshnessWindowSec: 1800,
    license: "CC-BY-4.0",
    licenseUrl: "https://nap.vd.dk/",
    attribution: "Vejdirektoratet (Danish Road Directorate)",
    country: "DK",
    privacyUrl: "https://www.vejdirektoratet.dk/",
    enabledByDefault: true,
  },
  {
    // Austria — ASFINAG traffic messages (DATEX II), published via Mobilitydata
    // Austria / the ASFINAG content portal. CC-BY-4.0 (commercial OK). Subscribe
    // to BOTH event records for full coverage — the parser merges them under one
    // source: "Verkehrsmeldungen zu ungeplanten und sicherheitsrelevanten
    // Ereignissen" (unplanned/safety: accidents, closures, hazards) AND
    // "Verkehrsmeldungen zu geplanten Ereignissen" (planned: roadworks, planned
    // closures), which the unplanned feed excludes. (The Reisezeiten travel-time
    // record is flow data for a future flow feed, not events.) Register at
    // contentportal.asfinag.at → set AT_ASFINAG_USERNAME / AT_ASFINAG_PASSWORD
    // (HTTP Basic). Replace these URLs with the issued resource URLs when keyed.
    id: "asfinag-at",
    name: "ASFINAG events (Austria)",
    format: "datex2",
    url: [
      "https://contentportal.asfinag.at/datex2/v3/unplanned-events",
      "https://contentportal.asfinag.at/datex2/v3/planned-events",
    ],
    auth: { kind: "basic", userEnvVar: "AT_ASFINAG_USERNAME", passEnvVar: "AT_ASFINAG_PASSWORD" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://www.mobilitydata.gv.at/en/data",
    attribution: "ASFINAG",
    country: "AT",
    privacyUrl: "https://www.asfinag.at/datenschutz/",
    enabledByDefault: true,
  },
  {
    // Estonia — Transpordiamet "Tark Tee" (Smart Road) DATEX II gateway (traffic
    // safety + restriction datasets). Estonian open data, CC-BY-4.0 (commercial
    // OK). Register for the DATEX II API at tarktee.transpordiamet.ee (the old
    // tarktee.mnt.ee domain is retired) → set EE_TARKTEE_API_KEY. Confirm the
    // exact dataset path and auth param when keyed.
    id: "tarktee-ee",
    name: "Tark Tee (Estonia)",
    format: "datex2",
    url: "https://tarktee.transpordiamet.ee/api/datex2/situation",
    auth: { kind: "query-key", param: "apiKey", envVar: "EE_TARKTEE_API_KEY" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://andmed.eesti.ee/information-holders/transpordiamet",
    attribution: "Transpordiamet (Estonian Transport Administration)",
    country: "EE",
    privacyUrl: "https://www.transpordiamet.ee/en",
    enabledByDefault: true,
  },
  // Germany via Mobilithek — one credential-gated DATEX II client-pull feed per
  // region (states + city bundles), all sharing the org machine cert. See
  // MOBILITHEK_REGIONS above for the per-region subscription-id env vars, offers,
  // attribution and licenses. `verkehr-nrw-de` (LVZ.NRW) is the first row; the
  // rest stay dormant until their `MOBILITHEK_<REGION>_SUBSCRIPTION_ID` is set.
  ...MOBILITHEK_REGIONS.map(mobilithekFeed),
];

type ParserFn = typeof parseDatexSituations;
type FlowParserFn = (
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>
) => FlowParseResult;

/**
 * Returns the parser function for a given source format.
 * Throws for any format not yet supported.
 */
export function parserFor(format: SourceFormat): ParserFn {
  if (format === "datex2") return parseDatexSituations;
  if (format === "open511") return parseOpen511;
  if (format === "wzdx") return parseWzdx;
  if (format === "geojson") return parseGeoJson;
  if (format === "ibi511-json") return parseIbi511 as ParserFn;
  if (format === "lta-json") return parseLtaIncidents as ParserFn;
  if (format === "gddkia-xml") return parseGddkia;
  if (format === "flatjson") return parseFlatJson as ParserFn;
  if (format === "trafikverket-json") return parseTrafikverket as ParserFn;
  if (format === "autobahn-json") return parseAutobahn;
  if (format === "digitraffic-json") return parseDigitraffic;
  throw new Error(`No parser registered for format: ${format}`);
}

/**
 * Returns the flow parser function for a given source format.
 * Throws when no flow parser is registered for the format.
 */
export function flowParserFor(format: SourceFormat): FlowParserFn {
  if (format === "digitraffic-json") return parseDigitrafficFlow;
  if (format === "datex2") return parseDatexMeasuredData;
  throw new Error(`No flow parser registered for format: ${format}`);
}

/**
 * Maps a FeedSource to the minimal SourceDescriptor that parsers receive at
 * call time. Keeps parsers decoupled from the full feed registry shape.
 */
export function feedToSourceDescriptor(feed: FeedSource): SourceDescriptor {
  return {
    id: feed.id,
    attribution: feed.attribution,
    country: feed.country,
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    ...(feed.geojson ? { geojson: feed.geojson } : {}),
    ...(feed.posListLonLat ? { posListLonLat: true } : {}),
  };
}
