import type { AttributionPolicy } from "@openconditions/model";

/** Reviewed defaults for this producer's exact custom definitions, captured before storage. */
const POLICIES: Readonly<Record<string, AttributionPolicy>> = {
  "LicenseRef-GeoNutzV": {
    placement: "visible",
    surfaces: ["map", "content", "image"],
    basis: "recommendation",
    reviewedAt: "2026-10-14",
    evidenceUrls: ["https://www.gesetze-im-internet.de/geonutzv/__3.html"],
    reason:
      "explicit-recognizable-optical-association; continuous-compact-implementation-inference",
  },
  "LicenseRef-KOGL-Type-1": {
    placement: "details",
    surfaces: ["map", "content", "image"],
    basis: "licence",
    reviewedAt: "2026-10-14",
    evidenceUrls: [
      "https://www.kogl.or.kr/info/licenseType1.do",
      "https://www.data.go.kr/data/15076352/openapi.do",
    ],
    reason: "no-literal-position-rule; reasonable-panel-inference",
  },
  "LicenseRef-Modellicentie-Gratis-Hergebruik-1.0": {
    placement: "details",
    surfaces: ["map", "content", "image"],
    basis: "licence",
    reviewedAt: "2026-10-14",
    evidenceUrls: [
      "https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie/modellicentie-gratis-hergebruik",
    ],
    reason: "source-required-on-each-reuse; panel-inference-with-supplier-override",
  },
  "LicenseRef-OD-HR": {
    placement: "details",
    surfaces: ["map", "content", "image"],
    basis: "licence",
    reviewedAt: "2026-10-14",
    evidenceUrls: ["https://www.data.gov.hr/hr/open-license"],
    reason: "no-literal-position-rule; complete-panel-inference",
  },
  "LicenseRef-OGL-ON": {
    placement: "details",
    surfaces: ["map", "content", "image"],
    basis: "licence",
    reviewedAt: "2026-10-14",
    evidenceUrls: [
      "https://www.ontario.ca/page/open-government-licence-ontario",
      "https://511on.ca/developers/resources",
    ],
    reason: "no-continuous-placement-rule; panel-inference",
  },
  "LicenseRef-OGL-BC": {
    placement: "details",
    surfaces: ["map", "content", "image"],
    basis: "licence",
    reviewedAt: "2026-10-14",
    evidenceUrls: [
      "https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc",
    ],
    reason: "no-continuous-placement-rule; panel-inference",
  },
  "LicenseRef-ECCC-Data-Servers-End-use": {
    placement: "details",
    surfaces: ["map", "content", "image"],
    basis: "licence",
    reviewedAt: "2026-10-14",
    evidenceUrls: ["https://eccc-msc.github.io/open-data/licence/readme_en/"],
    reason: "no-position-rule; panel-inference",
  },
  "LicenseRef-Singapore-ODL-1.0": {
    placement: "visible",
    surfaces: ["map", "content", "image"],
    basis: "recommendation",
    reviewedAt: "2026-10-14",
    evidenceUrls: [
      "https://data.gov.sg/open-data-licence",
      "https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html",
    ],
    reason: "explicit-conspicuous-notice; compact-visible-product-implementation",
  },
  "LicenseRef-HK-Gov-Open-Data": {
    placement: "visible",
    surfaces: ["map", "content", "image"],
    basis: "recommendation",
    reviewedAt: "2026-10-14",
    evidenceUrls: ["https://data.gov.hk/en/terms-and-conditions"],
    reason:
      "explicit-clear-source-and-ownership-in-all-copies; conservative-visible-implementation",
  },
  "LicenseRef-HK-CSDI-ToU": {
    placement: "visible",
    surfaces: ["map", "content", "image"],
    basis: "recommendation",
    reviewedAt: "2026-10-14",
    evidenceUrls: ["https://portal.csdi.gov.hk/csdi-webpage/doc/TNC"],
    reason:
      "explicit-clear-source-and-ownership-in-all-copies; conservative-visible-implementation",
  },
  "LicenseRef-opentransportdata-swiss-ToU": {
    placement: "visible",
    surfaces: ["map", "content", "image"],
    basis: "recommendation",
    reviewedAt: "2026-10-14",
    evidenceUrls: [
      "https://opentransportdata.swiss/de/terms-of-use/",
      "https://opentransportdata.swiss/en/authorised-databases/",
    ],
    reason: "source-per-publication; indirect-list-exception-requires-SBB-approval",
  },
  "LicenseRef-opendata-swiss-terms-by-ask": {
    placement: "visible",
    surfaces: ["map", "content", "image"],
    basis: "unresolved",
    reviewedAt: "2026-10-14",
    evidenceUrls: [
      "https://opendata.swiss/en/terms-of-use",
      "https://opendata.swiss/en/dataset/ladestationen-fuer-elektroautos",
    ],
    reason: "commercial-permission-separate; no-position-rule",
  },
};

export function reviewedAttributionPolicy(licenseId: string): AttributionPolicy | undefined {
  return Object.hasOwn(POLICIES, licenseId) ? POLICIES[licenseId] : undefined;
}
