import { describe, expect, it } from "vitest";
import { hint, licenseOf, parseCkan, redactUrl } from "../lib/feed-discovery/normalize.js";

const datasetId = "10000000-0000-4000-8000-000000000000";
const resourceId = "20000000-0000-4000-8000-000000000000";
function page(resources: unknown[], extra = {}) {
  return {
    success: true,
    result: {
      count: 1,
      results: [
        {
          id: datasetId,
          name: "parking",
          title_translated: { en: "Parking" },
          license_id: "cc-by-40",
          resources,
          ...extra,
        },
      ],
    },
  };
}
describe("discovery metadata normalization", () => {
  it("preserves each distribution's rights, usage lists and protocol independently", () => {
    const { distributions: d } = parseCkan(
      page(
        [
          {
            id: resourceId,
            url: "https://example.org/apds",
            license_type: "http://publications.europa.eu/resource/authority/licence/ODC_BL",
            conditions_usage: ["fee", "contract"],
            communication_method: "push",
            application_layer_protocol: "mqtt",
          },
          {
            id: "30000000-0000-4000-8000-000000000000",
            url: "https://example.org/parking",
            license_id: "cc0-10",
          },
        ],
        {
          mobility_theme:
            '{"https://w3id.org/mobilitydcat-ap/mobility-theme/parking-information":true}',
          countries_covered: ["http://publications.europa.eu/resource/authority/country/BEL"],
        },
      ),
      "belgium",
    );
    expect(d).toHaveLength(2);
    expect(d[0]?.licenses).toEqual({
      origin: "distribution",
      declarations: ["http://publications.europa.eu/resource/authority/licence/ODC_BL"],
    });
    expect(d[0]?.usageConditions).toEqual(["contract", "fee"]);
    expect(d[0]?.protocols).toEqual(["mqtt"]);
    expect(d[0]?.countries).toContain("BE");
    expect(d[0]?.themes).toContain(
      "https://w3id.org/mobilitydcat-ap/mobility-theme/parking-information",
    );
    expect(licenseOf(d[0]!.licenses)).toMatchObject({
      state: "mapped",
      id: "ODbL-1.0",
      public: false,
    });
    expect(licenseOf(d[1]!.licenses)).toMatchObject({
      state: "mapped",
      id: "CC0-1.0",
      public: true,
    });
  });
  it.each([
    [[], "absent", false],
    [["Other"], "absent", false],
    [["Not specified"], "absent", false],
    [["cc-by"], "unmapped", false],
    [["cc-zero"], "unmapped", false],
    [["other-open"], "unmapped", false],
    [["cc0-10", "cc-by-sa-40"], "conflicting", false],
    [["dl-de-zero-20-1"], "mapped", true],
    [
      ["cc-by-40", "http://publications.europa.eu/resource/authority/licence/CC_BY_4_0"],
      "mapped",
      true,
    ],
  ])("classifies declarations conservatively %j", (declarations, state, isPublic) => {
    expect(
      licenseOf({ origin: "distribution", declarations: declarations as string[] }),
    ).toMatchObject({ state, public: isPublic });
  });
  it("does not fall back to a permissive dataset license over a resource declaration", () => {
    const d = parseCkan(
      page([{ id: resourceId, license_id: "other-open", isopen: true }]),
      "mobidrom",
    ).distributions[0]!;
    expect(licenseOf(d.licenses)).toMatchObject({ state: "unmapped", public: false });
  });
  it.each([
    { success: false },
    { success: true, result: { count: NaN, results: [] } },
    page([{ id: "not-uuid" }]),
    page([], { id: "name-only" }),
  ])("rejects malformed CKAN without reporting a healthy empty catalog", (value) => {
    expect(() => parseCkan(value, "belgium")).toThrow("invalid_envelope");
  });
  it("redacts all unknown query values, userinfo, fragments, contacts and free-text credentials", () => {
    expect(
      redactUrl("https://alice:password@example.org/path?surprise=secret&service=WFS#token"),
    ).toBe("https://example.org/path?surprise=%5BREDACTED%5D&service=WFS");
    const text = hint(
      "email a.person@example.org phone +49 123 456789 token=secret https://u:p@example.org/x?unusual=secret <script>",
    );
    expect(text).not.toMatch(/a\.person|456789|secret|u:p/);
    expect(redactUrl("javascript:alert(1)")).toBe("");
  });
});
it("preserves canonical registry IDs and Belgian access-fact aliases", () => {
  const d = parseCkan(
    page([
      {
        id: resourceId,
        license_type: "CC-BY-4.0",
        acc_mod: "APDS",
        acc_int: "mqtt",
        acc_con: "push",
      },
    ]),
    "belgium",
  ).distributions[0]!;
  expect(d).toMatchObject({ standards: ["APDS"], protocols: ["mqtt"], communication: ["push"] });
  expect(licenseOf(d.licenses)).toMatchObject({ state: "mapped", public: true });
});
it("retains dataset usage restrictions as explicit fallback alongside an open distribution licence", () => {
  const d = parseCkan(
    page([{ id: resourceId, license_id: "cc0-10" }], {
      conditions_usage: "contractual-arrangement",
    }),
    "belgium",
  ).distributions[0]!;
  expect(d.usageConditions).toEqual(["contractual-arrangement"]);
  expect(d.evidenceOrigins.usageConditions).toBe("dataset");
});
