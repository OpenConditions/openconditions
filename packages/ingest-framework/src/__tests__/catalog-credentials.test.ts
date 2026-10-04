import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  credentialEnvName,
  feedCredentialNames,
  requireCredential,
  resolveCredential,
  strictCredential,
} from "../catalog/credentials.js";
import type { CatalogFeed } from "../catalog/types.js";

function feed(partial: Partial<CatalogFeed>): CatalogFeed {
  return {
    id: "de-hh-autobahn-flow",
    domain: "roads",
    region: "de",
    country: "DE",
    file: "feeds/roads/de.jsonc",
    maintainers: [],
    operator: "autobahn",
    product: "flow",
    name: "n",
    format: "datex2",
    tier: "authoritative",
    endpoints: { main: { url: "https://a", cadenceSec: 60 } },
    freshnessWindowSec: 300,
    license: "CC0-1.0",
    attribution: "a",
    privacyUrl: "https://p",
    rights: {
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      attributionRequired: false,
      retention: true,
      shareAlike: false,
    },
    coverage: {},
    cadenceSec: 60,
    ...partial,
  } as CatalogFeed;
}

describe("credentials", () => {
  test("credential env names are derived", () => {
    expect(credentialEnvName("de-hh-autobahn-flow", "sites_subscription_id")).toBe(
      "DE_HH_AUTOBAHN_FLOW_SITES_SUBSCRIPTION_ID",
    );
    expect(credentialEnvName("de-hh-autobahn-flow", "@mobilithek.cert")).toBe("MOBILITHEK_CERT");
    expect(credentialEnvName("us-oh-ohgo-flow", "@us-oh-ohgo.api_key")).toBe("US_OH_OHGO_API_KEY");
  });

  test("a shared ref that is not @group.field has no env name", () => {
    for (const ref of ["@mobilithek", "@mobilithek.", "@.cert", "@mobilithek.cert.pem"]) {
      expect(() => credentialEnvName("de-hh-autobahn-flow", ref), ref).toThrow(
        /not a shared credential ref/,
      );
    }
  });

  test("mTLS CA honours the _FILE variant", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cred-"));
    const file = join(dir, "ca.pem");
    writeFileSync(file, "  -----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n\n");
    const env = { MOBILITHEK_CA_FILE: file };
    expect(resolveCredential(env, "MOBILITHEK_CA")).toBe(
      "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
    );
    expect(resolveCredential({ MOBILITHEK_CA: "  direct ", ...env }, "MOBILITHEK_CA")).toBe(
      "direct",
    );
    expect(resolveCredential({}, "MOBILITHEK_CA")).toBeUndefined();
  });

  test("a required service secret is read from its _FILE variant and named when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cred-"));
    const file = join(dir, "DATABASE_URL");
    writeFileSync(file, "postgresql://postgres:pw@postgis:5432/openmapx\n");
    expect(requireCredential({ DATABASE_URL_FILE: file }, "DATABASE_URL")).toBe(
      "postgresql://postgres:pw@postgis:5432/openmapx",
    );
    expect(() => requireCredential({ DATABASE_URL: " " }, "DATABASE_URL")).toThrow(
      /DATABASE_URL is required.*DATABASE_URL_FILE/,
    );
  });

  test("a service secret whose _FILE is set but unreadable or empty names the file and why", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cred-"));
    const missing = join(dir, "absent");
    expect(() => requireCredential({ DATABASE_URL_FILE: missing }, "DATABASE_URL")).toThrow(
      new RegExp(`DATABASE_URL_FILE .*${missing}.*ENOENT`),
    );
    expect(() => strictCredential({ DATABASE_URL_FILE: missing }, "DATABASE_URL")).toThrow(
      /ENOENT/,
    );
    const empty = join(dir, "empty");
    writeFileSync(empty, " \n");
    expect(() => requireCredential({ DATABASE_URL_FILE: empty }, "DATABASE_URL")).toThrow(
      new RegExp(`DATABASE_URL_FILE .*${empty}.*empty`),
    );
    // Neither set: an optional secret is simply absent.
    expect(strictCredential({}, "DATABASE_URL")).toBeUndefined();
    // A feed credential keeps the lenient read: the scheduler skips the feed.
    expect(resolveCredential({ DATABASE_URL_FILE: missing }, "DATABASE_URL")).toBeUndefined();
  });

  test("names cover auth, template and expand references", () => {
    const names = feedCredentialNames(
      feed({
        credentials: {
          api_key: { title: "Key" },
          region: { title: "Region", optional: true, default: "eu" },
          subs: { title: "Subs" },
        },
        auth: { kind: "query-key", param: "k", credential: "api_key" },
        endpoints: {
          main: {
            urls: ["https://a/${region}/${@shared.token}"],
            headers: { "X-A": "${api_key}" },
            body: "${region}",
            expand: "subs",
            fanout: "all",
            cadenceSec: 60,
          },
        },
      }),
    );
    expect(names).toEqual([
      { ref: "api_key", env: "DE_HH_AUTOBAHN_FLOW_API_KEY", optional: false },
      { ref: "region", env: "DE_HH_AUTOBAHN_FLOW_REGION", optional: true, default: "eu" },
      { ref: "@shared.token", env: "SHARED_TOKEN", optional: false },
      { ref: "subs", env: "DE_HH_AUTOBAHN_FLOW_SUBS", optional: false },
    ]);
  });

  test("a catalogue child uses its parent's names; mtls ca is optional", () => {
    const names = feedCredentialNames(
      feed({
        id: "de-child-x-events",
        parentSourceId: "de-parent-x-events",
        auth: {
          kind: "mtls",
          cert: "@mobilithek.cert",
          key: "@mobilithek.key",
          ca: "@mobilithek.ca",
        },
      }),
    );
    expect(names.map((n) => [n.env, n.optional])).toEqual([
      ["MOBILITHEK_CERT", false],
      ["MOBILITHEK_KEY", false],
      ["MOBILITHEK_CA", true],
    ]);
    const own = feedCredentialNames(
      feed({
        id: "de-child-x-events",
        parentSourceId: "de-parent-x-events",
        credentials: { k: { title: "K" } },
        auth: { kind: "bearer", credential: "k" },
      }),
    );
    expect(own[0]?.env).toBe("DE_PARENT_X_EVENTS_K");
  });

  test("a ref is optional only when every use of it is", () => {
    const names = feedCredentialNames(
      feed({
        auth: { kind: "mtls", cert: "@grp.cert", key: "@grp.key", ca: "@grp.ca" },
        endpoints: {
          main: { url: "https://a", headers: { "X-Ca": "${@grp.ca}" }, cadenceSec: 60 },
        },
      }),
    );
    expect(names.find((n) => n.ref === "@grp.ca")?.optional).toBe(false);
  });
});
