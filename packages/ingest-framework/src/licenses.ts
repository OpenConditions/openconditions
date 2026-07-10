/** Structured facts about a data license — the single source of truth that replaces
 *  substring guessing and hand-comment ShareAlike isolation. `spdxId` is optional
 *  because most road-data licenses are not in the SPDX list. */
export interface LicenseInfo {
  id: string;
  name: string;
  url?: string;
  spdxId?: string;
  attributionRequired: boolean;
  shareAlike: boolean;
  commercialOk: boolean;
}

const L = (i: LicenseInfo): [string, LicenseInfo] => [i.id.toLowerCase(), i];

export const LICENSES: Record<string, LicenseInfo> = Object.fromEntries([
  L({
    id: "CC0-1.0",
    name: "Creative Commons Zero 1.0",
    spdxId: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attributionRequired: false,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "CC-BY-4.0",
    name: "Creative Commons Attribution 4.0",
    spdxId: "CC-BY-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "CC-BY-SA-4.0",
    name: "Creative Commons Attribution-ShareAlike 4.0",
    spdxId: "CC-BY-SA-4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    attributionRequired: true,
    shareAlike: true,
    commercialOk: true,
  }),
  L({
    id: "CC-BY-2.5-AR",
    name: "Creative Commons Attribution 2.5 Argentina",
    spdxId: "CC-BY-2.5-AR",
    url: "https://creativecommons.org/licenses/by/2.5/ar/",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "dl-de/zero-2-0",
    name: "Datenlizenz Deutschland – Zero – 2.0",
    url: "https://www.govdata.de/dl-de/zero-2-0",
    attributionRequired: false,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "dl-de/by-2-0",
    name: "Datenlizenz Deutschland – Namensnennung – 2.0",
    url: "https://www.govdata.de/dl-de/by-2-0",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "GeoNutzV",
    name: "Verordnung zur Festlegung der Nutzungsbestimmungen für Geodaten",
    url: "https://www.gesetze-im-internet.de/geonutzv/",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "etalab-2.0",
    name: "Licence Ouverte / Open Licence 2.0 (Etalab)",
    url: "https://www.etalab.gouv.fr/licence-ouverte-open-licence",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "NLOD-2.0",
    name: "Norwegian Licence for Open Government Data 2.0",
    url: "https://data.norge.no/nlod/en/2.0",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "OGL-UK-3.0",
    name: "Open Government Licence v3.0 (UK)",
    url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "OGL-BC",
    name: "Open Government Licence – British Columbia",
    url: "https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "OGL-ON",
    name: "Open Government Licence – Ontario",
    url: "https://www.ontario.ca/page/open-government-licence-ontario",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "OD-HR",
    name: "Otvorena dozvola / Open Licence (Croatia)",
    url: "https://data.gov.hr/otvorena-dozvola",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "511NY-DAA",
    name: "511NY Developer Access Agreement",
    url: "https://511ny.org/developers/daa",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "Singapore-ODL-1.0",
    name: "Singapore Open Data Licence 1.0",
    url: "https://data.gov.sg/open-data-licence",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "HK-Gov-Open-Data",
    name: "DATA.GOV.HK Terms and Conditions of Use",
    url: "https://data.gov.hk/en/terms-and-conditions",
    attributionRequired: true,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "NYC-Open-Data",
    name: "NYC Open Data Terms of Use",
    url: "https://www.nyc.gov/html/data/terms.html",
    attributionRequired: false,
    shareAlike: false,
    commercialOk: true,
  }),
  L({
    id: "US-Gov-Public-Domain",
    name: "U.S. Government Public Domain (17 U.S.C. §105)",
    url: "https://www.usa.gov/government-works",
    attributionRequired: false,
    shareAlike: false,
    commercialOk: true,
  }),
]);

/** Case-insensitive lookup of a license id. */
export function licenseInfo(id: string): LicenseInfo | undefined {
  return LICENSES[id.toLowerCase()];
}
