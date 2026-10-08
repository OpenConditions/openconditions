import {
  type CatalogFeed,
  type FeedDefinition,
  type SharedCredentials,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import {
  type CredentialCatalog,
  configSchemaPropertiesFor,
  credentialsDocFor,
  envExampleFor,
} from "../lib/gen-credentials-lib.js";

function feed(over: Partial<FeedDefinition>, region = "us"): CatalogFeed {
  const def: FeedDefinition = {
    operator: "test",
    product: "events",
    name: "Test",
    format: "geojson",
    tier: "authoritative",
    endpoints: { main: { url: "https://example.org/feed", cadenceSec: 300 } },
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "t",
    privacyUrl: "https://example.org/privacy",
    ...over,
  };
  return toCatalogFeed(def, { domain: "roads", region, file: "f.jsonc", maintainers: [] });
}

const ny = feed({
  subdivision: "ny",
  operator: "511",
  name: "511NY (New York)",
  license: "LicenseRef-511NY-DAA",
  credentials: {
    api_key: {
      title: "511NY API key (New York)",
      description: "Query key.",
      setup: { url: "https://511ny.org/my511/register", cost: "Free" },
    },
  },
  auth: { kind: "query-key", param: "key", credential: "api_key" },
});

const shared: SharedCredentials = {
  groups: {
    mobilithek: {
      cert: {
        title: "Mobilithek certificate",
        setup: { url: "https://mobilithek.info", urlLabel: "Mobilithek" },
      },
      key: { title: "Mobilithek key" },
    },
  },
};

const mobilithek = (subdivision: string) =>
  feed(
    {
      subdivision,
      operator: "mobilithek",
      name: `Mobilithek ${subdivision}`,
      endpoints: {
        main: { url: "https://m.example.org/${subscription_id}", cadenceSec: 300 },
      },
      credentials: { subscription_id: { title: `Subscription ${subdivision}` } },
      auth: { kind: "mtls", cert: "@mobilithek.cert", key: "@mobilithek.key" },
    },
    "de",
  );

const ofFeeds = (feeds: CatalogFeed[], credentials = shared): CredentialCatalog => ({
  feeds,
  credentials,
});

describe("gen-credentials-lib", () => {
  it("emits an .env.example block per keyed feed under its derived names", () => {
    const out = envExampleFor(ofFeeds([ny, feed({ operator: "open" })]));
    expect(out).toContain("# 511NY (New York) (us-ny-511-events)");
    expect(out).toContain("# Get credentials: https://511ny.org/my511/register");
    expect(out).toContain("US_NY_511_EVENTS_API_KEY=");
    expect(out).not.toContain("us-open-events");
  });

  it("emits a configSchema property matching the admin-panel contract", () => {
    const props = configSchemaPropertiesFor(ofFeeds([ny]));
    expect(props["US_NY_511_EVENTS_API_KEY"]).toEqual({
      type: "string",
      title: "511NY API key (New York)",
      description: "Query key.",
      "x-openmapx-secret": true,
      "x-openmapx-setup": { url: "https://511ny.org/my511/register", cost: "Free" },
    });
  });

  it("lists a disabled feed's credential, so access can be obtained before the feed is enabled", () => {
    const waiting = feed({
      subdivision: "ny",
      operator: "511",
      name: "511NY (New York)",
      license: "LicenseRef-511NY-DAA",
      credentials: ny.credentials!,
      auth: { kind: "query-key", param: "key", credential: "api_key" },
      disabled: { reason: "access is granted on request", since: "2026-10-08" },
    });
    const catalog: CredentialCatalog = { feeds: [], disabled: [waiting], credentials: shared };
    expect(configSchemaPropertiesFor(catalog)["US_NY_511_EVENTS_API_KEY"]).toMatchObject({
      "x-openmapx-setup": { url: "https://511ny.org/my511/register" },
    });
    expect(envExampleFor(catalog)).toContain(
      "# 511NY (New York) (us-ny-511-events), disabled: access is granted on request",
    );
    expect(credentialsDocFor(catalog, "openconditions-ingest")).toContain(
      "| 511NY (New York) (disabled) | `us-ny-511-events` |",
    );
  });

  it("emits the service's own secrets as vault fields without a default", () => {
    const props = configSchemaPropertiesFor(ofFeeds([]));
    for (const key of ["DATABASE_URL", "OPENCONDITIONS_OPERATOR_TOKEN"]) {
      expect(props[key]).toMatchObject({ type: "string", "x-openmapx-secret": true });
      expect(props[key]).not.toHaveProperty("default");
    }
  });

  it("emits the remote feed-delivery settings, and no mounted catalogue OpenMapX cannot mount", () => {
    const props = configSchemaPropertiesFor(ofFeeds([]));
    for (const key of ["OPENCONDITIONS_FEEDS_REMOTE_URL", "OPENCONDITIONS_FEEDS_REMOTE_ENABLED"]) {
      expect(props[key]).toMatchObject({ type: "string", "x-openmapx-secret": false });
    }
    expect(props).not.toHaveProperty("OPENCONDITIONS_FEEDS_DIR");
  });

  it("emits the instance id and the archive, tripwire and retention tunables, empty by default", () => {
    const props = configSchemaPropertiesFor(ofFeeds([]));
    for (const key of [
      "OPENCONDITIONS_INSTANCE_ID",
      "OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS",
      "OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO",
      "OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL",
      "OPENCONDITIONS_ROLLUP_HOURLY_DAYS",
      "ARCHIVE_CRON",
    ]) {
      expect(props[key], key).toMatchObject({ default: "", "x-openmapx-secret": false });
    }
  });

  it("emits a group of settings as non-secret configSchema fields with their defaults", () => {
    const settings: SharedCredentials = {
      groups: {
        overpass: {
          url: {
            title: "Overpass URL",
            description: "Interpreter.",
            default: "https://overpass.test/api",
          },
        },
      },
    };
    const osm = feed({
      operator: "osm",
      product: "fuel",
      name: "OSM fuel",
      homepage: "https://www.openstreetmap.org",
      endpoints: { main: { url: "${@overpass.url}", cadenceSec: 3600 } },
    });
    const catalog = {
      ...ofFeeds([osm, ny], settings),
      settingReaders: { overpass: ["osm-import", "osm-maxspeed"] },
    };
    // OpenMapX resolves a configSchema field (its default, else the admin
    // panel, else SERVICE_<ID>_<KEY>) into a community service's environment;
    // a `${VAR}` passthrough would reach it as a literal string.
    expect(configSchemaPropertiesFor(catalog)["OVERPASS_URL"]).toEqual({
      type: "string",
      title: "Overpass URL",
      description: "Interpreter.",
      default: "https://overpass.test/api",
      "x-openmapx-secret": false,
    });
    // Every reader is named, the feeds' and the rest.
    expect(envExampleFor(catalog)).toContain(
      "# Shared: overpass (us-osm-fuel, osm-import, osm-maxspeed)\n# Default: https://overpass.test/api\nOVERPASS_URL=",
    );
    // The credentials table lists no setting; the settings table does.
    const doc = credentialsDocFor(catalog, "openconditions-ingest");
    const [credentials, settingsTable] = doc.split("## Settings");
    expect(credentials).not.toContain("OVERPASS_URL");
    expect(credentials).not.toContain("us-osm-fuel");
    expect(credentials).toContain("`US_NY_511_EVENTS_API_KEY`");
    expect(settingsTable).toContain(
      "| `OVERPASS_URL` | `SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL` | `https://overpass.test/api` | `us-osm-fuel`, `osm-import`, `osm-maxspeed` | Interpreter. |",
    );
    // Without a setting there is no settings table, and no settings field.
    expect(credentialsDocFor(ofFeeds([ny]), "openconditions-ingest")).not.toContain("## Settings");
    expect(configSchemaPropertiesFor(ofFeeds([ny]))).not.toHaveProperty("OVERPASS_URL");
  });

  it("emits a shared group's fields once, with the group's setup guide", () => {
    const catalog = ofFeeds([mobilithek("hh"), mobilithek("by")]);
    const out = envExampleFor(catalog);
    expect(out).toContain(
      "# Shared: mobilithek (de-hh-mobilithek-events, de-by-mobilithek-events)",
    );
    expect(out).toContain("# Mobilithek: https://mobilithek.info");
    expect(out.split("MOBILITHEK_CERT=").length - 1).toBe(1);
    expect(out.split("MOBILITHEK_KEY=").length - 1).toBe(1);
    expect(out).toContain("DE_HH_MOBILITHEK_EVENTS_SUBSCRIPTION_ID=");
    expect(out).toContain("DE_BY_MOBILITHEK_EVENTS_SUBSCRIPTION_ID=");

    const props = configSchemaPropertiesFor(catalog) as Record<string, Record<string, unknown>>;
    expect(props["MOBILITHEK_CERT"]).toMatchObject({
      title: "Mobilithek certificate",
      "x-openmapx-setup": { url: "https://mobilithek.info", urlLabel: "Mobilithek" },
    });
    expect(props["MOBILITHEK_KEY"]).not.toHaveProperty("x-openmapx-setup");
  });

  it("names a catalogue child's credentials after its parent", () => {
    const child: CatalogFeed = { ...ny, id: "us-ny-511-x-events", parentSourceId: ny.id };
    const props = configSchemaPropertiesFor(ofFeeds([child]));
    expect(Object.keys(props)).toContain("US_NY_511_EVENTS_API_KEY");
    expect(Object.keys(props)).not.toContain("US_NY_511_X_EVENTS_API_KEY");
  });

  it("documents each keyed feed with its env vars, licence and guide", () => {
    const doc = credentialsDocFor(
      ofFeeds([ny, mobilithek("hh"), mobilithek("by")]),
      "openconditions-ingest",
    );
    expect(doc).toContain("> Generated by `pnpm gen:credentials`. Do not edit by hand.");
    expect(doc).toContain(
      "| 511NY (New York) | `us-ny-511-events` | `US_NY_511_EVENTS_API_KEY` | LicenseRef-511NY-DAA | [portal](https://511ny.org/my511/register) |",
    );
    expect(doc).toContain(
      "| `de-hh-mobilithek-events` | `MOBILITHEK_CERT`, `MOBILITHEK_KEY`, `DE_HH_MOBILITHEK_EVENTS_SUBSCRIPTION_ID` |",
    );
  });
});
