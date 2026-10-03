/** Structured facts about a data licence, the single source of truth for what a
 *  licence lets us do with a feed's data. `id` is the SPDX id where SPDX lists the
 *  licence, otherwise `LicenseRef-<name>`; a feed with no licence is `NOASSERTION`.
 *  A right is `null` when the licence text does not say. */
export interface LicenseInfo {
  id: string;
  name: string;
  url: string;
  redistribution: boolean | null;
  derivedRedistribution: boolean | null;
  commercialUse: boolean | null;
  attributionRequired: boolean | null;
  retention: boolean | null;
  shareAlike: boolean;
}

/** A licence that grants every right, to be narrowed per entry. */
const open = (
  i: Pick<LicenseInfo, "id" | "name" | "url"> &
    Partial<Pick<LicenseInfo, "attributionRequired" | "shareAlike">>,
): LicenseInfo => ({
  redistribution: true,
  derivedRedistribution: true,
  commercialUse: true,
  attributionRequired: true,
  retention: true,
  shareAlike: false,
  ...i,
});

export const LICENSES: readonly LicenseInfo[] = [
  {
    id: "NOASSERTION",
    name: "Rights not verified",
    url: "https://spdx.org/licenses/",
    redistribution: null,
    derivedRedistribution: null,
    commercialUse: null,
    attributionRequired: null,
    retention: null,
    shareAlike: false,
  },
  open({
    id: "CC0-1.0",
    name: "Creative Commons Zero 1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attributionRequired: false,
  }),
  open({
    id: "CC-BY-4.0",
    name: "Creative Commons Attribution 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
  }),
  open({
    id: "CC-BY-SA-4.0",
    name: "Creative Commons Attribution-ShareAlike 4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    shareAlike: true,
  }),
  open({
    id: "LicenseRef-CC-BY-2.5-AR",
    name: "Creative Commons Attribution 2.5 Argentina",
    url: "https://creativecommons.org/licenses/by/2.5/ar/",
  }),
  open({
    id: "ODbL-1.0",
    name: "Open Data Commons Open Database License 1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    shareAlike: true,
  }),
  open({
    id: "DL-DE-ZERO-2.0",
    name: "Datenlizenz Deutschland – Zero – 2.0",
    url: "https://www.govdata.de/dl-de/zero-2-0",
    attributionRequired: false,
  }),
  open({
    id: "DL-DE-BY-2.0",
    name: "Datenlizenz Deutschland – Namensnennung – 2.0",
    url: "https://www.govdata.de/dl-de/by-2-0",
  }),
  open({
    id: "LicenseRef-GeoNutzV",
    name: "Verordnung zur Festlegung der Nutzungsbestimmungen für Geodaten",
    url: "https://www.gesetze-im-internet.de/geonutzv/",
  }),
  open({
    id: "etalab-2.0",
    name: "Licence Ouverte / Open Licence 2.0 (Etalab)",
    url: "https://www.etalab.gouv.fr/licence-ouverte-open-licence",
  }),
  open({
    id: "NLOD-2.0",
    name: "Norwegian Licence for Open Government Data 2.0",
    url: "https://data.norge.no/nlod/en/2.0",
  }),
  open({
    id: "OGL-UK-3.0",
    name: "Open Government Licence v3.0 (UK)",
    url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  }),
  open({
    id: "LicenseRef-OGL-BC",
    name: "Open Government Licence – British Columbia",
    url: "https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc",
  }),
  open({
    id: "LicenseRef-OGL-ON",
    name: "Open Government Licence – Ontario",
    url: "https://www.ontario.ca/page/open-government-licence-ontario",
  }),
  open({
    id: "LicenseRef-OD-HR",
    name: "Otvorena dozvola / Open Licence (Croatia)",
    url: "https://data.gov.hr/otvorena-dozvola",
  }),
  {
    id: "LicenseRef-511NY-DAA",
    name: "511NY Developer Access Agreement",
    url: "https://511ny.org/developers/daa",
    redistribution: null,
    derivedRedistribution: null,
    commercialUse: null,
    attributionRequired: true,
    retention: null,
    shareAlike: false,
  },
  open({
    id: "LicenseRef-Singapore-ODL-1.0",
    name: "Singapore Open Data Licence 1.0",
    url: "https://data.gov.sg/open-data-licence",
  }),
  open({
    id: "LicenseRef-HK-Gov-Open-Data",
    name: "DATA.GOV.HK Terms and Conditions of Use",
    url: "https://data.gov.hk/en/terms-and-conditions",
  }),
  open({
    id: "LicenseRef-NYC-Open-Data",
    name: "NYC Open Data Terms of Use",
    url: "https://www.nyc.gov/html/data/terms.html",
    attributionRequired: false,
  }),
  open({
    id: "LicenseRef-US-Gov-Public-Domain",
    name: "U.S. Government Public Domain (17 U.S.C. §105)",
    url: "https://www.usa.gov/government-works",
    attributionRequired: false,
  }),
];

const BY_ID = new Map(LICENSES.map((l) => [l.id, l]));

/** Exact, case-sensitive lookup of a licence id. */
export function licenseInfo(id: string): LicenseInfo | undefined {
  return BY_ID.get(id);
}
