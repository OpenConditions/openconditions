import type { MultiPolygon, Polygon } from "geojson";

/** One Croatian county (županija), the NUTS 2021 level-3 region it is, and its outline. */
export interface HrCounty {
  nuts3: string;
  name: string;
  geometry: Polygon | MultiPolygon;
}

/**
 * The vendored county outlines: the State Geodetic Administration's
 * administrative units, where they came from, the dataset's own date, and
 * the credit and licence the Open Licence asks to be carried with them.
 */
export interface HrCountySnapshot {
  source: string;
  dataset: string;
  publisher: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  /** When DGU built the dataset (the GML's `timeStamp`), the date the licence asks to be stated. */
  datasetUpdatedAt: string;
  retrievedAt: string;
  /** The Douglas–Peucker tolerance, in degrees, the outlines were simplified to. */
  toleranceDeg: number;
  counties: readonly HrCounty[];
}

/**
 * Croatia's NUTS 2021 level-3 regions, which are its twenty counties and the
 * City of Zagreb, by their names in Eurostat's NUTS 2021 classification
 * (https://gisco-services.ec.europa.eu/distribution/v2/nuts/csv/NUTS_AT_2021.csv);
 * DGU names its counties the same way.
 */
export const HR_NUTS3: Readonly<Record<string, string>> = {
  HR021: "Bjelovarsko-bilogorska županija",
  HR022: "Virovitičko-podravska županija",
  HR023: "Požeško-slavonska županija",
  HR024: "Brodsko-posavska županija",
  HR025: "Osječko-baranjska županija",
  HR026: "Vukovarsko-srijemska županija",
  HR027: "Karlovačka županija",
  HR028: "Sisačko-moslavačka županija",
  HR031: "Primorsko-goranska županija",
  HR032: "Ličko-senjska županija",
  HR033: "Zadarska županija",
  HR034: "Šibensko-kninska županija",
  HR035: "Splitsko-dalmatinska županija",
  HR036: "Istarska županija",
  HR037: "Dubrovačko-neretvanska županija",
  HR050: "Grad Zagreb",
  HR061: "Međimurska županija",
  HR062: "Varaždinska županija",
  HR063: "Koprivničko-križevačka županija",
  HR064: "Krapinsko-zagorska županija",
  HR065: "Zagrebačka županija",
};
