import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface Property {
  default?: unknown;
  "x-openmapx-secret"?: boolean;
}

interface Manifest {
  id: string;
  container: { environment?: Record<string, string> };
  configSchema?: { type?: string; required?: string[]; properties?: Record<string, Property> };
  volumes?: { name: string; mountAt: string }[];
  exposure?: { proxy?: { enabled?: boolean } };
}

const servicesDir = new URL("../../services/", import.meta.url);

/** Every OpenConditions service manifest, by its service directory. */
const manifests: [string, Manifest][] = readdirSync(servicesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    try {
      const raw = readFileSync(new URL(`${entry.name}/service.json`, servicesDir), "utf8");
      return [[entry.name, JSON.parse(raw) as Manifest] as [string, Manifest]];
    } catch {
      return [];
    }
  });

function properties(manifest: Manifest): Record<string, Property> {
  return manifest.configSchema?.properties ?? {};
}

function secrets(manifest: Manifest): string[] {
  return Object.entries(properties(manifest))
    .filter(([, p]) => p["x-openmapx-secret"] === true)
    .map(([key]) => key);
}

function defaults(manifest: Manifest, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, properties(manifest)[key]?.default]));
}

const repo = new URL("../../", import.meta.url);

/** A service's directory and those of the workspace packages it depends on. */
function sourceRoots(dir: string): string[] {
  const { dependencies } = JSON.parse(
    readFileSync(new URL(`services/${dir}/package.json`, repo), "utf8"),
  ) as { dependencies: Record<string, string> };
  return [
    `services/${dir}`,
    ...Object.keys(dependencies)
      .filter((name) => name.startsWith("@openconditions/"))
      .map((name) => `packages/${name.slice("@openconditions/".length)}`),
  ];
}

/**
 * The environment variables the code under `roots` (its `src`, tests left
 * out) reads: `env["X"]` and `process.env.X`, a name handed to a reader
 * with the environment (`envInt(env, "X")`), and the `OPENCONDITIONS_*` and
 * `*_CRON` names it hands a reader otherwise. A secret's `<KEY>_FILE` counts
 * as `<KEY>`; `NODE_ENV` is the image's.
 */
function variablesRead(roots: readonly string[]): Set<string> {
  const patterns = [
    /\benv\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g,
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
    /\(\s*(?:process\.)?env\s*,\s*"([A-Z][A-Z0-9_]+)"/g,
    /"(OPENCONDITIONS_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_CRON)"/g,
  ];
  const names = new Set<string>();
  for (const root of roots) {
    const src = new URL(`${root}/src/`, repo);
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".ts") && !f.includes("__tests__") && !f.endsWith(".test.ts"),
    );
    for (const file of files) {
      const text = readFileSync(new URL(file, src), "utf8");
      for (const pattern of patterns) {
        for (const [, name] of text.matchAll(pattern)) names.add(name!.replace(/_FILE$/, ""));
      }
    }
  }
  names.delete("NODE_ENV");
  return names;
}

function manifest(dir: string): Manifest {
  const found = manifests.find(([name]) => name === dir);
  if (!found) throw new Error(`no service.json in services/${dir}`);
  return found[1];
}

describe("service manifests on OpenMapX's config model", () => {
  test("the ingest and contributions-api manifests are found", () => {
    expect(manifests.map(([dir]) => dir)).toEqual(
      expect.arrayContaining(["ingest", "contributions-api"]),
    );
  });

  test.each(manifests)("%s: container.environment holds literal values only", (_dir, m) => {
    for (const [key, value] of Object.entries(m.container.environment ?? {})) {
      expect(value, key).not.toContain("${");
      expect(value, key).not.toContain("$");
    }
  });

  test.each(manifests)("%s: no environment entry names a config field", (_dir, m) => {
    const fields = Object.keys(properties(m));
    for (const key of Object.keys(m.container.environment ?? {})) {
      expect(fields, key).not.toContain(key);
    }
  });

  test.each(manifests)(
    "%s: no JSON Schema `required` (OpenMapX validates it against the non-secret values only)",
    (_dir, m) => {
      expect(m.configSchema?.required).toBeUndefined();
    },
  );

  test.each(manifests)("%s: OpenMapX accepts it as a community service", (_dir, m) => {
    expect(m.configSchema?.type).toBe("object");
    // A third-party volume is namespaced by the service id; no platform proxy route.
    for (const volume of m.volumes ?? []) {
      expect(volume.name.startsWith(`openmapx-${m.id}-`), volume.name).toBe(true);
    }
    expect(m.exposure?.proxy?.enabled).not.toBe(true);
  });

  test.each(manifests)("%s: a secret carries no default", (_dir, m) => {
    for (const key of secrets(m)) expect(properties(m)[key]?.default, key).toBeUndefined();
  });

  test("ingest: the database URL and the operator token are vault secrets", () => {
    expect(secrets(manifest("ingest"))).toEqual(
      expect.arrayContaining(["DATABASE_URL", "OPENCONDITIONS_OPERATOR_TOKEN"]),
    );
  });

  /**
   * What a shared package reads on a path the service never takes. The
   * contributions API fetches nothing through the egress guard or the
   * downloader, writes single records rather than a feed's poll, and runs no
   * rollups.
   */
  const unreached: Record<string, readonly string[]> = {
    ingest: [],
    "contributions-api": [
      "OPENCONDITIONS_DOWNLOAD_MAX_BYTES",
      "OPENCONDITIONS_DOWNLOAD_TIMEOUT_MS",
      "OPENCONDITIONS_EGRESS_ALLOWED_HOSTS",
      "OPENCONDITIONS_FETCH_TIMEOUT_MS",
      "OPENCONDITIONS_MAX_FEED_BYTES",
      "OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL",
      "OPENCONDITIONS_MAX_REDIRECTS",
      "OPENCONDITIONS_ROLLUP_DAILY_DAYS",
      "OPENCONDITIONS_ROLLUP_HOURLY_DAYS",
    ],
  };

  test.each(["ingest", "contributions-api"])(
    "%s: every variable its code reads is a config field or set in its environment",
    (dir) => {
      const m = manifest(dir);
      const set = new Set([
        ...Object.keys(properties(m)),
        ...Object.keys(m.container.environment ?? {}),
      ]);
      const read = variablesRead(sourceRoots(dir));
      // An operator's mounted catalogue: OpenMapX mounts no such directory.
      read.delete("OPENCONDITIONS_FEEDS_DIR");
      for (const name of unreached[dir]!) {
        expect(read, name).toContain(name);
        read.delete(name);
      }
      expect([...read].filter((name) => !set.has(name)).sort()).toEqual([]);
    },
  );

  test("ingest: what it writes lands on its one volume", () => {
    const m = manifest("ingest");
    expect(m.volumes?.map((v) => v.mountAt)).toEqual(["/data"]);
    expect(m.container.environment).toEqual({
      PORT: "4100",
      HOST: "0.0.0.0",
      OPENCONDITIONS_RAW_DIR: "/data/raw",
      OPENCONDITIONS_ARCHIVE_DIR: "/data/archive",
      OPENCONDITIONS_STATE_DIR: "/data",
    });
    // OpenMapX mounts no directory of the operator's: a custom catalogue comes
    // through the remote feed bundle.
    expect(properties(m)).not.toHaveProperty("OPENCONDITIONS_FEEDS_DIR");
  });

  test("ingest: every setting is a config field with the default it had as a passthrough", () => {
    const m = manifest("ingest");
    const expected = {
      OPENLR_RESOLVER_URL: "",
      SEGMENT_REGIONS: "",
      SEGMENT_HIGHWAY_CLASSES: "",
      BIND_ENABLED: "",
      BIND_MAX_OFFSET_M: "",
      BIND_CONCURRENCY: "",
      OPENCONDITIONS_FETCH_TIMEOUT_MS: "",
      OPENCONDITIONS_EGRESS_ALLOWED_HOSTS: "",
      OPENCONDITIONS_DOWNLOAD_MAX_BYTES: "",
      OPENCONDITIONS_DOWNLOAD_TIMEOUT_MS: "",
      RATE_LIMIT_MAX: "120",
      RATE_LIMIT_WINDOW_MS: "60000",
      STREAM_MAX_CONNECTIONS: "100",
      TRUST_PROXY_CIDRS: "loopback,linklocal,uniquelocal",
      OPENCONDITIONS_RAW_MAX_BYTES: "",
      OPENCONDITIONS_HISTORY_DAYS: "",
      OPENCONDITIONS_ON_DEMAND_DEADLINE_MS: "",
      OPENCONDITIONS_INSTANCE_ID: "",
      OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS: "",
      OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO: "",
    };
    expect(defaults(m, Object.keys(expected))).toEqual(expected);
    for (const key of Object.keys(expected)) {
      expect(properties(m)[key]?.["x-openmapx-secret"], key).toBe(false);
    }
  });

  test("contributions-api: its database URL, grant secret and reviewer token are vault secrets", () => {
    const m = manifest("contributions-api");
    expect(m.container.environment).toEqual({ PORT: "4200", HOST: "0.0.0.0" });
    expect(secrets(m).sort()).toEqual([
      "DATABASE_URL",
      "OPENCONDITIONS_GRANT_SECRET",
      "OPENCONDITIONS_REVIEWER_TOKEN",
    ]);
    const expected = {
      OPENCONDITIONS_INSTANCE_ID: "",
      OPENCONDITIONS_ISSUER_NAME: "",
      OPENCONDITIONS_CROSS_VALIDATE_SWEEP: "",
      OPENCONDITIONS_CROWD_LICENSE: "",
      OPENCONDITIONS_CROWD_SOURCE_URI: "",
      OPENCONDITIONS_ALLOW_POLICE_CATEGORY: "",
    };
    expect(defaults(m, Object.keys(expected))).toEqual(expected);
  });
});
