import { describe, expect, it } from "vitest";
import { feedTermsSchema } from "../catalog/schema.js";
import {
  admitsCatalogChild,
  effectiveRights,
  type FeedTerms,
  isRestricted,
  type LicenseEvidence,
  licenseEvidence,
  permissionsOf,
} from "../catalog/terms.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

/** A checked statement, for tests about what a licence itself grants. */
const CHECKED: LicenseEvidence = {
  url: "https://publisher.example/terms",
  reviewedAt: "2026-10-29",
};

describe("effective rights", () => {
  it("an open licence admits catalogue children", () => {
    expect(admitsCatalogChild(effectiveRights("CC-BY-4.0"))).toBe(true);
  });

  it("terms override the licence field by field", () => {
    const r = effectiveRights("CC-BY-4.0", { url: "https://x", redistribution: false });
    expect(r.redistribution).toBe(false);
    expect(r.commercialUse).toBe(true);
    expect(admitsCatalogChild(r)).toBe(false);
  });

  it("an explicit null in terms overrides a known licence right", () => {
    expect(effectiveRights("CC-BY-4.0", { retention: null }).retention).toBeNull();
  });

  it("an explicit undefined in terms defers to the licence", () => {
    const r = effectiveRights("CC-BY-4.0", {
      redistribution: undefined,
      derivedRedistribution: undefined,
      commercialUse: undefined,
      attributionRequired: undefined,
      retention: undefined,
    });
    expect(r).toEqual(effectiveRights("CC-BY-4.0"));
  });

  it("NOASSERTION is unknown, not permissive", () => {
    expect(effectiveRights("NOASSERTION").redistribution).toBeNull();
    expect(admitsCatalogChild(effectiveRights("NOASSERTION"))).toBe(false);
  });

  it("terms can grant rights an unasserted licence lacks", () => {
    const r = effectiveRights("NOASSERTION", {
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      retention: true,
    });
    expect(admitsCatalogChild(r)).toBe(true);
  });

  it("share-alike is a licence fact", () => {
    expect(effectiveRights("ODbL-1.0").shareAlike).toBe(true);
    expect(effectiveRights("CC-BY-4.0").shareAlike).toBe(false);
  });

  it("a share-alike, unknown or unstated licence restricts a feed", () => {
    expect(isRestricted(effectiveRights("ODbL-1.0"), CHECKED)).toBe(true);
    expect(isRestricted(effectiveRights("NOASSERTION"), CHECKED)).toBe(true);
    expect(
      isRestricted(
        effectiveRights("CC-BY-4.0", { url: "https://x", redistribution: false }),
        CHECKED,
      ),
    ).toBe(true);
    expect(isRestricted(effectiveRights("CC-BY-4.0"), CHECKED)).toBe(false);
  });

  it("toCatalogFeed marks a restricted feed", () => {
    const terms = { url: CHECKED.url, reviewedAt: CHECKED.reviewedAt };
    expect(catalogFeed({ license: "ODbL-1.0", terms }).restricted).toBe(true);
    expect(catalogFeed({ license: "CC-BY-4.0", terms }).restricted).toBe(false);
    // An open licence nobody has checked the publisher states is only a claim.
    expect(catalogFeed({ license: "CC-BY-4.0" }).restricted).toBe(true);
  });

  it("toCatalogFeed carries the evidence and each use's permission", () => {
    const checked = catalogFeed({
      license: "CC-BY-4.0",
      terms: { url: CHECKED.url, reviewedAt: CHECKED.reviewedAt },
    });
    expect(checked.evidence).toEqual(CHECKED);
    expect(checked.permissions).toEqual({
      display: "yes",
      redistribute: "yes",
      derive: "yes",
      retain: "yes",
      commercial: "yes",
    });
    const unchecked = catalogFeed({ license: "CC-BY-4.0" });
    expect(unchecked.evidence).toBeNull();
    expect(unchecked.permissions.derive).toBe("unknown");
  });

  it("CC-BY-3.0-AT, CC-BY-3.0-DE and the Flemish and Swiss licences are public", () => {
    for (const id of [
      "CC-BY-3.0-AT",
      "CC-BY-3.0-DE",
      "LicenseRef-Modellicentie-Gratis-Hergebruik-1.0",
      "LicenseRef-opentransportdata-swiss-ToU",
    ]) {
      const rights = effectiveRights(id);
      expect(isRestricted(rights, CHECKED), id).toBe(false);
      expect(rights.attributionRequired, id).toBe(true);
    }
  });

  it("the camera licences resolve open", () => {
    for (const id of [
      "LicenseRef-TfL-Transport-Data-Service",
      "LicenseRef-Caltrans-Conditions-of-Use",
      "LicenseRef-ODOT-TripCheck",
    ]) {
      expect(isRestricted(effectiveRights(id), CHECKED), id).toBe(false);
    }
    expect(effectiveRights("LicenseRef-Caltrans-Conditions-of-Use").attributionRequired).toBe(
      false,
    );
    expect(effectiveRights("LicenseRef-TfL-Transport-Data-Service").attributionRequired).toBe(true);
    expect(effectiveRights("LicenseRef-ODOT-TripCheck").attributionRequired).toBe(true);
  });

  it("the hazard licences resolve open with attribution", () => {
    for (const id of ["LicenseRef-ECCC-Data-Servers-End-use", "LicenseRef-MeteoAlarm-Terms"]) {
      const rights = effectiveRights(id);
      expect(isRestricted(rights, CHECKED), id).toBe(false);
      expect(rights.attributionRequired, id).toBe(true);
      expect(rights.commercialUse, id).toBe(true);
    }
  });

  it("a publisher's required notice is a terms field, enough on its own", () => {
    const notice =
      "Time delays between this website and the www.meteoalarm.org website are possible.";
    expect(feedTermsSchema.parse({ notice }).notice).toBe(notice);
    expect(feedTermsSchema.safeParse({ notice: "" }).success).toBe(false);
    const terms: FeedTerms = { url: "https://x", notice, redistribution: false };
    expect(isRestricted(effectiveRights("LicenseRef-MeteoAlarm-Terms", terms), CHECKED)).toBe(true);
  });

  it("evidence needs both the statement's url and the date it was read", () => {
    expect(licenseEvidence(undefined)).toBeNull();
    expect(licenseEvidence({ url: "https://x" })).toBeNull();
    expect(licenseEvidence({ url: "https://x", reviewedAt: "2026-10-29" })).toEqual({
      url: "https://x",
      reviewedAt: "2026-10-29",
    });
    expect(feedTermsSchema.safeParse({ reviewedAt: "2026-10-29", note: "n" }).success).toBe(false);
  });

  it("a grant is a permission only on checked evidence; a denial always is", () => {
    const display = { url: "https://x", reviewedAt: "2026-10-29", redistribution: false };
    const rights = effectiveRights("CC-BY-4.0", display);
    expect(permissionsOf(rights, CHECKED)).toMatchObject({ display: "yes", redistribute: "no" });
    expect(permissionsOf(rights, null)).toMatchObject({ display: "unknown", redistribute: "no" });
    expect(permissionsOf(effectiveRights("NOASSERTION"), CHECKED)).toEqual({
      display: "unknown",
      redistribute: "unknown",
      derive: "unknown",
      retain: "unknown",
      commercial: "unknown",
    });
  });

  it("terms can allow display while refusing redistribution and derived products", () => {
    const r = effectiveRights("NOASSERTION", {
      url: "https://x",
      display: true,
      redistribution: false,
      derivedRedistribution: false,
    });
    expect(permissionsOf(r, CHECKED)).toMatchObject({
      display: "yes",
      redistribute: "no",
      derive: "no",
    });
    expect(isRestricted(r, CHECKED)).toBe(true);
  });

  it("licence lookup is exact", () => {
    expect(() => effectiveRights("dl-de/by-2-0")).toThrow(/unknown licence/);
    expect(() => effectiveRights("cc-by-4.0")).toThrow(/unknown licence/);
  });
});

describe("charging licences", () => {
  it("opendata.swiss terms allow redistribution but not commercial use, and do not restrict", () => {
    const r = effectiveRights("LicenseRef-opendata-swiss-terms-by-ask");
    expect(isRestricted(r, CHECKED)).toBe(false);
    expect(r.commercialUse).toBe(false);
    expect(r.redistribution).toBe(true);
    expect(r.attributionRequired).toBe(true);
  });

  it.each([
    "LicenseRef-NLR-Developer-Network-Terms",
    "OGDL-Taiwan-1.0",
    "LicenseRef-KOGL-Type-1",
    "LicenseRef-HK-CSDI-ToU",
  ])("%s is open and unrestricted", (id) => {
    const r = effectiveRights(id);
    expect(isRestricted(r, CHECKED)).toBe(false);
    expect(r.commercialUse).toBe(true);
    expect(r.attributionRequired).toBe(true);
    expect(r.shareAlike).toBe(false);
  });
});

it("keeps NH redistribution public while refusing automatic child admission without retention evidence", () => {
  const rights = effectiveRights("LicenseRef-National-Highways-Transport-Data-Feeds");
  expect(rights.retention).toBeNull();
  expect(isRestricted(rights, CHECKED)).toBe(false);
  expect(admitsCatalogChild(rights)).toBe(false);
});
