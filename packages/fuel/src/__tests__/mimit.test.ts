import { readFileSync } from "node:fs";
import { drainSkipped } from "@openconditions/ingest-framework";
import { expect, test } from "vitest";
import { fuelDomain } from "../domain.js";
import { fixture, fuelFeed, parseContext } from "./helpers/fuel-feed.js";
import { sealFailures } from "./helpers/seal.js";

const mimitFeed = () =>
  fuelFeed("it", {
    operator: "mimit",
    product: "fuel",
    name: "MIMIT",
    format: "mimit",
    tier: "authoritative",
    endpoints: {
      registry: { url: "https://example.test/registry", cadenceSec: 86400 },
      prices: { url: "https://example.test/prices", cadenceSec: 86400 },
    },
    freshnessWindowSec: 172800,
    license: "LicenseRef-IODL-2.0",
    attribution: "MIMIT",
    privacyUrl: "https://www.mimit.gov.it/it/privacy-sito",
  });
const parse = (
  registry = fixture("mimit-registry.csv"),
  prices = fixture("mimit-prices.csv"),
  fetchedAt = "2026-11-07T10:00:00Z",
) =>
  fuelDomain.formats["mimit"]!.parse(
    mimitFeed(),
    { registry: [registry], prices: [prices] },
    parseContext(fetchedAt),
  );

test("joins textual IDs and separates service, generic petrol, units and source times", () => {
  const out = parse();
  expect(out.features).toHaveLength(2);
  expect(out.features[0]).toMatchObject({
    id: "oc:feature:it-mimit-fuel:001",
    details: { productsComplete: false },
    location: { geometry: { coordinates: [9.2, 45.4] } },
  });
  expect(out.observations).toHaveLength(5);
  expect(out.observations[0]).toMatchObject({
    subject: { componentKey: "petrol:self" },
    phenomenonTime: { instant: "2026-11-06T07:00:00Z" },
    provenance: { sourceUpdatedAt: "2026-11-05T13:20:00Z" },
    freshness: { fetchedAt: "2026-11-07T10:00:00Z", expiresAt: "2026-11-07T07:00:00Z" },
  });
  expect(
    out.observations.find(
      (o) => (o["subject"] as { componentKey: string }).componentKey === "cng:self",
    ),
  ).toMatchObject({ result: { per: "kg" } });
});

test("rejects missing, mismatched, obsolete, future, malformed and truncated publications", () => {
  for (const bad of [
    Buffer.from("<html>error</html>"),
    fixture("mimit-prices.csv").subarray(0, -2),
    Buffer.from(fixture("mimit-prices.csv").toString().replace("2026-11-06", "2026-11-05")),
    Buffer.from(fixture("mimit-prices.csv").toString().replace("1.799", "NaN")),
  ])
    expect(() => parse(undefined, bad)).toThrow();
  expect(() => parse(undefined, undefined, "2026-11-09T10:00:00Z")).toThrow();
  expect(() => parse(undefined, undefined, "2026-11-06T06:00:00Z")).toThrow();
  expect(() =>
    fuelDomain.formats["mimit"]!.parse(
      mimitFeed(),
      { registry: [] },
      parseContext("2026-11-07T10:00:00Z"),
    ),
  ).toThrow();
});

test("retains unqualified empty snapshots and permits same-date corrections", () => {
  const empty = (name: string) =>
    Buffer.from(fixture(name).toString().split("\n").slice(0, 2).join("\n") + "\n");
  expect(parse(empty("mimit-registry.csv"), empty("mimit-prices.csv"))).toMatchObject({
    features: [],
    featureSnapshot: { complete: false, at: "2026-11-06T07:00:00Z" },
  });
  expect(
    parse(undefined, Buffer.from(fixture("mimit-prices.csv").toString().replace("1.799", "1.899")))
      .observations[0],
  ).toMatchObject({ result: { amount: "1.899" } });
});

test("uses Rome DST at the cutoff without subtracting another day", () => {
  const replace = (name: string) =>
    Buffer.from(
      fixture(name)
        .toString()
        .replaceAll("2026-11-06", "2026-07-06")
        .replaceAll("05/11/2026", "05/07/2026"),
    );
  expect(
    parse(replace("mimit-registry.csv"), replace("mimit-prices.csv"), "2026-07-07T07:00:00Z")
      .observations[0],
  ).toMatchObject({
    phenomenonTime: { instant: "2026-07-06T06:00:00Z" },
    provenance: { sourceUpdatedAt: "2026-07-05T12:20:00Z" },
  });
});

test("seals against the model and counts unknown marketing grades without inventing availability", () => {
  drainSkipped("it-mimit-fuel");
  const out = parse();
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(out.observations.every((o) => o["property"] === "fuel.price")).toBe(true);
  expect(drainSkipped("it-mimit-fuel")).toMatchObject({ unknown_value: 1 });
});

test("rejects invalid encoding, duplicate identities, invalid dates, services and orphan joins", () => {
  for (const payload of [
    Buffer.from([0xff, 0x0a]),
    Buffer.from(fixture("mimit-prices.csv").toString().replace("1.799|1", "1.799|2")),
    Buffer.from(fixture("mimit-prices.csv").toString().replace("002|", "999|")),
    Buffer.from(fixture("mimit-prices.csv").toString().replace("05/11/2026", "31/02/2026")),
    Buffer.from(
      fixture("mimit-prices.csv").toString() + "001|Benzina|1.799|1|05/11/2026 14:20:00\n",
    ),
  ])
    expect(() => parse(undefined, payload)).toThrow();
});

test("accepts UTF-8 accents and BOM, keeps identities stable under reordering, and leaves missing prices unknown", () => {
  const registry = fixture("mimit-registry.csv").toString().replace("Stazione A", "Città più");
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(registry)]);
  expect(parse(bom).features[0]).toMatchObject({ name: [{ lang: "it", text: "Città più" }] });
  const lines = registry.trimEnd().split("\n");
  const reordered = Buffer.from(
    [...lines.slice(0, 2), ...lines.slice(2).reverse()].join("\n") + "\n",
  );
  expect(
    parse(reordered)
      .features.map((f) => f["id"])
      .sort(),
  ).toEqual(
    parse()
      .features.map((f) => f["id"])
      .sort(),
  );
  const emptyPrices = Buffer.from(
    `${fixture("mimit-prices.csv").toString().split("\n").slice(0, 2).join("\n")}\n`,
  );
  expect(parse(undefined, emptyPrices)).toMatchObject({
    features: [
      expect.objectContaining({ details: expect.objectContaining({ productsComplete: false }) }),
      expect.anything(),
    ],
    observations: [],
  });
});

test("reads the repository's historical September station/price excerpt with a historical clock", () => {
  const historical = (name: string) =>
    readFileSync(
      new URL(
        `../../../model-registry/src/__tests__/fixtures/facilities/mimit-${name}.csv`,
        import.meta.url,
      ),
    );
  const out = parse(historical("stations"), historical("prices"), "2026-09-22T11:10:00Z");
  expect(out.features[0]).toMatchObject({
    id: "oc:feature:it-mimit-fuel:3464",
    name: [{ lang: "it", text: "PO EST" }],
  });
  expect(out.observations).toHaveLength(6);
  expect(out.observations[0]).toMatchObject({
    phenomenonTime: { instant: "2026-09-21T06:00:00Z" },
    result: { currency: "EUR" },
  });
});

test.each([
  "05/11/2026 24:00:00",
  "05/11/2026 14:60:00",
  "05/11/2026 14:20:60",
  "31/02/2026 14:20:00",
  "00/11/2026 14:20:00",
  "05/13/2026 14:20:00",
  "29/03/2026 02:30:00",
  "25/10/2026 02:30:00",
])("rejects invalid or ambiguous communication %s", (raw) => {
  const prices = Buffer.from(
    fixture("mimit-prices.csv").toString().replaceAll("05/11/2026 14:20:00", raw),
  );
  expect(() => parse(undefined, prices)).toThrow("communication");
});
test("syntax-valid row-boundary partial prices do not grant either withdrawal authority", () => {
  const prices = Buffer.from(
    fixture("mimit-prices.csv").toString().split("\n").slice(0, 5).join("\n") + "\n",
  );
  expect(parse(undefined, prices)).toMatchObject({
    featureSnapshot: { complete: false, statesComplete: false },
  });
});

test.each([
  [{ registry: "synthetic registry contract" }, true, false],
  [{ prices: "synthetic prices contract" }, false, true],
  [{ registry: "synthetic registry contract", prices: "synthetic prices contract" }, true, true],
] as const)("qualifies roles independently: %j", (roleEvidence, complete, statesComplete) => {
  const feed = { ...mimitFeed(), snapshot: { completeness: "complete" as const, roleEvidence } };
  const empty = (name: string) =>
    Buffer.from(`${fixture(name).toString().split("\n").slice(0, 2).join("\n")}\n`);
  expect(
    fuelDomain.formats["mimit"]!.parse(
      feed,
      { registry: [empty("mimit-registry.csv")], prices: [empty("mimit-prices.csv")] },
      parseContext("2026-11-07T10:00:00Z"),
    ),
  ).toMatchObject({ featureSnapshot: { complete, statesComplete } });
});
