import type { SourceFormat } from "@openconditions/core";
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
    }
  /**
   * Mutual TLS (client certificate). For broker feeds that authenticate with an
   * organisation machine certificate — notably Germany's Mobilithek (Straßen.NRW,
   * Bavaria, Saxony). The env vars hold the PEM contents of the client certificate
   * and its private key (plus an optional CA chain).
   */
  | { kind: "mtls"; certEnvVar: string; keyEnvVar: string; caEnvVar?: string };

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
  /** HTTP method — default GET. Set "POST" for query-style APIs (e.g. Sweden Trafikverket). */
  method?: "GET" | "POST";
  /** Request body for a POST feed. A function so it can embed credentials from env. */
  body?: (env: Record<string, string | undefined>) => string;
  /** Extra request headers (e.g. a Content-Type for the POST body). */
  requestHeaders?: Record<string, string>;
  /**
   * Env vars the feed needs that the `auth` config doesn't cover (e.g. an API key
   * embedded in `body`). The scheduler gates on these in addition to `auth`.
   */
  requiredEnv?: string[];
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
    // Sweden — Trafikverket "Situation" API (POST JSON query; CC0). The API key
    // is embedded in the XML request body, so it's gated via requiredEnv (set
    // TRAFIKVERKET_API_KEY). Built from the documented schema; verify against a
    // live keyed response.
    id: "trafikverket-se",
    name: "Trafikverket (Sweden)",
    format: "trafikverket-json",
    url: "https://api.trafikinfo.trafikverket.se/v2/data.json",
    method: "POST",
    requestHeaders: { "Content-Type": "text/xml" },
    body: (env) =>
      `<REQUEST><LOGIN authenticationkey="${env["TRAFIKVERKET_API_KEY"] ?? ""}"/>` +
      `<QUERY objecttype="Situation" schemaversion="1.5" limit="1000"><FILTER/></QUERY></REQUEST>`,
    requiredEnv: ["TRAFIKVERKET_API_KEY"],
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    licenseUrl: "https://api.trafikinfo.trafikverket.se/",
    attribution: "Trafikverket",
    country: "SE",
    privacyUrl: "https://www.trafikverket.se/integritetspolicy/",
    enabledByDefault: true,
  },
  {
    // Slovenia — NAP/NCUP DATEX II (DARS + DRSI). Endpoint confirmed live
    // (HTTP 403 without auth). CC-BY-SA (commercial OK; ShareAlike applies to
    // re-emitted data). Auth is credential-gated — research indicates OAuth2;
    // verify the exact scheme/token URL when access is granted. Scaffolded with
    // Basic as a placeholder; set NAP_SI_USERNAME / NAP_SI_PASSWORD (or switch
    // this `auth` to oauth2-client-credentials once the token URL is known).
    id: "nap-si",
    name: "NAP Slovenia (promet.si)",
    format: "datex2",
    url: "https://b2b.nap.si/data/b2b.datex2.xml",
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
  {
    // England — National Highways NTIS "Road and Lane Closures" v2.0 DATEX II
    // (since 2025 it also publishes closures from unplanned events). OGL-UK-3.0
    // (commercial OK). Subscribe free on the developer portal for an APIM
    // subscription key → set NH_API_KEY. Host + Ocp-Apim-Subscription-Key header
    // are the standard NTIS APIM ones; confirm the exact product path against the
    // subscription's Postman collection when keyed.
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
    // Denmark — Vejdirektoratet "Traffic Events and Roadworks" DATEX II, served
    // through the national data exchanger. CC-BY-4.0 (commercial OK). Free API key
    // from nap.vd.dk → set DK_VD_API_KEY. The base host is the NAP data service;
    // confirm the exact feed path and whether the key is a query param or header
    // when keyed.
    id: "vejdirektoratet-dk",
    name: "Vejdirektoratet (Denmark)",
    format: "datex2",
    url: "https://data.vd-nap.dk/api/datex2/traffic-events",
    auth: { kind: "query-key", param: "api-key", envVar: "DK_VD_API_KEY" },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC-BY-4.0",
    licenseUrl: "https://nap.vd.dk/",
    attribution: "Vejdirektoratet (Danish Road Directorate)",
    country: "DK",
    privacyUrl: "https://www.vejdirektoratet.dk/",
    enabledByDefault: true,
  },
  {
    // Austria — ASFINAG "Verkehrsmeldungen zu ungeplanten und sicherheitsrelevanten
    // Ereignissen" (unplanned/safety events) DATEX II, published via Mobilitydata
    // Austria. CC-BY-4.0 (commercial OK). Register at contentportal.asfinag.at →
    // set AT_ASFINAG_USERNAME / AT_ASFINAG_PASSWORD (the ASFINAG content portal
    // uses HTTP Basic). Confirm the exact resource URL and auth scheme when keyed.
    id: "asfinag-at",
    name: "ASFINAG events (Austria)",
    format: "datex2",
    url: "https://contentportal.asfinag.at/datex2/v3/unplanned-events",
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
    // OK). Register at tarktee.mnt.ee for an API key → set EE_TARKTEE_API_KEY.
    // Confirm the exact dataset path and auth param when keyed.
    id: "tarktee-ee",
    name: "Tark Tee (Estonia)",
    format: "datex2",
    url: "https://tarktee.mnt.ee/api/datex2/situation",
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
  {
    // Taiwan — TDX (Transport Data eXchange) road traffic live news. OGDL
    // (政府資料開放授權條款, commercial OK). OAuth2 client-credentials — register at
    // tdx.transportdata.tw, set TDX_CLIENT_ID / TDX_CLIENT_SECRET. The highway
    // live-news object wraps records under "Newses" with WGS84 PositionLon/
    // PositionLat. Verify the array path + field names against a live token; if the
    // News object lacks coordinates, point this at a section/VD endpoint that
    // carries PositionLat/Lon.
    id: "tdx-tw",
    name: "TDX road traffic (Taiwan)",
    format: "flatjson",
    url: "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/News/Highway?%24format=JSON",
    auth: {
      kind: "oauth2-client-credentials",
      tokenUrl: "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token",
      clientIdEnvVar: "TDX_CLIENT_ID",
      clientSecretEnvVar: "TDX_CLIENT_SECRET",
    },
    geojson: {
      arrayPath: "Newses",
      lonField: "PositionLon",
      latField: "PositionLat",
      idField: "NewsID",
      headlineField: "Title",
      descriptionField: "Description",
      updatedField: "UpdateTime",
      defaultType: "other",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "OGDL-TW-1.0",
    licenseUrl: "https://data.gov.tw/license",
    attribution: "Ministry of Transportation and Communications (TDX), Taiwan",
    country: "TW",
    privacyUrl: "https://tdx.transportdata.tw/",
    enabledByDefault: true,
  },
  {
    // South Korea — National ITS Center event API (its.go.kr open data). KOGL
    // Type 1 (commercial OK with attribution). Free service key from its.go.kr →
    // set KR_ITS_API_KEY. Events carry WGS84 coordX/coordY (lon/lat) under
    // body.items. Verify the array path + field names against a live key.
    id: "its-kr",
    name: "National ITS events (South Korea)",
    format: "flatjson",
    url: "https://openapi.its.go.kr/api/NEvent?type=all&eventType=all&getType=json",
    auth: { kind: "query-key", param: "apiKey", envVar: "KR_ITS_API_KEY" },
    geojson: {
      arrayPath: "body.items",
      lonField: "coordX",
      latField: "coordY",
      idField: "linkId",
      typeField: "eventType",
      headlineField: "message",
      updatedField: "startDate",
      defaultType: "other",
    },
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "KOGL-Type-1",
    licenseUrl: "https://www.kogl.or.kr/info/license.do",
    attribution: "National Transport Information Center (ITS), Republic of Korea",
    country: "KR",
    privacyUrl: "https://www.its.go.kr/",
    enabledByDefault: true,
  },
  {
    // Germany (NRW) — Straßen.NRW DATEX II via the Mobilithek broker (the user's
    // original verkehr.nrw ask). dl-de/zero-2-0 (fully commercial-OK). Mobilithek
    // authenticates with an organisation machine certificate (mutual TLS): register
    // an org on mobilithek.info, obtain the client cert, set MOBILITHEK_NRW_CERT /
    // MOBILITHEK_NRW_KEY (PEM contents) + the issued subscription id. Covers NRW
    // non-motorway + municipal roads (overlaps Autobahn → relies on cross-source
    // dedup). Confirm the exact pull URL + whether the broker needs a SOAP subscribe
    // vs a plain client-pull GET against the issued subscription when the cert lands.
    id: "verkehr-nrw-de",
    name: "Straßen.NRW via Mobilithek (Germany)",
    format: "datex2",
    url: (env) =>
      `https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/${env["MOBILITHEK_NRW_SUBSCRIPTION_ID"] ?? ""}/clientPullService/DatexPull`,
    auth: { kind: "mtls", certEnvVar: "MOBILITHEK_NRW_CERT", keyEnvVar: "MOBILITHEK_NRW_KEY" },
    requiredEnv: ["MOBILITHEK_NRW_SUBSCRIPTION_ID"],
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "dl-de/zero-2-0",
    licenseUrl: "https://www.govdata.de/dl-de/zero-2-0",
    attribution: "Straßen.NRW / Land Nordrhein-Westfalen",
    country: "DE",
    privacyUrl: "https://www.strassen.nrw.de/de/datenschutz.html",
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
  };
}
