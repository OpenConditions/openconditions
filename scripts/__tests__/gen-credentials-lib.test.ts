import { describe, expect, it } from "vitest";
import {
  feedEnvVars,
  envExampleFor,
  configSchemaPropertiesFor,
} from "../lib/gen-credentials-lib.js";
import type { FeedSourceBase } from "@openconditions/ingest-framework";

const ny: FeedSourceBase = {
  id: "us-ny-511",
  name: "511NY (New York)",
  subdivision: "ny",
  operator: "511",
  format: "ibi511",
  url: "https://511ny.org/api/v2/get/event?format=json",
  auth: { kind: "query-key", param: "key", envVar: "US_NY_511_API_KEY" },
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "511NY-DAA",
  attribution: "Powered by 511NY",
  country: "US",
  privacyUrl: "https://511ny.org/privacy",
  setup: {
    US_NY_511_API_KEY: {
      title: "511NY API key (New York)",
      description: "Query key.",
      url: "https://511ny.org/my511/register",
      cost: "Free",
    },
  },
};

describe("gen-credentials-lib", () => {
  it("extracts the env vars a feed needs", () => {
    expect(feedEnvVars(ny)).toEqual(["US_NY_511_API_KEY"]);
  });

  it("emits an .env.example section with a header comment + the var", () => {
    const out = envExampleFor([ny]);
    expect(out).toContain("# 511NY (New York)");
    expect(out).toContain("US_NY_511_API_KEY=");
  });

  it("emits a configSchema property matching the admin-panel contract", () => {
    const props = configSchemaPropertiesFor([ny]);
    expect(props["US_NY_511_API_KEY"]).toEqual({
      type: "string",
      title: "511NY API key (New York)",
      description: "Query key.",
      "x-openmapx-secret": true,
      "x-openmapx-setup": { url: "https://511ny.org/my511/register", cost: "Free" },
    });
  });

  it("emits the layered feed-delivery settings as non-secret service settings", () => {
    const props = configSchemaPropertiesFor([]);
    for (const key of [
      "OPENCONDITIONS_FEEDS_DIR",
      "OPENCONDITIONS_FEEDS_REMOTE_URL",
      "OPENCONDITIONS_FEEDS_REMOTE_ENABLED",
    ]) {
      expect(props[key]).toMatchObject({ type: "string", "x-openmapx-secret": false });
    }
  });

  it("dedupes env vars shared across feeds (e.g. shared mTLS creds), emitting each once", () => {
    const feedA: FeedSourceBase = {
      id: "region-a",
      name: "Region A",
      operator: "test",
      format: "geojson",
      auth: { kind: "mtls", certEnvVar: "SHARED_CERT", keyEnvVar: "SHARED_KEY" },
      requiredEnv: ["A_ID"],
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "t",
      country: "DE",
      privacyUrl: "https://x",
    };
    const feedB: FeedSourceBase = {
      id: "region-b",
      name: "Region B",
      operator: "test",
      format: "geojson",
      auth: { kind: "mtls", certEnvVar: "SHARED_CERT", keyEnvVar: "SHARED_KEY" },
      requiredEnv: ["B_ID"],
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC0-1.0",
      attribution: "t",
      country: "DE",
      privacyUrl: "https://x",
    };
    const out = envExampleFor([feedA, feedB]);
    expect(out.split("SHARED_CERT=").length - 1).toBe(1);
    expect(out.split("SHARED_KEY=").length - 1).toBe(1);
    expect(out).toContain("A_ID=");
    expect(out).toContain("B_ID=");
  });
});

describe("configSchemaPropertiesFor — shared credentials", () => {
  const keyed = (id: string, name: string, setup?: Record<string, unknown>) =>
    ({
      id,
      name,
      operator: "t",
      format: "geojson",
      url: `https://x.test/${id}`,
      cadenceSec: 300,
      freshnessWindowSec: 900,
      license: "CC-BY-4.0",
      attribution: "t",
      country: "AU",
      privacyUrl: "https://x.test/privacy",
      auth: { kind: "header-key", header: "K", envVar: "SHARED_KEY" },
      ...(setup ? { setup } : {}),
    }) as never;

  it("keeps a guide contributed by one feed when a later feed shares the key without one", () => {
    const props = configSchemaPropertiesFor([
      keyed("with-guide", "Feed with guide", {
        SHARED_KEY: { title: "Portal key", url: "https://portal.test" },
      }),
      keyed("no-guide", "Feed without guide"),
    ]) as Record<string, { title: string; "x-openmapx-setup"?: unknown }>;

    expect(props.SHARED_KEY!.title).toBe("Portal key");
    expect(props.SHARED_KEY!["x-openmapx-setup"]).toMatchObject({ url: "https://portal.test" });
  });

  it("still scaffolds a placeholder when no feed declares a guide", () => {
    const props = configSchemaPropertiesFor([keyed("no-guide", "Feed without guide")]) as Record<
      string,
      { title: string }
    >;
    expect(props.SHARED_KEY!.title).toBe("Feed without guide — SHARED_KEY");
  });
});
