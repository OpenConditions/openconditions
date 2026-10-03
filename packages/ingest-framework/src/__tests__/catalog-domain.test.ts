import { describe, expect, expectTypeOf, test } from "vitest";
import { defineIngestDomain, type FeedFormat, type IngestDomain } from "../catalog/domain.js";
import type { CatalogResolver } from "../catalog/resolvers.js";
import type { CatalogFeed } from "../catalog/types.js";
import { emptyParseOutput } from "../parse-output.js";

const emptyOutput = emptyParseOutput;

const format = (id: string, products: string[]): FeedFormat => ({
  id,
  kind: "situations",
  products,
  endpoints: { main: { required: true } },
  parse: () => emptyOutput(),
});

const resolver = (id: string): CatalogResolver => ({
  id,
  snapshotPath: "/unused",
  snapshot: [],
  resolve: async () => [],
});

describe("defineIngestDomain", () => {
  test("returns a valid domain unchanged", () => {
    const domain = {
      id: "roads",
      products: ["events", "flow"],
      feedShape: {},
      formats: { f: format("f", ["events"]) },
      resolvers: [resolver("r")],
    };
    expect(defineIngestDomain(domain)).toBe(domain);
  });

  test("a format may not serve a product its domain lacks", () => {
    expect(() =>
      defineIngestDomain({
        id: "x",
        products: ["events"],
        feedShape: {},
        resolvers: [],
        formats: {
          f: {
            id: "f",
            kind: "situations",
            products: ["flow"],
            endpoints: { main: { required: true } },
            parse: () => emptyOutput(),
          },
        },
      }),
    ).toThrow(/product flow/);
  });

  test("a domain names at least one product", () => {
    expect(() =>
      defineIngestDomain({ id: "x", products: [], feedShape: {}, formats: {}, resolvers: [] }),
    ).toThrow(/product/);
  });

  test("resolver ids are unique within a domain", () => {
    expect(() =>
      defineIngestDomain({
        id: "x",
        products: ["events"],
        feedShape: {},
        formats: {},
        resolvers: [resolver("dup"), resolver("dup")],
      }),
    ).toThrow(/dup/);
  });

  test("a domain over a narrower feed type is still an IngestDomain", () => {
    type NarrowFeed = CatalogFeed & { laneNumbering?: "standard" | "left_first" };
    const narrow = defineIngestDomain<NarrowFeed>({
      id: "n",
      products: ["flow"],
      feedShape: {},
      resolvers: [],
      formats: {
        m: {
          id: "m",
          kind: "measurements",
          products: ["flow"],
          endpoints: { main: { required: true }, sites: { required: false, decoders: ["d"] } },
          parse: (feed) => (feed.laneNumbering ? emptyOutput() : emptyOutput()),
          stream: {
            read: async (feed) => ({
              output: emptyOutput(),
              payload: { url: feed.id, sha256: "", bytes: 0 },
            }),
          },
        },
      },
    });
    expectTypeOf(narrow).toExtend<IngestDomain>();
  });
});
