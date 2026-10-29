/** Structured facts about a data licence, the single source of truth for what a
 *  licence lets us do with a feed's data. `id` is the SPDX id where SPDX lists the
 *  licence, otherwise `LicenseRef-<name>`; a feed with no licence is `NOASSERTION`.
 *  Keep registered IDs in the exact spelling from https://spdx.org/licenses/;
 *  `name` is the full human-readable licence title, not an alternative feed ID.
 *  Reuse custom IDs only for the same terms. Preserve publisher-supplied notices
 *  and raw upstream labels separately rather than rewriting their wording.
 *  A right is `null` when the licence text does not say. */
export interface LicenseInfo {
  id: string;
  name: string;
  url: string;
  /** Showing the data, unchanged and credited, to an application's users. */
  display: boolean | null;
  redistribution: boolean | null;
  derivedRedistribution: boolean | null;
  commercialUse: boolean | null;
  attributionRequired: boolean | null;
  /** Whether a changed or derived version must say, in its credit, that the
   *  data was changed (CC BY's "indicate if You modified", the German
   *  "Veränderungshinweis"). An obligation like `attributionRequired`; `null`
   *  where the text has not been read for it. */
  changeNotice: boolean | null;
  retention: boolean | null;
  shareAlike: boolean;
}

/** A licence that grants every right, to be narrowed per entry. */
const open = (
  i: Pick<LicenseInfo, "id" | "name" | "url" | "changeNotice"> &
    Partial<Pick<LicenseInfo, "attributionRequired" | "shareAlike">>,
): LicenseInfo => ({
  display: true,
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
    changeNotice: null,
    display: null,
    redistribution: null,
    derivedRedistribution: null,
    commercialUse: null,
    attributionRequired: null,
    retention: null,
    shareAlike: false,
  },
  open({
    id: "CC0-1.0",
    name: "Creative Commons Zero v1.0 Universal",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    changeNotice: false,
    attributionRequired: false,
  }),
  open({
    id: "CC-BY-4.0",
    name: "Creative Commons Attribution 4.0 International",
    url: "https://creativecommons.org/licenses/by/4.0/",
    changeNotice: true,
  }),
  open({
    id: "CC-BY-SA-4.0",
    name: "Creative Commons Attribution-ShareAlike 4.0 International",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    changeNotice: true,
    shareAlike: true,
  }),
  open({
    id: "LicenseRef-CC-BY-2.5-AR",
    name: "Creative Commons Attribution 2.5 Argentina",
    url: "https://creativecommons.org/licenses/by/2.5/ar/",
    changeNotice: true,
  }),
  open({
    id: "ODbL-1.0",
    name: "Open Data Commons Open Database License v1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    changeNotice: false,
    shareAlike: true,
  }),
  open({
    id: "DL-DE-ZERO-2.0",
    name: "Datenlizenz Deutschland – Zero – Version 2.0",
    url: "https://www.govdata.de/dl-de/zero-2-0",
    changeNotice: false,
    attributionRequired: false,
  }),
  open({
    id: "DL-DE-BY-2.0",
    name: "Datenlizenz Deutschland – Namensnennung – Version 2.0",
    url: "https://www.govdata.de/dl-de/by-2-0",
    changeNotice: true,
  }),
  open({
    id: "LicenseRef-GeoNutzV",
    name: "Verordnung zur Festlegung der Nutzungsbestimmungen für Geodaten",
    url: "https://www.gesetze-im-internet.de/geonutzv/",
    changeNotice: true,
  }),
  // The Etalab licence's first version (2011), which some French portals still
  // link; it grants the same reuse, credited with the source and the date of
  // its last update.
  open({
    id: "LicenseRef-Licence-Ouverte-1.0",
    name: "Licence Ouverte / Open Licence 1.0 (Etalab)",
    url: "https://www.etalab.gouv.fr/wp-content/uploads/2014/05/Licence_Ouverte.pdf",
    changeNotice: false,
  }),
  open({
    id: "etalab-2.0",
    name: "Licence Ouverte / Open Licence 2.0 (Etalab)",
    url: "https://www.etalab.gouv.fr/licence-ouverte-open-licence",
    changeNotice: false,
  }),
  open({
    id: "NLOD-2.0",
    name: "Norwegian Licence for Open Government Data (NLOD) 2.0",
    url: "https://data.norge.no/nlod/en/2.0",
    changeNotice: true,
  }),
  open({
    id: "OGL-UK-3.0",
    name: "Open Government Licence v3.0",
    url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    changeNotice: false,
  }),
  {
    id: "LicenseRef-National-Highways-Transport-Data-Feeds",
    name: "National Highways Transport Data Feeds Licence (OGL v2.0 with NH amendments)",
    url: "https://developer.data.nationalhighways.co.uk/terms",
    changeNotice: false,
    display: true,
    redistribution: true,
    derivedRedistribution: true,
    commercialUse: true,
    attributionRequired: true,
    retention: null,
    shareAlike: false,
  },
  open({
    id: "OGL-Canada-2.0",
    name: "Open Government Licence – Canada",
    url: "https://open.canada.ca/en/open-government-licence-canada",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-OGL-BC",
    name: "Open Government Licence – British Columbia",
    url: "https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-OGL-ON",
    name: "Open Government Licence – Ontario",
    url: "https://www.ontario.ca/page/open-government-licence-ontario",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-OD-HR",
    name: "Otvorena dozvola / Open Licence (Croatia)",
    url: "https://data.gov.hr/otvorena-dozvola",
    changeNotice: true,
  }),
  {
    id: "LicenseRef-511NY-DAA",
    name: "511NY Developer Access Agreement",
    url: "https://511ny.org/help/24",
    changeNotice: false,
    display: true,
    redistribution: true,
    derivedRedistribution: true,
    commercialUse: null,
    // The agreement permits the "powered by 511NY" credit but does not require it.
    attributionRequired: false,
    retention: null,
    shareAlike: false,
  },
  open({
    id: "CC-BY-3.0-AU",
    name: "Creative Commons Attribution 3.0 Australia",
    url: "https://creativecommons.org/licenses/by/3.0/au/",
    changeNotice: true,
  }),
  open({
    id: "CC-BY-3.0-AT",
    name: "Creative Commons Attribution 3.0 Austria",
    url: "https://creativecommons.org/licenses/by/3.0/at/",
    changeNotice: true,
  }),
  open({
    id: "CC-BY-3.0-DE",
    name: "Creative Commons Attribution 3.0 Germany",
    url: "https://creativecommons.org/licenses/by/3.0/de/",
    changeNotice: true,
  }),
  open({
    id: "LicenseRef-Modellicentie-Gratis-Hergebruik-1.0",
    name: "Modellicentie Gratis Hergebruik Vlaanderen 1.0",
    url: "https://www.vlaanderen.be/digitaal-vlaanderen/onze-oplossingen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie/modellicentie-gratis-hergebruik",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-opentransportdata-swiss-ToU",
    name: "opentransportdata.swiss General Terms and Conditions of Use",
    url: "https://opentransportdata.swiss/en/terms-of-use/",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-Singapore-ODL-1.0",
    name: "Singapore Open Data Licence 1.0",
    url: "https://data.gov.sg/open-data-licence",
    changeNotice: false,
  }),
  {
    ...open({
      id: "LicenseRef-opendata-swiss-terms-by-ask",
      name: "opendata.swiss terms of use: open use, must provide the source, commercial use by permission",
      url: "https://opendata.swiss/en/terms-of-use",
      changeNotice: false,
    }),
    commercialUse: false,
  },
  open({
    id: "LicenseRef-NLR-Developer-Network-Terms",
    name: "NLR Developer Network Terms and Conditions",
    url: "https://developer.nlr.gov/terms/",
    changeNotice: false,
  }),
  open({
    id: "OGDL-Taiwan-1.0",
    name: "Open Government Data License, Taiwan, version 1.0 (政府資料開放授權條款-第1版)",
    url: "https://data.gov.tw/license",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-KOGL-Type-1",
    name: "Korea Open Government License Type 1 (공공누리 제1유형: 출처표시)",
    url: "https://www.kogl.or.kr/info/licenseType1.do",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-HK-CSDI-ToU",
    name: "CSDI Portal Terms and Conditions of Use (Hong Kong)",
    url: "https://portal.csdi.gov.hk/csdi-webpage/doc/TNC",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-HK-Gov-Open-Data",
    name: "DATA.GOV.HK Terms and Conditions of Use",
    url: "https://data.gov.hk/en/terms-and-conditions",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-NYC-Open-Data",
    name: "NYC Open Data Terms of Use",
    url: "https://www.nyc.gov/html/data/terms.html",
    changeNotice: null,
    attributionRequired: false,
  }),
  open({
    id: "LicenseRef-TfL-Transport-Data-Service",
    name: "TfL Transport Data Service licence (OGL v2.0 with TfL amendments)",
    url: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
    changeNotice: false,
  }),
  open({
    id: "LicenseRef-Caltrans-Conditions-of-Use",
    name: "Caltrans Conditions of Use",
    url: "https://dot.ca.gov/conditions-of-use",
    changeNotice: false,
    attributionRequired: false,
  }),
  open({
    id: "LicenseRef-ODOT-TripCheck",
    name: "ODOT TripCheck data terms of use",
    url: "https://apiportal.odot.state.or.us/product#product=tripcheck-api-data",
    changeNotice: null,
  }),
  // Credited as "Data Source: Environment and Climate Change Canada"; a weather
  // alert is reproduced without altering its content or intent.
  open({
    id: "LicenseRef-ECCC-Data-Servers-End-use",
    name: "Environment and Climate Change Canada Data Servers End-use Licence",
    url: "https://eccc-msc.github.io/open-data/licence/readme_en/",
    changeNotice: false,
  }),
  // CC BY 4.0-equivalent, with duties on the redistributor: the issuing service
  // named, the issue time, a www.meteoalarm.org link, a fixed disclaimer, and
  // at most ten minutes' delay.
  open({
    id: "LicenseRef-MeteoAlarm-Terms",
    name: "MeteoAlarm Terms and Conditions",
    url: "https://meteoalarm.org/en/live/page/terms-and-conditions",
    changeNotice: true,
  }),
  // Free, full and open use under Regulation (EU) No 1159/2013, with the
  // notice "Contains modified Copernicus Sentinel data [Year]" on data that
  // was adapted.
  open({
    id: "LicenseRef-Copernicus-Sentinel-Data",
    name: "Legal notice on the use of Copernicus Sentinel Data and Service Information",
    url: "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
    changeNotice: true,
  }),
  open({
    id: "LicenseRef-US-Gov-Public-Domain",
    name: "U.S. Government Public Domain (17 U.S.C. §105)",
    url: "https://www.usa.gov/government-works",
    changeNotice: false,
    attributionRequired: false,
  }),
];

const BY_ID = new Map(LICENSES.map((l) => [l.id, l]));

/** Exact, case-sensitive lookup of a licence id. */
export function licenseInfo(id: string): LicenseInfo | undefined {
  return BY_ID.get(id);
}
