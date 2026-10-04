import {
  type CatalogFeed,
  defineIngestDomain,
  emptyParseOutput,
  type FeedDefinition,
  type IngestDomain,
  type LookupFn,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import {
  buildRegistry,
  extendVocabulary,
  observationId,
  type Registry,
} from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";

/**
 * A test-only on-demand source: an upstream answering one fuel station per
 * grid cell asked for, at the cell's centre, with an e5 price and a tariff.
 * Test-only: no runtime module imports this helper.
 */

type Rec = Record<string, unknown>;

export const FORMAT = "cell-stations";

export const START = new Date("2026-10-03T10:00:00.000Z");

/** Parses a JSON list of `{ id, lon, lat, e5 }` stations, dated by the fetch. */
function parseStations(
  feed: CatalogFeed,
  payloads: Readonly<Record<string, readonly Buffer[]>>,
  ctx: { fetchedAt: string },
) {
  const out = emptyParseOutput();
  for (const buffer of payloads["main"] ?? []) {
    const stations = JSON.parse(buffer.toString("utf8")) as {
      id: string;
      lon: number;
      lat: number;
      e5: string;
    }[];
    for (const s of stations) {
      const featureId = `oc:feature:${feed.id}:${s.id}`;
      const provenance = {
        origin: "feed",
        sourceId: feed.id,
        sourceFormat: FORMAT,
        accessMode: "bulk",
        recordId: s.id,
        attribution: { provider: "payload claim", license: "payload claim" },
        privacy: { class: "authoritative" },
      };
      const location = {
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      };
      const freshness = { fetchedAt: ctx.fetchedAt };
      out.features.push({
        id: featureId,
        class: "feature",
        kind: "fuel_station",
        temporality: "static",
        lifecycle: "operational",
        name: [{ lang: "de", text: `Station ${s.id}` }],
        location,
        provenance,
        freshness,
        access: { audience: "public" },
        components: [
          {
            key: "e5",
            kind: "fuel_product",
            details: {
              kind: "fuel_product",
              v: 1,
              grade: "e5",
              per: "L",
              priceBasis: "gross",
              priceLevel: "standard",
              vehicleScope: "any",
            },
          },
        ],
        details: { kind: "fuel_station", v: 1, productsComplete: false },
      });
      const price: Rec = {
        class: "observation",
        kind: "observation",
        temporality: "live",
        location,
        provenance,
        freshness,
        property: "fuel.price",
        subject: { kind: "feature", featureId, componentKey: "e5" },
        result: { type: "money", amount: s.e5, currency: "EUR", per: "L" },
        phenomenonTime: { instant: ctx.fetchedAt },
        aggregation: "instantaneous",
      };
      price["id"] = observationId(feed.id, price as never);
      out.observations.push(price);
      out.offers.push({
        id: `oc:offer:${feed.id}:${s.id}`,
        class: "offer",
        kind: "energy_tariff",
        temporality: "static",
        location,
        provenance,
        freshness,
        subject: { class: "feature", id: featureId },
        currency: "EUR",
        elements: [{ components: [{ type: "energy", price: { amount: s.e5, currency: "EUR" } }] }],
        priceIncludesVat: true,
        validity: { status: "active" },
      });
    }
  }
  return out;
}

export const testDomain: IngestDomain = defineIngestDomain({
  id: "fuel",
  products: ["fuel"],
  feedShape: {},
  formats: {
    [FORMAT]: {
      id: FORMAT,
      kind: "features",
      products: ["fuel"],
      produces: { kinds: ["fuel_station", "energy_tariff"], properties: ["fuel.price"] },
      endpoints: { main: { required: true } },
      parse: parseStations,
    },
  },
  resolvers: [],
});

export const registry: Registry = buildRegistry([
  ...productionModules,
  {
    name: FORMAT,
    entries: [extendVocabulary({ vocabulary: "source_format", values: [FORMAT] })],
  },
]);

/** The coverage of every test source. */
export const COVERAGE: [number, number, number, number] = [8, 49, 9, 50];

/** An on-demand feed of its own (id, ledger, quota and URL), so no test depends on another's state. */
export function onDemandFeed(operator: string, over: Partial<FeedDefinition> = {}): CatalogFeed {
  const definition: FeedDefinition = {
    operator,
    product: "fuel",
    name: "Test cell stations",
    format: FORMAT,
    tier: "authoritative",
    endpoints: {
      main: {
        url: `https://example.test/${operator}?w={west}&s={south}&e={east}&n={north}`,
        cadenceSec: 900,
      },
    },
    freshnessWindowSec: 900,
    accessMode: "on_demand",
    onDemand: { cellDeg: 0.1, ttlSec: 900, maxCellsPerRead: 4, probe: [8.45, 49.05] },
    coverage: { bbox: COVERAGE },
    license: "CC0-1.0",
    attribution: "Test cell stations",
    privacyUrl: "https://example.test/privacy",
    ...over,
  };
  return toCatalogFeed(definition, {
    domain: "fuel",
    region: "de",
    file: "feeds/fuel/de.jsonc",
    maintainers: [],
  });
}

export const fakeLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

/** The station id the upstream answers for the cell whose south-west corner is given. */
export const stationOf = (west: number, south: number) => `s${west}_${south}`;

/**
 * A stub upstream: counts its calls, answers one station per cell, and can be
 * held (every call waits until released), made to fail or to answer nothing.
 */
export function upstream() {
  const calls: URL[] = [];
  let failing = false;
  let empty = false;
  let gate: Promise<void> | undefined;
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (gate) await gate;
    if (failing) return new Response("upstream down", { status: 503 });
    if (empty) return new Response("[]", { headers: { "content-type": "application/json" } });
    const [w, s, e, n] = ["w", "s", "e", "n"].map((k) => Number(url.searchParams.get(k)));
    const station = { id: stationOf(w!, s!), lon: (w! + e!) / 2, lat: (s! + n!) / 2, e5: "1.799" };
    return new Response(JSON.stringify([station]), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    /** Holds every call until the returned release is called. */
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
    fail(on: boolean) {
      failing = on;
    },
    /** Answers no station for any cell. */
    answerEmpty(on: boolean) {
      empty = on;
    },
  };
}
