import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseContext, readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { parkingDomain } from "../../domain.js";
import type { ParkingCatalogFeed } from "../../feed-schema.js";

const FEEDS_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "feeds");

let catalogue: Map<string, ParkingCatalogFeed> | undefined;

/**
 * Every feed of `feeds/parking/`, disabled ones included, derived as the
 * loader derives it. The parser tests read their feeds from here, so a
 * mapping the tests pass is the mapping the catalogue ships.
 */
export function parkingCatalogue(): ReadonlyMap<string, ParkingCatalogFeed> {
  catalogue ??= new Map(
    readCatalogDir(FEEDS_DIR, [parkingDomain], { otherDomains: "ignore" }).files.flatMap((file) =>
      file.feeds.map((definition) => {
        const feed = toCatalogFeed(definition, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }) as ParkingCatalogFeed;
        return [feed.id, feed] as const;
      }),
    ),
  );
  return catalogue;
}

/** One parking feed as its region file writes it. */
export function catalogFeed(id: string): ParkingCatalogFeed {
  const feed = parkingCatalogue().get(id);
  if (feed === undefined) throw new Error(`no feed ${id} in feeds/parking`);
  return structuredClone(feed);
}

/** Ghent's live garage occupancy, an ODS GeoJSON export. */
export const ghentFeed = () => catalogFeed("be-vlg-gent-parking");
/** The City of Brussels' public car parks, static. */
export const brusselsFeed = () => catalogFeed("be-bru-brussels-parking");
/** Basel's current garage occupancy, dataset 100088. */
export const baselFeed = () => catalogFeed("ch-bs-basel-parking");
/** Florence's car parks with free spaces, the datigis GeoJSON. */
export const florenceFeed = () => catalogFeed("it-52-florence-parking");
/** Garages and P+R sites in and around Vienna, the GARAGENOGD WFS. */
export const viennaFeed = () => catalogFeed("at-9-vienna-parking");
/** Salzburg's car parks with live free spaces, the city WFS. */
export const salzburgFeed = () => catalogFeed("at-5-salzburg-parking");
/** Copenhagen's parking garages, the `k101:p_hus` WFS layer. */
export const copenhagenFeed = () => catalogFeed("dk-84-copenhagen-parking");
/** Barcelona's car parks, the city's equipment JSON. */
export const barcelonaFeed = () => catalogFeed("es-ct-barcelona-parking");
/** Madrid's municipal car parks, the dataset's Latin-1 CSV. */
export const madridFeed = () => catalogFeed("es-md-madrid-parking");
/** France's national base of off-street car parks, the canonical CSV. */
export const bnlsFeed = () => catalogFeed("fr-bnls-parking");
/** The Braunschweig city map's car parks, disabled until the city consents. */
export const braunschweigFeed = () => catalogFeed("de-ni-braunschweig-parking");
/** MobiData BW's ParkAPI v3, car sites, with its source list. */
export const mobidataFeed = () => catalogFeed("de-bw-mobidata-parking");
/** NDW's lorry parks, a DATEX II v2 table and a v3 status. */
export const ndwFeed = () => catalogFeed("nl-ndw-truck-parking");
/** CITA's motorway rest areas, DATEX II v2. */
export const citaFeed = () => catalogFeed("lu-cita-parking");
/** The Parken NRW bundle, DATEX II Light JSON. */
export const mobidromFeed = () => catalogFeed("de-nw-mobidrom-parking");
/** The bundled Park+Ride NRW sets, share-alike. */
export const mobidromParkrideFeed = () => catalogFeed("de-nw-mobidrom-parkride-parking");
/** OpenStreetMap's car parks, read per cell from Overpass. */
export const osmParkingFeed = () => catalogFeed("osm-parking");
/** DB BahnPark's station car parks, Parking Information API v2. */
export const dbBahnparkFeed = () => catalogFeed("de-db-bahnpark-parking");
/** RDW's parking specifications joined to its three area datasets. */
export const rdwFeed = () => catalogFeed("nl-rdw-parking");
/** SBB's car and bike parking, the opentransportdata.swiss permalink. */
export const sbbFeed = () => catalogFeed("ch-sbb-parking");
/** South Tyrol's car parks from the Open Data Hub. */
export const opendatahubFeed = () => catalogFeed("it-32-opendatahub-parking");
/** HDB car parks, the data.gov.sg table and live lot availability. */
export const hdbFeed = () => catalogFeed("sg-hdb-parking");
/** Tyne and Wear car parks, UTMC static and dynamic. */
export const utmcFeed = () => catalogFeed("gb-eng-netraveldata-parking");
/** Transport for NSW Park&Ride occupancy, the `full-list` call. */
export const tfnswFeed = () => catalogFeed("au-nsw-tfnsw-parking");

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

export const parseContext = (fetchedAt: string, cadenceSec = 300): ParseContext => ({
  fetchedAt,
  cadenceSec,
  reference: {},
});
