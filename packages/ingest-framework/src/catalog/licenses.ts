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
    url: "https://511ny.org/help/24",
    redistribution: true,
    derivedRedistribution: true,
    commercialUse: null,
    // The agreement permits the "powered by 511NY" credit but does not require it.
    attributionRequired: false,
    retention: null,
    shareAlike: false,
  },
  open({
    id: "CC-BY-3.0-AT",
    name: "Creative Commons Attribution 3.0 Austria",
    url: "https://creativecommons.org/licenses/by/3.0/at/",
  }),
  open({
    id: "LicenseRef-Modellicentie-Gratis-Hergebruik-1.0",
    name: "Modellicentie Gratis Hergebruik Vlaanderen 1.0",
    url: "https://www.vlaanderen.be/digitaal-vlaanderen/onze-oplossingen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie/modellicentie-gratis-hergebruik",
  }),
  open({
    id: "LicenseRef-opentransportdata-swiss-ToU",
    name: "opentransportdata.swiss Terms of Use",
    url: "https://opentransportdata.swiss/en/terms-of-use/",
  }),
  open({
    id: "LicenseRef-Singapore-ODL-1.0",
    name: "Singapore Open Data Licence 1.0",
    url: "https://data.gov.sg/open-data-licence",
  }),
  {
    ...open({
      id: "LicenseRef-opendata-swiss-terms-by-ask",
      name: "opendata.swiss terms of use: open use, must provide the source, commercial use by permission",
      url: "https://opendata.swiss/en/terms-of-use",
    }),
    commercialUse: false,
  },
  open({
    id: "LicenseRef-NLR-Developer-Network-Terms",
    name: "NLR Developer Network Terms and Conditions",
    url: "https://developer.nlr.gov/terms/",
  }),
  open({
    id: "OGDL-Taiwan-1.0",
    name: "Open Government Data License, Taiwan, version 1.0 (政府資料開放授權條款-第1版)",
    url: "https://data.gov.tw/license",
  }),
  open({
    id: "LicenseRef-KOGL-Type-1",
    name: "Korea Open Government License Type 1 (공공누리 제1유형: 출처표시)",
    url: "https://www.kogl.or.kr/info/licenseType1.do",
  }),
  open({
    id: "LicenseRef-HK-CSDI-ToU",
    name: "CSDI Portal Terms and Conditions of Use (Hong Kong)",
    url: "https://portal.csdi.gov.hk/csdi-webpage/doc/TNC",
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
    id: "LicenseRef-TfL-Transport-Data-Service",
    name: "TfL Transport Data Service licence (OGL v2.0 with TfL amendments)",
    url: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
  }),
  open({
    id: "LicenseRef-Caltrans-Conditions-of-Use",
    name: "Caltrans Conditions of Use",
    url: "https://dot.ca.gov/conditions-of-use",
    attributionRequired: false,
  }),
  open({
    id: "LicenseRef-ODOT-TripCheck",
    name: "ODOT TripCheck data terms of use",
    url: "https://apiportal.odot.state.or.us/product#product=tripcheck-api-data",
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
