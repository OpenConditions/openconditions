import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CatalogFeed,
  type FeedDefinition,
  type ParseContext,
  toCatalogFeed,
} from "@openconditions/ingest-framework";

/** A loaded fuel feed for tests: the definition as its region file writes it, derived as the loader derives it. */
export function fuelFeed(region: string, definition: FeedDefinition): CatalogFeed {
  return toCatalogFeed(definition, {
    domain: "fuel",
    region,
    file: `feeds/fuel/${region}.jsonc`,
    maintainers: [],
  });
}

/** `es-minetur-fuel` as `feeds/fuel/es.jsonc` writes it. */
export const mineturFeed = (): CatalogFeed =>
  fuelFeed("es", {
    operator: "minetur",
    product: "fuel",
    name: "MINETUR fuel prices (Spain)",
    tier: "authoritative",
    format: "minetur",
    endpoints: {
      main: {
        url: "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/",
        headers: { Accept: "application/json" },
        cadenceSec: 1800,
      },
    },
    freshnessWindowSec: 86400,
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Ministerio para la Transición Ecológica y el Reto Demográfico (MITECO)",
    privacyUrl: "https://www.miteco.gob.es/es/ministerio/proteccion-datos-personales.html",
  });

/** `fr-prixcarburants-fuel` as `feeds/fuel/fr.jsonc` writes it. */
export const prixCarburantsFeed = (): CatalogFeed =>
  fuelFeed("fr", {
    operator: "prixcarburants",
    product: "fuel",
    name: "Prix des carburants (France)",
    tier: "authoritative",
    format: "prix-carburants",
    endpoints: {
      main: {
        url: "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json",
        cadenceSec: 900,
      },
    },
    freshnessWindowSec: 86400,
    license: "etalab-2.0",
    licenseUrl: "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0",
    attribution: "Ministère de l'Économie (prix-carburants.gouv.fr)",
    privacyUrl: "https://www.prix-carburants.gouv.fr/rubrique/donnees-personnelles/",
  });

/** `de-tankerkoenig-fuel` as `feeds/fuel/de.jsonc` writes it, the setup guide left out. */
export const tankerkoenigFeed = (): CatalogFeed =>
  fuelFeed("de", {
    operator: "tankerkoenig",
    product: "fuel",
    name: "Tankerkönig fuel prices (Germany)",
    tier: "authoritative",
    format: "tankerkoenig",
    credentials: { api_key: { title: "Tankerkönig API Key" } },
    auth: { kind: "none" },
    endpoints: {
      main: {
        url: "https://creativecommons.tankerkoenig.de/json/list.php?lat={lat}&lng={lon}&rad={radiusKm}&sort=dist&type=all&apikey=${api_key}",
        cadenceSec: 900,
      },
    },
    freshnessWindowSec: 86400,
    accessMode: "on_demand",
    onDemand: { cellDeg: 0.25, ttlSec: 900, maxCellsPerRead: 4, probe: [13.4, 52.52] },
    requestLimits: { perMinute: 1, maxRadiusKm: 25, keyScope: "instance" },
    coverage: { bbox: [5.8, 47.2, 15.1, 55.1] },
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Tankerkönig (MTS-K), CC BY 4.0 – https://creativecommons.tankerkoenig.de",
    terms: {
      url: "https://creativecommons.tankerkoenig.de/",
      reviewedAt: "2026-10-03",
      note: "API data must not be obtained or passed on by mineral oil companies, filling-station operators or IT providers working for them; a public API cannot exclude them",
      redistribution: false,
    },
    privacyUrl: "https://onboarding.tankerkoenig.de/datenschutz",
  });

const econtrolSearch = (fuelType: string) =>
  `https://api.e-control.at/sprit/1.0/search/gas-stations/by-address?latitude={lat}&longitude={lon}&fuelType=${fuelType}&includeClosed=false`;

/** `at-econtrol-fuel` as `feeds/fuel/at.jsonc` writes it. */
export const econtrolFeed = (): CatalogFeed =>
  fuelFeed("at", {
    operator: "econtrol",
    product: "fuel",
    name: "E-Control Spritpreisrechner (Austria)",
    tier: "authoritative",
    format: "econtrol",
    endpoints: {
      main: {
        urls: [econtrolSearch("DIE"), econtrolSearch("SUP"), econtrolSearch("GAS")],
        cadenceSec: 900,
      },
    },
    freshnessWindowSec: 86400,
    accessMode: "on_demand",
    onDemand: { cellDeg: 0.1, ttlSec: 900, maxCellsPerRead: 9, probe: [16.37, 48.21] },
    requestLimits: { perMinute: 20, maxRadiusKm: 10 },
    coverage: { bbox: [9.5, 46.3, 17.2, 49.1] },
    license: "NOASSERTION",
    attribution: "E-Control (Spritpreisrechner)",
    terms: {
      url: "https://api.e-control.at/sprit/1.0/doc/index.html",
      reviewedAt: "2026-10-03",
      note: "No licence or terms published; data.gv.at does not list the fuel API",
    },
    privacyUrl: "https://www.e-control.at/datenschutz",
  });

/** `osm-fuel` as `feeds/fuel/global.jsonc` writes it. */
export const osmFuelFeed = (): CatalogFeed =>
  fuelFeed("global", {
    operator: "osm",
    product: "fuel",
    name: "OpenStreetMap filling stations",
    homepage: "https://www.openstreetmap.org/copyright",
    tier: "authoritative",
    format: "overpass",
    endpoints: {
      main: {
        url: "${@overpass.url}/api/interpreter",
        method: "POST",
        body: 'data=[out:json][timeout:25];nwr["amenity"="fuel"]({south},{west},{north},{east});out center tags;',
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "OpenConditions-OsmFuel/1.0 (+https://github.com/openconditions/openconditions)",
        },
        cadenceSec: 3600,
      },
    },
    freshnessWindowSec: 86400,
    accessMode: "on_demand",
    onDemand: { cellDeg: 0.1, ttlSec: 3600, maxCellsPerRead: 16, probe: [8.4, 49.01] },
    requestLimits: { perMinute: 30, perDay: 5000 },
    coverage: { bbox: [-180, -90, 180, 90] },
    license: "ODbL-1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors",
    privacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
  });

export const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name));

export const parseContext = (fetchedAt: string): ParseContext => ({
  fetchedAt,
  cadenceSec: 900,
  reference: {},
});
