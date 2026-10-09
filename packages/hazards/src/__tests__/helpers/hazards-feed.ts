import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FeedDefinition,
  type ParseContext,
  type Region,
  readCatalogDir,
  regionFileSchema,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { hazardsDomain } from "../../domain.js";
import { type HazardsCatalogFeed, hazardsFeedShape } from "../../feed-schema.js";

const FEEDS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "feeds");

let catalogue: Map<string, HazardsCatalogFeed> | undefined;

/**
 * Every feed of `feeds/hazards/`, disabled ones included, derived as the
 * loader derives it; empty while the catalogue has no hazards feeds.
 */
export function hazardsCatalogue(): ReadonlyMap<string, HazardsCatalogFeed> {
  catalogue ??= new Map(
    readCatalogDir(FEEDS_DIR, [hazardsDomain], { otherDomains: "ignore" }).files.flatMap((file) =>
      file.feeds.map((definition) => {
        const feed = toCatalogFeed(definition, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }) as HazardsCatalogFeed;
        return [feed.id, feed] as const;
      }),
    ),
  );
  return catalogue;
}

/** One hazards feed as its region file writes it. */
export function catalogFeed(id: string): HazardsCatalogFeed {
  const feed = hazardsCatalogue().get(id);
  if (feed === undefined) throw new Error(`no feed ${id} in feeds/hazards`);
  return structuredClone(feed);
}

/**
 * A hazards feed written as a region file would write it, checked against
 * the hazards feed shape and the domain's lint, and derived as the loader
 * derives it: what the parser tests run on before the catalogue carries the
 * feed.
 */
export function hazardFeed(
  region: Region,
  definition: Record<string, unknown>,
): HazardsCatalogFeed {
  const parsed = regionFileSchema(hazardsFeedShape).parse({ feeds: [definition] });
  const def = parsed.feeds[0] as FeedDefinition;
  const issues = hazardsDomain.lintFeed?.(def) ?? [];
  if (issues.length > 0) throw new Error(`feed lint: ${issues.join("; ")}`);
  return toCatalogFeed(def, {
    domain: "hazards",
    region,
    file: `feeds/hazards/${region}.jsonc`,
    maintainers: [],
  }) as HazardsCatalogFeed;
}

/** `de-dwd-alerts` as the catalogue will write it: DWD's CAP status zip in every language. */
export const dwdFeed = (): HazardsCatalogFeed =>
  hazardFeed("de", {
    operator: "dwd",
    product: "alerts",
    name: "DWD weather warnings",
    tier: "authoritative",
    format: "cap",
    endpoints: {
      alerts: {
        url: "https://opendata.dwd.de/weather/alerts/cap/COMMUNEUNION_DWD_STAT/Z_CAP_C_EDZW_LATEST_PVW_STATUS_PREMIUMDWD_COMMUNEUNION_MUL.zip",
        unzip: { entries: "\\.xml$" },
        cadenceSec: 300,
      },
      areas: {
        urls: [
          "https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=dwd:Warngebiete_Kueste&outputFormat=application/json",
          "https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=dwd:Warngebiete_Binnenseen&outputFormat=application/json",
        ],
        cadenceSec: 2592000,
      },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 1800,
    license: "CC-BY-4.0",
    licenseUrl: "https://www.dwd.de/DE/service/rechtliche_hinweise/rechtliche_hinweise_node.html",
    attribution:
      "Deutscher Wetterdienst; Geobasisdaten © GeoBasis-DE / BKG 2021 (Daten modifiziert)",
    privacyUrl: "https://www.dwd.de/EN/service/dataprotection/dataprotection_node.html",
  });

/** The ECCC Datamart directory levels: offices, hours with their modification time, CAP files. */
export const ECCC_LINKS = [
  'href="([A-Z]{4}/)"',
  'href="(\\d{2}/)"[^>]*>[^<]*</a>\\s+(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})',
  'href="([^"]+\\.cap)"',
];

/** `ca-eccc-alerts` as the catalogue will write it: yesterday's and today's Datamart CAP trees. */
export const ecccFeed = (): HazardsCatalogFeed =>
  hazardFeed("ca", {
    operator: "eccc",
    product: "alerts",
    name: "ECCC weather alerts",
    tier: "authoritative",
    format: "cap",
    endpoints: {
      index: {
        urls: [
          "https://dd.weather.gc.ca/{utcDate-1}/WXO-DD/alerts/cap/{utcDate-1}/",
          "https://dd.weather.gc.ca/{utcDate}/WXO-DD/alerts/cap/{utcDate}/",
        ],
        fanout: "tolerant",
        cadenceSec: 120,
      },
      alerts: { url: "{item}", cadenceSec: 120, each: { role: "index", links: ECCC_LINKS } },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 900,
    license: "LicenseRef-ECCC-Data-Servers-End-use",
    licenseUrl: "https://eccc-msc.github.io/open-data/licence/readme_en/",
    attribution: "Data Source: Environment and Climate Change Canada",
    privacyUrl: "https://www.canada.ca/en/transparency/privacy.html",
  });

/** `us-nws-alerts` as the catalogue will write it: the active alerts, and a shape per zone they name. */
export const nwsFeed = (): HazardsCatalogFeed =>
  hazardFeed("us", {
    operator: "nws",
    product: "alerts",
    name: "NWS weather alerts",
    tier: "authoritative",
    format: "nws",
    endpoints: {
      alerts: {
        url: "https://api.weather.gov/alerts/active?status=actual",
        headers: { Accept: "application/geo+json" },
        cadenceSec: 120,
      },
      zones: {
        url: "https://api.weather.gov/zones/{item}",
        // A zone URL can be dead (a fire zone that does not exist answers 404).
        fanout: "tolerant",
        cadenceSec: 2592000,
        each: {
          role: "alerts",
          records: "features",
          field: "properties.affectedZones",
          pattern:
            "^https://api\\.weather\\.gov/zones/((?:forecast|county|fire|marine|offshore)/[A-Z0-9]+)$",
          keepSec: 2592000,
        },
      },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 600,
    license: "LicenseRef-US-Gov-Public-Domain",
    licenseUrl: "https://www.weather.gov/disclaimer",
    attribution: "National Weather Service (NOAA)",
    privacyUrl: "https://www.weather.gov/privacy",
  });

/** `eu-meteoalarm-alerts` as the catalogue will write it, for three of its countries. */
export const meteoalarmFeed = (): HazardsCatalogFeed =>
  hazardFeed("eu", {
    operator: "meteoalarm",
    product: "alerts",
    name: "MeteoAlarm warnings",
    tier: "authoritative",
    format: "meteoalarm",
    endpoints: {
      alerts: {
        urls: [
          "https://feeds.meteoalarm.org/api/v1/warnings/feeds-austria",
          "https://feeds.meteoalarm.org/api/v1/warnings/feeds-france",
          "https://feeds.meteoalarm.org/api/v1/warnings/feeds-ireland",
        ],
        fanout: "tolerant",
        cadenceSec: 120,
        maxPayloadAgeSec: 120,
      },
      geocodes: {
        url: "https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/MeteoAlarm_Geocodes_2026_07_31.json",
        cadenceSec: 2592000,
      },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 600,
    license: "LicenseRef-MeteoAlarm-Terms",
    licenseUrl: "https://meteoalarm.org/en/live/page/terms-and-conditions",
    attribution: "EUMETNET - MeteoAlarm",
    terms: {
      note: "Area shapes come from the geocode and alias files of MeteoAlarm's Redistribution Hub; the terms require redistribution within ten minutes.",
    },
    privacyUrl: "https://api.meteoalarm.org/privacy",
  });

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

const FIRMS_FILES = "https://firms.modaps.eosdis.nasa.gov/data/active_fire";

/** `nasa-firms-viirs-fires` as the catalogue will write it: the NOAA-21 and NOAA-20 24-hour files. */
export const firmsViirsFeed = (): HazardsCatalogFeed =>
  hazardFeed("global", {
    operator: "nasa",
    qualifier: "firms-viirs",
    product: "fires",
    name: "NASA FIRMS VIIRS active fires",
    tier: "authoritative",
    format: "firms",
    endpoints: {
      main: {
        urls: [
          `${FIRMS_FILES}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv`,
          `${FIRMS_FILES}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv`,
        ],
        fanout: "tolerant",
        cadenceSec: 3600,
      },
    },
    freshnessWindowSec: 10800,
    license: "CC0-1.0",
    licenseUrl:
      "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
    attribution: "NASA FIRMS (LANCE / ESDIS)",
    privacyUrl: "https://www.earthdata.nasa.gov/about/privacy-policy",
  });

/** `nasa-firms-modis-fires` as the catalogue will write it: the MODIS 24-hour file. */
export const firmsModisFeed = (): HazardsCatalogFeed =>
  hazardFeed("global", {
    operator: "nasa",
    qualifier: "firms-modis",
    product: "fires",
    name: "NASA FIRMS MODIS active fires",
    tier: "authoritative",
    format: "firms",
    endpoints: {
      main: { url: `${FIRMS_FILES}/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv`, cadenceSec: 3600 },
    },
    freshnessWindowSec: 10800,
    license: "CC0-1.0",
    licenseUrl:
      "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
    attribution: "NASA FIRMS (LANCE / ESDIS)",
    privacyUrl: "https://www.earthdata.nasa.gov/about/privacy-policy",
  });

const WFIGS = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";

/** `us-nifc-fires` as the catalogue will write it: the current perimeters and incident points. */
export const wfigsFeed = (): HazardsCatalogFeed =>
  hazardFeed("us", {
    operator: "nifc",
    product: "fires",
    name: "NIFC wildland fires",
    tier: "authoritative",
    format: "wfigs",
    endpoints: {
      perimeters: {
        url: `${WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outSR=4326&f=geojson`,
        cadenceSec: 600,
      },
      incidents: {
        url: `${WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=1%3D1&outSR=4326&f=geojson`,
        cadenceSec: 300,
      },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 3600,
    license: "LicenseRef-US-Gov-Public-Domain",
    licenseUrl: "https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824",
    attribution:
      "National Interagency Fire Center (NIFC) / WFIGS and contributing agencies, dynamic data, not legal documents.",
    privacyUrl: "https://www.doi.gov/privacy",
  });

/** `eu-effis-fires` as the catalogue will write it: the burnt areas of the last week. */
export const effisFeed = (): HazardsCatalogFeed =>
  hazardFeed("eu", {
    operator: "effis",
    product: "fires",
    name: "EFFIS burnt areas",
    tier: "authoritative",
    format: "effis",
    endpoints: {
      main: {
        url: "https://maps.effis.emergency.copernicus.eu/effis?service=WFS&version=1.1.0&request=GetFeature&typename=ms:modis.ba.poly.week&outputformat=geojson",
        cadenceSec: 3600,
      },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 14400,
    license: "CC-BY-4.0",
    licenseUrl: "https://forest-fire.emergency.copernicus.eu/about-effis/data-license",
    attribution:
      "EFFIS / Copernicus Emergency Management Service, © European Union, modified by OpenConditions.",
    privacyUrl: "https://forest-fire.emergency.copernicus.eu/about-effis/legal-notice",
  });

/** `us-noaa-hms-smoke` as the catalogue will write it: the day's smoke polygons. */
export const hmsFeed = (): HazardsCatalogFeed =>
  hazardFeed("us", {
    operator: "noaa",
    qualifier: "hms",
    product: "smoke",
    name: "NOAA HMS smoke",
    tier: "authoritative",
    format: "hms",
    endpoints: {
      main: {
        url: "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_%28v1%29/FeatureServer/0/query?where=1%3D1&outSR=4326&f=geojson&orderByFields=FID",
        cadenceSec: 600,
      },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 3600,
    license: "CC0-1.0",
    licenseUrl: "https://www.arcgis.com/home/item.html?id=ab7a5fbd76e3499296350eabf599fc63",
    attribution: "NOAA/NESDIS Hazard Mapping System (HMS)",
    privacyUrl: "https://www.noaa.gov/protecting-your-privacy",
  });

const USGS_SUMMARY = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

/** `usgs-quakes` as the catalogue will write it: the last day, and the last month as the reconciling snapshot. */
export const usgsFeed = (): HazardsCatalogFeed =>
  hazardFeed("global", {
    operator: "usgs",
    product: "quakes",
    name: "USGS earthquakes",
    tier: "authoritative",
    format: "usgs",
    endpoints: {
      recent: { url: `${USGS_SUMMARY}/all_day.geojson`, cadenceSec: 120 },
      window: { url: `${USGS_SUMMARY}/all_month.geojson`, cadenceSec: 900 },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 600,
    license: "LicenseRef-US-Gov-Public-Domain",
    licenseUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
    attribution: "U.S. Geological Survey",
    privacyUrl: "https://www.doi.gov/privacy",
  });

const EONET = "https://eonet.gsfc.nasa.gov/api/v3/events";
const EONET_CATEGORIES = "category=volcanoes,seaLakeIce,floods,landslides,dustHaze,drought";

/** `nasa-eonet-events` as the catalogue will write it: the open events and the ones closed in the last month. */
export const eonetFeed = (): HazardsCatalogFeed =>
  hazardFeed("global", {
    operator: "nasa",
    qualifier: "eonet",
    product: "events",
    name: "NASA EONET natural events",
    tier: "authoritative",
    format: "eonet",
    endpoints: {
      open: { url: `${EONET}?status=open&${EONET_CATEGORIES}`, cadenceSec: 900 },
      closed: { url: `${EONET}?status=closed&days=30&${EONET_CATEGORIES}`, cadenceSec: 3600 },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 3600,
    license: "CC0-1.0",
    licenseUrl:
      "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
    attribution: "NASA Earth Observatory Natural Event Tracker (EONET)",
    privacyUrl: "https://www.nasa.gov/privacy/",
  });

/** `gdacs-events` as the catalogue will write it: the event list and the CAP areas of its current episodes. */
export const gdacsFeed = (): HazardsCatalogFeed =>
  hazardFeed("global", {
    operator: "gdacs",
    product: "events",
    name: "GDACS disaster alerts",
    tier: "authoritative",
    format: "gdacs",
    endpoints: {
      events: { url: "https://www.gdacs.org/xml/rss.xml", cadenceSec: 600 },
      areas: { url: "https://www.gdacs.org/xml/gdacs_cap.xml", cadenceSec: 1800 },
    },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 1800,
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "GDACS, European Union (CC BY 4.0), modified",
    privacyUrl:
      "https://commission.europa.eu/privacy-policy-websites-managed-european-commission_en",
  });

export const parseContext = (fetchedAt: string, cadenceSec = 300): ParseContext => ({
  fetchedAt,
  cadenceSec,
  reference: {},
});
