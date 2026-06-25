import type { SourceFormat } from "@openconditions/core";
import type { GeoJsonMapping } from "./model.js";
import type { SiteGeometry } from "./siteTable.js";
import { parseDatexSituations } from "./datex.js";
import { parseGeoJson } from "./geojson.js";
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

/**
 * How a feed authenticates. A discriminated union so each kind carries exactly
 * the env-var names it needs and nothing more. Secrets live only in env.
 */
export type FeedAuth =
  | { kind: "none" }
  /** Append `?<param>=<secret>` to the request URL (e.g. iPeloton 511 `key=`). */
  | { kind: "query-key"; param: string; envVar: string }
  /** Send the secret in a request header (optionally with a value prefix). */
  | { kind: "header-key"; header: string; envVar: string; valuePrefix?: string }
  /** HTTP Basic auth from a username + password pair. */
  | { kind: "basic"; userEnvVar: string; passEnvVar: string }
  /** Static `Authorization: Bearer <secret>`. */
  | { kind: "bearer"; envVar: string }
  /**
   * OAuth2 client-credentials grant: POST to `tokenUrl`, cache the access token
   * until it expires, send it as `Authorization: Bearer`. (Slovenia, Taiwan TDX,
   * Buenos Aires.)
   */
  | {
      kind: "oauth2-client-credentials";
      tokenUrl: string;
      clientIdEnvVar: string;
      clientSecretEnvVar: string;
      scope?: string;
    };

/**
 * Describes a remote data feed that the ingest service polls periodically.
 *
 * `url` may be:
 *  - a static string (most feeds)
 *  - a function receiving the runtime env (for feeds needing an API key in the URL)
 *  - a string array (for feeds served as multiple regional files)
 */
export interface FeedSource {
  id: string;
  name: string;
  format: SourceFormat;
  /**
   * Declares what this feed produces:
   *   "events" (default) — the parser returns Observation[] directly (RoadEvent etc.)
   *   "flow"             — the parser returns FlowParseResult; both the RoadFlow
   *                        measurements and the derived congestion RoadEvents are
   *                        flattened into the pipeline's Observation[] output.
   *
   * Each flow feed must carry its own unique `id` so atomicSwap (which is
   * source-id–scoped) never collides with an event feed from the same provider.
   */
  produces?: "events" | "flow";
  /**
   * The feed's URL(s). Optional when `discover` is set (the URL set is then
   * resolved dynamically at fetch time). When both are present, `discover` wins.
   */
  url?: string | ((env: Record<string, string | undefined>) => string) | string[];
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
  /**
   * How to authenticate requests to this feed. Secrets are never inlined — every
   * variant names the env var(s) that hold them, so a feed can be committed
   * openly and activated by supplying credentials at deploy time. The ingest
   * service applies these (see `pipeline/auth.ts`) and skips a feed whose
   * required env vars are absent. Omit (or `none`) for open, keyless feeds.
   */
  auth?: FeedAuth;
  /** Field mapping for `format: "geojson"` feeds (passed to the generic reader). */
  geojson?: GeoJsonMapping;
  bbox?: [number, number, number, number];
  cadenceSec: number;
  freshnessWindowSec: number;
  gzip?: boolean;
  /**
   * Marks a reference-only feed whose records carry OpenLR but no coordinate, so
   * the ingest resolve stage map-matches them via the openlr-resolver service.
   * No current feed sets this: the open feeds we ingest carry coordinates or
   * Alert-C/TMC, not OpenLR (which is largely a commercial-feed scheme). The
   * resolver is ready infrastructure awaiting such a source — see
   * services/openlr-resolver/README.md "Status".
   */
  openlrResolver?: boolean;
  license: string;
  licenseUrl?: string;
  attribution: string;
  country: string;
  privacyUrl: string;
  enabledByDefault: boolean;
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
    // (commercial OK). Needs a free API key → set ON_511_API_KEY to activate.
    id: "on-511",
    name: "Ontario 511 (Canada)",
    format: "ibi511-json",
    url: "https://511on.ca/api/v2/get/event?format=json",
    auth: { kind: "query-key", param: "key", envVar: "ON_511_API_KEY" },
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
    // Queensland QLDTraffic — statewide hazards/crashes/congestion/flooding/
    // roadworks as GeoJSON. CC-BY 4.0 (commercial OK). Needs a free API key →
    // set QLD_TRAFFIC_API_KEY. Mapping is best-effort from the documented schema;
    // verify field names against a live response once the key is available.
    id: "qld-traffic",
    name: "QLDTraffic (Queensland)",
    format: "geojson",
    url: "https://api.qldtraffic.qld.gov.au/v2/events",
    auth: { kind: "query-key", param: "apikey", envVar: "QLD_TRAFFIC_API_KEY" },
    geojson: {
      idField: "id",
      typeField: "event_type",
      typeMap: {
        Crash: "accident",
        Hazard: "hazard",
        Congestion: "congestion",
        Flooding: "weather",
        Roadworks: "roadworks",
        "Special Event": "public_event",
      },
      defaultType: "other",
      headlineField: "description",
      descriptionField: "description",
      roadField: "road_summary.road_name",
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
    // Poland GDDKiA road obstructions (utrudnienia). Proprietary XML, WGS84
    // points, CC0 — no key.
    id: "gddkia-pl",
    name: "GDDKiA road obstructions (Poland)",
    format: "gddkia-xml",
    url: "https://archiwum.gddkia.gov.pl/dane/zima_html/utrdane.xml",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    licenseUrl: "https://dane.gov.pl/",
    attribution: "GDDKiA",
    country: "PL",
    privacyUrl: "https://www.gov.pl/web/gddkia",
    enabledByDefault: true,
  },
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
  };
}
