import { describe, expect, it } from "vitest";
import {
  feedEnvVars,
  envExampleFor,
  configSchemaPropertiesFor,
} from "../lib/gen-credentials-lib.js";
import type { FeedSourceBase } from "@openconditions/ingest-framework";

const ny: FeedSourceBase = {
  id: "ny-511",
  name: "511NY (New York)",
  format: "ibi511-json",
  url: "https://511ny.org/api/v2/get/event?format=json",
  auth: { kind: "query-key", param: "key", envVar: "NY_511_API_KEY" },
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "511NY-DAA",
  attribution: "Powered by 511NY",
  country: "US",
  privacyUrl: "https://511ny.org/privacy",
  enabledByDefault: true,
  setup: {
    NY_511_API_KEY: {
      title: "511NY API key (New York)",
      description: "Query key.",
      url: "https://511ny.org/my511/register",
      cost: "Free",
    },
  },
};

describe("gen-credentials-lib", () => {
  it("extracts the env vars a feed needs", () => {
    expect(feedEnvVars(ny)).toEqual(["NY_511_API_KEY"]);
  });

  it("emits an .env.example section with a header comment + the var", () => {
    const out = envExampleFor([ny]);
    expect(out).toContain("# 511NY (New York)");
    expect(out).toContain("NY_511_API_KEY=");
  });

  it("emits a configSchema property matching the admin-panel contract", () => {
    const props = configSchemaPropertiesFor([ny]);
    expect(props["NY_511_API_KEY"]).toEqual({
      type: "string",
      title: "511NY API key (New York)",
      description: "Query key.",
      "x-openmapx-secret": true,
      "x-openmapx-setup": { url: "https://511ny.org/my511/register", cost: "Free" },
    });
  });
});
