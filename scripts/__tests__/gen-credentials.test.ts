import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FeedDefinition, toCatalogFeed } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { loadIngestCatalog } from "../../services/ingest/src/domains.js";
import { applyOrCheck, nextEnvExample } from "../gen-credentials.js";
import { type CredentialCatalog, configSchemaPropertiesFor } from "../lib/gen-credentials-lib.js";

const keyed: FeedDefinition = {
  operator: "keyed",
  product: "events",
  name: "Keyed",
  format: "geojson",
  tier: "authoritative",
  endpoints: { main: { url: "https://example.org/feed", cadenceSec: 300 } },
  credentials: { token: { title: "K token" } },
  auth: { kind: "bearer", credential: "token" },
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "t",
  privacyUrl: "https://example.org/privacy",
};

const catalog: CredentialCatalog = {
  feeds: [
    toCatalogFeed(keyed, {
      domain: "roads",
      region: "nl",
      file: "feeds/roads/nl.jsonc",
      maintainers: [],
    }),
  ],
  credentials: { groups: {} },
};

const loadedRepoCatalog = await loadIngestCatalog({});

function paths() {
  const d = mkdtempSync(join(tmpdir(), "gencred-"));
  const service = join(d, "service.json");
  writeFileSync(
    service,
    JSON.stringify(
      {
        id: "openconditions-ingest",
        container: { image: "x" },
        configSchema: { properties: {} },
      },
      null,
      2,
    ),
  );
  return { envExample: join(d, ".env.example"), serviceJson: service, doc: join(d, "creds.md") };
}

function environmentOf(p: ReturnType<typeof paths>): Record<string, string> {
  return JSON.parse(readFileSync(p.serviceJson, "utf8")).container.environment;
}

function setEnvironment(p: ReturnType<typeof paths>, environment: Record<string, string>): void {
  const svc = JSON.parse(readFileSync(p.serviceJson, "utf8"));
  svc.container.environment = environment;
  writeFileSync(p.serviceJson, JSON.stringify(svc, null, 2));
}

describe("gen-credentials", () => {
  it("credentials are generated from derived names", () => {
    const props = configSchemaPropertiesFor(loadedRepoCatalog);
    expect(props).toHaveProperty("MOBILITHEK_CERT");
    expect(props).toHaveProperty("DE_HH_AUTOBAHN_FLOW_SUBSCRIPTION_ID");
    expect(props).not.toHaveProperty("DE_HH_AUTOBAHNNORD_SUBSCRIPTION_ID");
  });

  it("write mode produces files; a re-check then reports no drift", () => {
    const p = paths();
    expect(applyOrCheck(catalog, p, true).drift).toEqual([]);
    expect(readFileSync(p.envExample, "utf8")).toContain("NL_KEYED_EVENTS_TOKEN=");
    // service.json got the property spliced in, other keys preserved:
    const svc = JSON.parse(readFileSync(p.serviceJson, "utf8"));
    expect(svc.container.image).toBe("x");
    expect(svc.configSchema.properties.NL_KEYED_EVENTS_TOKEN["x-openmapx-secret"]).toBe(true);
    expect(svc.configSchema.properties.SEGMENT_REGIONS).toMatchObject({
      type: "string",
      "x-openmapx-secret": false,
    });
    expect(readFileSync(p.doc, "utf8")).toContain("`NL_KEYED_EVENTS_TOKEN`");
    // check mode is now a no-op (no drift):
    expect(applyOrCheck(catalog, p, false).drift).toEqual([]);
  });

  it("write mode emits the instance settings as non-secret config fields with their defaults", () => {
    const p = paths();
    setEnvironment(p, { PORT: "4100", MINE: "${MINE:-x}" });
    expect(applyOrCheck(loadedRepoCatalog, p, true).drift).toEqual([]);
    const svc = JSON.parse(readFileSync(p.serviceJson, "utf8"));
    expect(svc.configSchema.properties.OVERPASS_URL).toMatchObject({
      type: "string",
      default: "https://overpass-api.de",
      "x-openmapx-secret": false,
    });
    // The environment is hand-written: the generator leaves it as it is.
    expect(environmentOf(p)).toEqual({ PORT: "4100", MINE: "${MINE:-x}" });
    expect(applyOrCheck(loadedRepoCatalog, p, false).drift).toEqual([]);
  });

  it("check mode reports drift when a setting's config field is stale", () => {
    const p = paths();
    applyOrCheck(loadedRepoCatalog, p, true);
    const svc = JSON.parse(readFileSync(p.serviceJson, "utf8"));
    svc.configSchema.properties.OVERPASS_URL.default = "https://stale.test";
    writeFileSync(p.serviceJson, `${JSON.stringify(svc, null, 2)}\n`);
    expect(applyOrCheck(loadedRepoCatalog, p, false).drift).toEqual([p.serviceJson]);
  });

  it("an environment entry naming a config field is an error: OpenMapX would override it", () => {
    const p = paths();
    setEnvironment(p, { PORT: "4100", OVERPASS_URL: "${OVERPASS_URL:-https://overpass-api.de}" });
    expect(() => applyOrCheck(loadedRepoCatalog, p, false)).toThrow(
      /container\.environment OVERPASS_URL is a config field/,
    );
  });

  it("write mode emits the service's own fields beside the generated ones", () => {
    const p = paths();
    expect(applyOrCheck(catalog, p, true).drift).toEqual([]);
    const props = JSON.parse(readFileSync(p.serviceJson, "utf8")).configSchema.properties;
    expect(props.DATABASE_URL).toMatchObject({ type: "string", "x-openmapx-secret": true });
    expect(props.DATABASE_URL).not.toHaveProperty("default");
    expect(props.OPENCONDITIONS_OPERATOR_TOKEN).toMatchObject({ "x-openmapx-secret": true });
    expect(props.RATE_LIMIT_MAX).toMatchObject({ default: "120", "x-openmapx-secret": false });
    expect(props.SEGMENT_REGIONS).toMatchObject({ default: "", "x-openmapx-secret": false });
    expect(props.NL_KEYED_EVENTS_TOKEN).toMatchObject({ "x-openmapx-secret": true });
    expect(applyOrCheck(catalog, p, false).drift).toEqual([]);
  });

  it("an environment entry naming a service field is an error too", () => {
    const p = paths();
    setEnvironment(p, { PORT: "4100", DATABASE_URL: "postgresql://x" });
    expect(() => applyOrCheck(catalog, p, false)).toThrow(
      /container\.environment DATABASE_URL is a config field/,
    );
  });

  it("a feed credential named like a service field is an error", () => {
    const clashing: CredentialCatalog = {
      feeds: [
        toCatalogFeed(
          { ...keyed, auth: { kind: "bearer", credential: "@trust.proxy_cidrs" } },
          { domain: "roads", region: "nl", file: "feeds/roads/nl.jsonc", maintainers: [] },
        ),
      ],
      credentials: { groups: { trust: { proxy_cidrs: { title: "Clash" } } } },
    };
    expect(() => configSchemaPropertiesFor(clashing)).toThrow(/TRUST_PROXY_CIDRS/);
  });

  it("the settings table names the OpenMapX env form of each setting", () => {
    const p = paths();
    applyOrCheck(loadedRepoCatalog, p, true);
    expect(readFileSync(p.doc, "utf8")).toContain("`SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL`");
  });

  it("the repo's service.json passes no setting through its environment", () => {
    const svc = JSON.parse(
      readFileSync(new URL("../../services/ingest/service.json", import.meta.url), "utf8"),
    );
    expect(svc.container.environment).not.toHaveProperty("OVERPASS_URL");
    expect(svc.configSchema.properties.OVERPASS_URL).toMatchObject({
      default: "https://overpass-api.de",
      "x-openmapx-secret": false,
    });
  });

  it("check mode reports drift when a file is stale", () => {
    const p = paths();
    applyOrCheck(catalog, p, true);
    writeFileSync(p.envExample, "STALE\n");
    expect(applyOrCheck(catalog, p, false).drift.join()).toContain(".env.example");
  });

  it("seeds the committed service section when .env.example has lost its marker", () => {
    const committed = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const marker = "# === Feed credentials";
    const preamble = (text: string) => text.slice(0, text.indexOf(marker));
    expect(preamble(nextEnvExample("", catalog))).toBe(preamble(committed));
  });

  it("write mode preserves the hand-authored service section in .env.example", () => {
    const p = paths();
    applyOrCheck(catalog, p, true);
    const written = readFileSync(p.envExample, "utf8");
    expect(written).toContain("DATABASE_URL=");
    expect(written).toContain("OPENCONDITIONS_MAX_FEED_BYTES=");
    expect(written).toContain("OPENCONDITIONS_FEEDS_REMOTE_ENABLED=");
    expect(written).toContain("NL_KEYED_EVENTS_TOKEN=");
    expect(written).toContain(
      "# === Feed credentials — generated by `pnpm gen:credentials`; do not edit below this line ===",
    );
  });
});
