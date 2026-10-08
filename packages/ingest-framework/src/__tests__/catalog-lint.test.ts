import { describe, expect, test } from "vitest";
import { isSettingsGroup } from "../catalog/credentials.js";
import { defineIngestDomain, type FeedFormat, type IngestDomain } from "../catalog/domain.js";
import { lintCatalog } from "../catalog/lint.js";
import { type CatalogFile, readCatalogDir, type SharedCredentials } from "../catalog/load.js";
import type { ChildFeed } from "../catalog/resolvers.js";
import { feedBaseShape } from "../catalog/schema.js";
import type { FeedDefinition } from "../catalog/types.js";
import { emptyParseOutput } from "../parse-output.js";
import { fixture, otherDomain, testDomain, testDomainWith } from "./helpers/catalog-domain.js";

const filesOf = (name: string) => readCatalogDir(fixture(name), [testDomain]).files;
const credentialsOf = (name: string) => readCatalogDir(fixture(name), [testDomain]).credentials;

const NO_SHARED: SharedCredentials = { groups: {} };
const NOW = new Date("2026-10-03T12:00:00Z");

const def = (over: Partial<FeedDefinition> = {}): FeedDefinition => ({
  operator: "op",
  product: "events",
  name: "Feed",
  format: "datex2",
  tier: "authoritative",
  endpoints: { main: { url: "https://example.test/feed", cadenceSec: 300 } },
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "Op",
  privacyUrl: "https://example.test/privacy",
  ...over,
});

const file = (feeds: FeedDefinition[], over: Partial<CatalogFile> = {}): CatalogFile => ({
  path: "feeds/roads/de.jsonc",
  domain: "roads",
  region: "de",
  maintainers: [],
  $schema: "../schema/roads.schema.json",
  feeds,
  ...over,
});

const messages = (
  files: CatalogFile[],
  credentials = NO_SHARED,
  domains = [testDomain],
): string[] =>
  lintCatalog(files, credentials, domains, NOW)
    .filter((i) => i.level === "error")
    .map((i) => i.message);

describe("lintCatalog", () => {
  test("a clean catalogue has no issues", () => {
    expect(lintCatalog([file([def()])], NO_SHARED, [testDomain], NOW)).toEqual([]);
  });

  test("lint flags an unreferenced credential and a lone shared group", () => {
    const issues = lintCatalog(filesOf("unused-credential"), credentialsOf("lone-group"), [
      testDomain,
    ]);
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/credential api_key is never used/),
        expect.stringMatching(/shared group lone is used by 1 feed/),
      ]),
    );
    expect(issues.find((i) => /api_key/.test(i.message))).toMatchObject({
      level: "error",
      feedId: "de-keyed-events",
    });
  });

  test("a group of settings is a non-empty group whose every field has a default", () => {
    expect(isSettingsGroup({ url: { title: "URL", default: "https://x.test" } })).toBe(true);
    expect(
      isSettingsGroup({ url: { title: "URL", default: "https://x.test" }, k: { title: "K" } }),
    ).toBe(false);
    expect(isSettingsGroup({})).toBe(false);
    // An empty group is a credential group: it must serve two feeds.
    expect(messages([file([def()])], { groups: { empty: {} } })).toEqual([
      "shared group empty is used by 0 feeds; a group serves at least two",
    ]);
  });

  test("a group of settings, every field with a default, may serve one feed but not none", () => {
    const settings: SharedCredentials = {
      groups: { overpass: { url: { title: "Overpass URL", default: "https://overpass.test/" } } },
    };
    const reader = def({
      homepage: "https://op.example",
      endpoints: { main: { url: "${@overpass.url}", cadenceSec: 300 } },
    });
    expect(messages([file([reader])], settings)).toEqual([]);
    expect(messages([file([def()])], settings)).toEqual([
      "shared group overpass is used by 0 feeds; a group of settings serves at least one",
    ]);
    // A field without a default is a credential: its group still serves two.
    const keyed: SharedCredentials = {
      groups: {
        overpass: {
          url: { title: "Overpass URL", default: "https://overpass.test/" },
          key: { title: "Overpass key" },
        },
      },
    };
    const both = def({
      homepage: "https://op.example",
      endpoints: { main: { url: "${@overpass.url}?k=${@overpass.key}", cadenceSec: 300 } },
    });
    expect(messages([file([both])], keyed)).toEqual([
      "shared group overpass is used by 1 feed; a group serves at least two",
    ]);
  });

  test("a feed read from a settings base URL needs a written homepage", () => {
    // A self-hosted base is the instance's own service, not the publisher's
    // site, and may well be plain http.
    const settings: SharedCredentials = {
      groups: { overpass: { url: { title: "Overpass URL", default: "https://overpass.test/" } } },
    };
    const reader = def({ endpoints: { main: { url: "${@overpass.url}/api", cadenceSec: 300 } } });
    expect(messages([file([reader])], settings)).toEqual([
      expect.stringMatching(/needs a written homepage/),
    ]);
    expect(messages([file([{ ...reader, homepage: "https://op.example" }])], settings)).toEqual([]);
  });

  test("duplicate ids across files and domains name both files", () => {
    const issues = lintCatalog(
      [
        file([def()], { path: "feeds/roads/xx.jsonc", region: "xx" }),
        file([def()], {
          path: "feeds/other/xx.jsonc",
          domain: "other",
          region: "xx",
          $schema: "../schema/other.schema.json",
        }),
      ],
      NO_SHARED,
      [testDomain, otherDomain],
      NOW,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        level: "error",
        feedId: "xx-op-events",
        message: expect.stringMatching(/feeds\/roads\/xx\.jsonc.*feeds\/other\/xx\.jsonc/),
      }),
    ]);
  });

  test("products and formats come from the domain", () => {
    expect(messages([file([def({ product: "parking" })])])).toEqual(
      expect.arrayContaining([expect.stringMatching(/product parking is not a roads product/)]),
    );
    expect(messages([file([def({ format: "ocpi" })])])).toEqual([
      expect.stringMatching(/format ocpi is unknown to domain roads/),
    ]);
    expect(messages([file([def({ product: "conditions" })])])).toEqual([
      expect.stringMatching(/format datex2 does not serve product conditions/),
    ]);
  });

  test("a format, role or credential named like an Object member is still unknown", () => {
    expect(messages([file([def({ format: "toString" })])])).toEqual([
      expect.stringMatching(/format toString is unknown to domain roads/),
    ]);
    const url = "https://example.test/x";
    expect(
      messages([
        file([
          def({
            endpoints: { main: { url, cadenceSec: 60 }, constructor: { url, cadenceSec: 60 } },
          }),
        ]),
      ]),
    ).toEqual([expect.stringMatching(/format datex2 has no endpoint role constructor/)]);
    expect(
      messages([file([def({ auth: { kind: "bearer", credential: "constructor" } })])]),
    ).toEqual([expect.stringMatching(/credential constructor is neither/)]);
    expect(
      messages([file([def({ auth: { kind: "bearer", credential: "@grp.constructor" } })])], {
        groups: { grp: { token: { title: "Token" } } },
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/credential @grp.constructor is neither/)]),
    );
  });

  test("endpoint roles and decoders follow the format", () => {
    const url = "https://example.test/x";
    expect(
      messages([
        file([def({ endpoints: { sites: { url, decoder: "datex2-sites", cadenceSec: 60 } } })]),
      ]),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/required endpoint main is missing/)]));
    expect(
      messages([
        file([
          def({ endpoints: { main: { url, cadenceSec: 60 }, extra: { url, cadenceSec: 60 } } }),
        ]),
      ]),
    ).toEqual([expect.stringMatching(/format datex2 has no endpoint role extra/)]);
    expect(
      messages([
        file([
          def({
            endpoints: {
              main: { url, cadenceSec: 60 },
              sites: { url, decoder: "datex2-stations", cadenceSec: 60 },
            },
          }),
        ]),
      ]),
    ).toEqual([expect.stringMatching(/decoder datex2-stations is not one of datex2-sites/)]);
    expect(
      messages([
        file([def({ endpoints: { main: { url, decoder: "datex2-sites", cadenceSec: 60 } } })]),
      ]),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/endpoint main takes no decoder/)]));
    expect(
      messages([
        file([
          def({ endpoints: { main: { url, cadenceSec: 60 }, sites: { url, cadenceSec: 60 } } }),
        ]),
      ]),
    ).toEqual([expect.stringMatching(/endpoint sites needs a decoder/)]);
  });

  test("every credential ref must be declared, placeholders included", () => {
    expect(
      messages([
        file([
          def({
            endpoints: {
              main: { url: "https://example.test/feed?home=${HOME}", cadenceSec: 300 },
            },
          }),
        ]),
      ]),
    ).toEqual([
      expect.stringMatching(/credential HOME is neither a feed field nor a shared field/),
    ]);
    expect(messages([file([def({ auth: { kind: "bearer", credential: "token" } })])])).toEqual([
      expect.stringMatching(/credential token is neither/),
    ]);
    expect(
      messages([
        file([
          def({
            endpoints: {
              main: { url: "https://example.test/${ids}", expand: "ids", cadenceSec: 60 },
            },
          }),
        ]),
      ]),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/credential ids is neither/)]));
    const shared = { groups: { grp: { cert: { title: "Cert" } } } };
    const twoUsers = [
      def({ operator: "a", auth: { kind: "bearer", credential: "@grp.cert" } }),
      def({ operator: "b", auth: { kind: "bearer", credential: "@grp.key" } }),
    ];
    expect(messages([file(twoUsers)], shared)).toEqual([
      expect.stringMatching(/credential @grp\.key is neither/),
    ]);
  });

  test("a declared, used credential and a shared group of two pass", () => {
    const shared = { groups: { grp: { cert: { title: "Cert" } } } };
    const feeds = [
      def({
        operator: "a",
        credentials: { api_key: { title: "Key" } },
        endpoints: { main: { url: "https://example.test/?k=${api_key}", cadenceSec: 60 } },
        auth: { kind: "mtls", cert: "@grp.cert", key: "@grp.cert" },
      }),
      def({ operator: "b", auth: { kind: "bearer", credential: "@grp.cert" } }),
    ];
    expect(lintCatalog([file(feeds)], shared, [testDomain], NOW)).toEqual([]);
  });

  test("two credentials whose env names coincide are an error naming both", () => {
    const keyed = (over: Partial<FeedDefinition>, field: string) =>
      def({
        ...over,
        credentials: { [field]: { title: "Key" } },
        auth: { kind: "bearer", credential: field },
      });
    const feeds = [
      keyed({ product: "flow" }, "events_k"),
      keyed({ qualifier: "flow", product: "events" }, "k"),
    ];
    const issues = lintCatalog([file(feeds)], NO_SHARED, [testDomain], NOW);
    expect(issues).toEqual([
      expect.objectContaining({
        level: "error",
        feedId: "de-op-flow-events",
        message: expect.stringMatching(
          /DE_OP_FLOW_EVENTS_K.*feed de-op-flow field events_k.*feed de-op-flow-events field k/,
        ),
      }),
    ]);

    const shared = { groups: { "de-op": { flow_k: { title: "Key" } } } };
    const sharedUsers = [
      def({ operator: "a", auth: { kind: "bearer", credential: "@de-op.flow_k" } }),
      def({ operator: "b", auth: { kind: "bearer", credential: "@de-op.flow_k" } }),
    ];
    expect(messages([file([...sharedUsers, keyed({ product: "flow" }, "k")])], shared)).toEqual([
      expect.stringMatching(/DE_OP_FLOW_K.*shared field @de-op\.flow_k.*feed de-op-flow field k/),
    ]);
  });

  test("two shared fields whose env names coincide are an error naming both", () => {
    const shared = {
      groups: { "de-op": { flow_k: { title: "Key" } }, "de-op-flow": { k: { title: "Key" } } },
    };
    const feeds = [
      def({ operator: "a", auth: { kind: "bearer", credential: "@de-op.flow_k" } }),
      def({ operator: "b", auth: { kind: "bearer", credential: "@de-op.flow_k" } }),
      def({ operator: "c", auth: { kind: "bearer", credential: "@de-op-flow.k" } }),
      def({ operator: "d", auth: { kind: "bearer", credential: "@de-op-flow.k" } }),
    ];
    expect(messages([file(feeds)], shared)).toEqual([
      expect.stringMatching(
        /DE_OP_FLOW_K.*shared field @de-op\.flow_k.*shared field @de-op-flow\.k/,
      ),
    ]);
  });

  test("a field whose env name is another credential's _FILE variant is a collision", () => {
    const feed = def({
      credentials: { k: { title: "Key" }, k_file: { title: "Not a file" } },
      endpoints: { main: { url: "https://example.test/?a=${k}&b=${k_file}", cadenceSec: 60 } },
    });
    expect(messages([file([feed])])).toEqual([
      expect.stringMatching(
        /DE_OP_EVENTS_K_FILE.*feed de-op-events field k \(as DE_OP_EVENTS_K_FILE\).*feed de-op-events field k_file/,
      ),
    ]);
  });

  test("a catalogue child's own credential is named by its parent and collides as such", () => {
    const registry = testDomainWith([
      {
        id: "registry",
        snapshotPath: "/unused",
        snapshot: [
          {
            qualifier: "x",
            name: "x",
            endpoints: { main: { url: "https://example.test/x", cadenceSec: 60 } },
            credentials: { events_k: { title: "Key" } },
            auth: { kind: "bearer", credential: "events_k" },
            selectionState: "discovered",
          },
        ],
        resolve: async () => [],
      },
    ]);
    const parent = def({ operator: "reg", product: "flow", catalog: { resolver: "registry" } });
    expect(messages([file([parent])], NO_SHARED, [registry])).toEqual([]);
    const other = def({
      operator: "reg",
      qualifier: "flow",
      credentials: { k: { title: "Key" } },
      auth: { kind: "bearer", credential: "k" },
    });
    expect(messages([file([parent, other])], NO_SHARED, [registry])).toEqual([
      expect.stringMatching(
        /DE_REG_FLOW_EVENTS_K.*feed de-reg-flow field events_k.*feed de-reg-flow-events field k/,
      ),
    ]);
  });

  test("fetch options an endpoint would silently ignore are errors", () => {
    const streamed = defineIngestDomain({
      id: "roads",
      products: ["events"],
      feedShape: feedBaseShape,
      formats: {
        datex2: {
          id: "datex2",
          kind: "situations",
          products: ["events"],
          endpoints: { main: { required: true }, sites: { required: false, decoders: ["d"] } },
          parse: () => emptyParseOutput(),
          stream: { read: async () => ({ output: emptyParseOutput(), payload: {} as never }) },
        },
      },
      resolvers: [],
    });
    const feed = def({
      endpoints: {
        main: {
          url: "https://example.test/x",
          cadenceSec: 60,
          pagination: { skipParam: "offset", pageSize: 10 },
        },
        sites: {
          url: "https://example.test/sites",
          cadenceSec: 3600,
          decoder: "d",
          follow: { path: "u" },
        },
      },
    });
    expect(messages([file([feed])], NO_SHARED, [streamed])).toEqual([
      "endpoint main is streamed, which ignores pagination",
      "endpoint sites is reference data, which ignores follow",
    ]);
    const capturing = def({
      endpoints: {
        main: { url: "https://example.test/x", cadenceSec: 60, follow: { pattern: "href=\\S+" } },
      },
    });
    expect(messages([file([capturing])])).toEqual([
      "endpoint main follow.pattern has no capture group for the URL",
    ]);
  });

  test("a per-item endpoint reads a fetched data role of its own feed", () => {
    const perItem = defineIngestDomain({
      id: "roads",
      products: ["events"],
      feedShape: feedBaseShape,
      formats: {
        datex2: {
          id: "datex2",
          kind: "situations",
          products: ["events"],
          endpoints: {
            main: { required: true },
            details: { required: false },
            more: { required: false },
            sites: { required: false, decoders: ["d"] },
          },
          parse: () => emptyParseOutput(),
        },
      },
      resolvers: [],
    });
    const item = (role: string) => ({
      url: "https://example.test/x/{item}",
      cadenceSec: 60,
      each: { role, records: "a", field: "id" },
    });
    const plain = { url: "https://example.test/x", cadenceSec: 60 };
    const check = (endpoints: FeedDefinition["endpoints"]) =>
      messages([file([def({ endpoints })])], NO_SHARED, [perItem]);

    expect(check({ main: plain, details: item("main") })).toEqual([]);
    expect(check({ main: plain, details: item("nope") })).toEqual([
      "endpoint details each names nope, which is not a role",
    ]);
    expect(check({ main: plain, details: item("details") })).toEqual([
      "endpoint details each cannot read its own payload",
    ]);
    expect(
      check({ main: plain, sites: { ...plain, decoder: "d" }, details: item("sites") }),
    ).toEqual(["endpoint details each reads sites, which is reference data"]);
    expect(check({ main: plain, details: item("main"), more: item("details") })).toEqual([
      "endpoint more each reads details, which is itself per-item",
    ]);

    // An on-demand cell fetch and a catalogue's resolved children never run
    // a per-item role: it would be silently left unfetched.
    const onDemand = messages(
      [
        file([
          def({
            accessMode: "on_demand",
            endpoints: { main: plain, details: item("main") },
          }),
        ]),
      ],
      NO_SHARED,
      [perItem],
    );
    expect(onDemand).toEqual(
      expect.arrayContaining(["endpoint details each cannot be used by an on_demand feed"]),
    );
    const catalogue = messages(
      [
        file([
          def({
            catalog: { resolver: "registry" },
            endpoints: { main: plain, details: item("main") },
          }),
        ]),
      ],
      NO_SHARED,
      [perItem],
    );
    expect(catalogue).toEqual(
      expect.arrayContaining(["endpoint details each cannot be used by a catalogue feed"]),
    );
  });

  test("a catalogue parent's endpoints cannot follow or impersonate", () => {
    const registry = testDomainWith([
      { id: "registry", snapshotPath: "/unused", snapshot: [], resolve: async () => [] },
    ]);
    const parent = def({
      operator: "reg",
      product: "flow",
      catalog: { resolver: "registry" },
      endpoints: {
        main: {
          url: "https://example.test/x",
          cadenceSec: 60,
          follow: { path: "u" },
          impersonate: true,
        },
      },
    });
    expect(messages([file([parent])], NO_SHARED, [registry])).toEqual([
      "catalogue feed endpoint main cannot use follow",
      "catalogue feed endpoint main cannot use impersonate",
    ]);
  });

  test("licences must be known, and NOASSERTION needs terms", () => {
    expect(messages([file([def({ license: "cc-by-4.0" })])])).toEqual([
      expect.stringMatching(/unknown licence cc-by-4\.0/),
    ]);
    expect(messages([file([def({ license: "NOASSERTION" })])])).toEqual([
      expect.stringMatching(/NOASSERTION needs terms/),
    ]);
    expect(
      messages([file([def({ license: "NOASSERTION", terms: { note: "no licence stated" } })])]),
    ).toEqual([]);
  });

  test("static URLs must be public and $schema must name the domain schema", () => {
    expect(
      messages([
        file([
          def({
            homepage: "https://op.example",
            endpoints: { main: { url: "http://10.0.0.1/feed", cadenceSec: 60 } },
          }),
        ]),
      ]),
    ).toEqual([
      expect.stringMatching(/endpoint main URL http:\/\/10\.0\.0\.1\/feed is not public/),
    ]);
    expect(messages([file([def()], { $schema: "../schema/parking.schema.json" })])).toEqual([
      expect.stringMatching(/\$schema must be "\.\.\/schema\/roads\.schema\.json"/),
    ]);
    expect(messages([file([def()], { $schema: undefined })])).toHaveLength(1);
  });

  test("disabled.since may not be in the future", () => {
    expect(messages([file([def({ disabled: { reason: "gone", since: "2026-10-04" } })])])).toEqual([
      expect.stringMatching(/disabled\.since 2026-10-04 is in the future/),
    ]);
    expect(messages([file([def({ disabled: { reason: "gone", since: "2026-10-03" } })])])).toEqual(
      [],
    );
  });

  test("a feed without a data endpoint is an error", () => {
    expect(
      messages([
        file([
          def({
            endpoints: {
              sites: { url: "https://example.test/s", decoder: "datex2-sites", cadenceSec: 60 },
            },
          }),
        ]),
      ]),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/no data endpoint/)]));
  });

  describe("catalogue children", () => {
    const child = (qualifier: string, approved: boolean, license?: string): ChildFeed => ({
      qualifier,
      name: qualifier,
      endpoints: { main: { url: `https://example.test/${qualifier}`, cadenceSec: 60 } },
      selectionState: approved ? "approved" : "discovered",
      ...(license ? { license } : {}),
      ...(approved ? { terms: { note: "reviewed", reviewedAt: "2026-09-11" } } : {}),
    });
    const domain = (snapshot: ChildFeed[]) =>
      testDomainWith([
        { id: "registry", snapshotPath: "/unused", snapshot, resolve: async () => [] },
      ]);
    const parent = (approvedChildren?: string[]) =>
      def({ operator: "reg", catalog: { resolver: "registry", approvedChildren } });

    test("an unknown resolver is an error", () => {
      expect(messages([file([parent()])])).toEqual([
        expect.stringMatching(/no catalogue resolver "registry"/),
      ]);
    });

    test("a resolver serves one parent; a second one is an error naming both", () => {
      const second = def({ operator: "reg2", catalog: { resolver: "registry" } });
      const issues = lintCatalog(
        [file([parent()]), file([second], { path: "feeds/roads/at.jsonc", region: "at" })],
        NO_SHARED,
        [domain([child("good", false)])],
        NOW,
      ).filter((i) => i.level === "error");
      expect(issues).toEqual([
        expect.objectContaining({
          file: "feeds/roads/at.jsonc",
          feedId: "at-reg2-events",
          message: expect.stringMatching(
            /resolver registry is already named by de-reg-events \(feeds\/roads\/de\.jsonc\)/,
          ),
        }),
      ]);
    });

    test("a parent whose registry is not one usable main URL is an error", () => {
      const reg = domain([child("good", false)]);
      const withMain = (main: object) =>
        def({ operator: "reg", catalog: { resolver: "registry" }, endpoints: { main } as never });
      expect(
        messages(
          [file([withMain({ urls: ["https://example.test/a"], cadenceSec: 60 })])],
          NO_SHARED,
          [reg],
        ),
      ).toEqual([expect.stringMatching(/registry: a catalogue parent names its registry/)]);
      expect(
        messages(
          [
            file([
              withMain({ url: "https://example.test/${token}", expand: "token", cadenceSec: 60 }),
            ]),
          ],
          NO_SHARED,
          [reg],
        ),
      ).toEqual(
        expect.arrayContaining([expect.stringMatching(/registry: .*not a usable registry URL/)]),
      );
      expect(
        messages([file([withMain({ url: "https://example.test/r", cadenceSec: 60 })])], NO_SHARED, [
          reg,
        ]),
      ).toEqual([]);
    });

    test("a discovered child that cannot be resolved is a warning naming resolver and child", () => {
      const issues = lintCatalog(
        [file([parent(["de-reg-good-events"])])],
        NO_SHARED,
        [domain([child("good", true), child("odd", false, "Not-A-Licence")])],
        NOW,
      );
      expect(issues).toEqual([
        {
          level: "warning",
          file: "feeds/roads/de.jsonc",
          feedId: "de-reg-odd-events",
          message: expect.stringMatching(/registry.*de-reg-odd-events.*unknown licence/),
        },
      ]);
    });

    test("an approved child that cannot be resolved is an error", () => {
      expect(
        messages([file([parent(["de-reg-odd-events"])])], NO_SHARED, [
          domain([child("odd", true, "Not-A-Licence")]),
        ]),
      ).toEqual([expect.stringMatching(/de-reg-odd-events.*unknown licence/)]);
    });
  });

  test("a domain's own feed checks are errors of the lint, disabled feeds included", () => {
    const checked: IngestDomain = {
      ...testDomain,
      lintFeed: (feed) => (feed.name.startsWith("Bad") ? [`${feed.name} is bad`] : []),
    };
    const issues = lintCatalog(
      [file([def({ name: "Bad feed", disabled: { reason: "off", since: "2026-10-01" } })])],
      NO_SHARED,
      [checked],
      NOW,
    );
    expect(issues).toEqual([
      {
        level: "error",
        file: "feeds/roads/de.jsonc",
        feedId: "de-op-events",
        message: "Bad feed is bad",
      },
    ]);
    expect(messages([file([def()])], NO_SHARED, [checked])).toEqual([]);
  });

  describe("on-demand feeds", () => {
    const featuresFormat = (produces: boolean): FeedFormat => ({
      id: "overpass",
      kind: "features",
      products: ["events"],
      endpoints: { main: { required: true } },
      ...(produces ? { produces: { kinds: ["station"], properties: ["brand"] } } : {}),
      parse: () => emptyParseOutput(),
    });
    const onDemandDomain = (produces = true): IngestDomain =>
      defineIngestDomain({
        id: "roads",
        products: ["events"],
        feedShape: feedBaseShape,
        formats: {
          overpass: featuresFormat(produces),
          plain: { ...featuresFormat(true), id: "plain", kind: "situations" },
        },
        resolvers: [],
      });
    const BBOX: [number, number, number, number] = [5, 47, 15, 55];
    const ON_DEMAND = { cellDeg: 0.25, ttlSec: 600, maxCellsPerRead: 8, probe: [13.4, 52.5] };
    const cellUrl = "https://example.test/list?lat={lat}&lon={lon}&r={radiusKm}";
    const onDemand = (over: Partial<FeedDefinition> = {}): FeedDefinition =>
      def({
        format: "overpass",
        accessMode: "on_demand",
        onDemand: ON_DEMAND as FeedDefinition["onDemand"],
        coverage: { bbox: BBOX },
        endpoints: { main: { url: cellUrl, cadenceSec: 300 } },
        ...over,
      });
    const lint = (feed: FeedDefinition, produces = true) =>
      messages([file([feed])], NO_SHARED, [onDemandDomain(produces)]);

    test("a complete on-demand feed is clean", () => {
      expect(lint(onDemand())).toEqual([]);
    });

    test("lint rejects an on-demand feed without onDemand, coverage.bbox or a produces-declaring features format", () => {
      expect(lint(onDemand({ onDemand: undefined }))).toEqual([
        expect.stringMatching(/on_demand feed needs onDemand/),
      ]);
      expect(lint(onDemand({ coverage: { countries: ["DE"] } }))).toEqual([
        expect.stringMatching(/on_demand feed needs coverage\.bbox/),
      ]);
      expect(lint(onDemand(), false)).toEqual([
        expect.stringMatching(/format overpass must be a features format that declares produces/),
      ]);
      expect(lint(onDemand({ format: "plain" }))).toEqual([
        expect.stringMatching(/format plain must be a features format that declares produces/),
      ]);
    });

    test("a bulk feed may not carry onDemand", () => {
      const staticEndpoints = { main: { url: "https://example.test/all", cadenceSec: 300 } };
      for (const accessMode of ["bulk", undefined] as const) {
        expect(lint(onDemand({ accessMode, endpoints: staticEndpoints }))).toEqual([
          expect.stringMatching(/bulk feed cannot have onDemand/),
        ]);
      }
    });

    test("lint rejects cell placeholders in a bulk feed", () => {
      expect(
        lint(
          def({
            format: "overpass",
            endpoints: { main: { url: cellUrl, cadenceSec: 300 } },
          }),
        ),
      ).toEqual([expect.stringMatching(/bulk feed endpoint main uses a cell placeholder/)]);
    });

    test("an on-demand feed needs a data endpoint that uses a cell placeholder", () => {
      expect(
        lint(
          onDemand({ endpoints: { main: { url: "https://example.test/all", cadenceSec: 300 } } }),
        ),
      ).toEqual([expect.stringMatching(/needs a data endpoint that uses a cell placeholder/)]);
    });

    test("a probe outside coverage.bbox is an issue", () => {
      expect(
        lint(
          onDemand({
            onDemand: { ...ON_DEMAND, probe: [100, 52.5] } as FeedDefinition["onDemand"],
          }),
        ),
      ).toEqual([expect.stringMatching(/probe outside coverage\.bbox/)]);
    });

    test("lint rejects a cell larger than the source's radius limit", () => {
      expect(
        lint(
          onDemand({
            onDemand: { ...ON_DEMAND, cellDeg: 0.5 } as FeedDefinition["onDemand"],
            requestLimits: { maxRadiusKm: 25 },
          }),
        ),
      ).toEqual([
        expect.stringMatching(/maxRadiusKm 25 is below the 39\.\d km radius of a 0\.5 degree cell/),
      ]);
      expect(lint(onDemand({ requestLimits: { maxRadiusKm: 25 } }))).toEqual([]);
    });
  });
});
