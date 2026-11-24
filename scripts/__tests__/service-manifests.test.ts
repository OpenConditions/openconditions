import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface Property {
  default?: unknown;
  description?: string;
  "x-openmapx-secret"?: boolean;
}

interface Manifest {
  id: string;
  container: {
    image: string;
    environment?: Record<string, string>;
    memory?: string;
    dependsOn?: { service: string; condition?: string }[];
  };
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

/** Each workspace service's directory, by its package name. */
const serviceDirs = new Map(
  readdirSync(servicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = new URL(`${entry.name}/package.json`, servicesDir);
      if (!existsSync(file)) return [];
      const { name } = JSON.parse(readFileSync(file, "utf8")) as { name: string };
      return [[name, `services/${entry.name}`] as const];
    }),
);

/**
 * A service's directory and those of the workspace packages it depends on;
 * a service it bundles (the federation service's contributions API) is read
 * from its own directory.
 */
function sourceRoots(dir: string): string[] {
  const { dependencies } = JSON.parse(
    readFileSync(new URL(`services/${dir}/package.json`, repo), "utf8"),
  ) as { dependencies: Record<string, string> };
  return [
    `services/${dir}`,
    ...Object.keys(dependencies)
      .filter((name) => name.startsWith("@openconditions/"))
      .map((name) => serviceDirs.get(name) ?? `packages/${name.slice("@openconditions/".length)}`),
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

  // OpenMapX escapes every `$` in a community manifest, so a Compose variable
  // reaches Docker as literal text and invalidates the whole project.
  test.each(manifests)("%s: no value anywhere names a Compose variable", (_dir, m) => {
    expect(JSON.stringify(m)).not.toContain("${");
  });

  test.each(manifests)("%s: container.memory is a literal size of at least 6m", (_dir, m) => {
    const match = /^(\d+)([kmg])$/.exec(m.container.memory ?? "");
    expect(match, m.container.memory).not.toBeNull();
    const bytes = Number(match![1]) * 1024 ** { k: 1, m: 2, g: 3 }[match![2] as "k" | "m" | "g"];
    expect(bytes).toBeGreaterThanOrEqual(6 * 1024 ** 2);
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

  test("ingest: the database URL, the secrets key and the operator token are vault secrets", () => {
    expect(secrets(manifest("ingest"))).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "OPENCONDITIONS_SECRETS_KEY",
        "OPENCONDITIONS_OPERATOR_TOKEN",
      ]),
    );
  });

  test.each(["ingest", "contributions-api", "federation"])(
    "%s: the secrets key that encrypts its stored secrets is a vault secret",
    (dir) => {
      expect(properties(manifest(dir))["OPENCONDITIONS_SECRETS_KEY"]).toMatchObject({
        "x-openmapx-secret": true,
      });
    },
  );

  /**
   * What a shared package reads on a path the service never takes. The
   * contributions API fetches nothing through the egress guard or the
   * downloader, writes single records rather than a feed's poll, and runs no
   * rollups. The federation service bundles the contributions API for its
   * inbox only: it issues no grants, serves no reviewer, trusts no relay, lands no crowd
   * report of its own and runs no sweep, and downloads no feed.
   */
  const unreached: Record<string, readonly string[]> = {
    ingest: [],
    "contributions-api": [
      "OPENCONDITIONS_STATE_DIR",
      "PUN_COORDINATION_DIR",
      "OPENCONDITIONS_DOWNLOAD_MAX_BYTES",
      "OPENCONDITIONS_DOWNLOAD_TIMEOUT_MS",
      "OPENCONDITIONS_EGRESS_ALLOWED_HOSTS",
      "OPENCONDITIONS_FETCH_TIMEOUT_MS",
      "OPENCONDITIONS_LATEST_CACHE_MB",
      "OPENCONDITIONS_MAX_FEED_BYTES",
      "OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL",
      "OPENCONDITIONS_MAX_REDIRECTS",
      "OPENCONDITIONS_ROLLUP_DAILY_DAYS",
      "OPENCONDITIONS_ROLLUP_HOURLY_DAYS",
    ],
    federation: [
      "OPENCONDITIONS_STATE_DIR",
      "PUN_COORDINATION_DIR",
      "OPENCONDITIONS_ALLOW_POLICE_CATEGORY",
      "OPENCONDITIONS_CROSS_VALIDATE_SWEEP",
      "OPENCONDITIONS_CROWD_LICENSE",
      "OPENCONDITIONS_CROWD_SOURCE_URI",
      "OPENCONDITIONS_DOWNLOAD_MAX_BYTES",
      "OPENCONDITIONS_DOWNLOAD_TIMEOUT_MS",
      "OPENCONDITIONS_GRANT_SECRET",
      "OPENCONDITIONS_ISSUER_NAME",
      "OPENCONDITIONS_LATEST_CACHE_MB",
      "OPENCONDITIONS_MAX_FEED_BYTES",
      "OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL",
      "OPENCONDITIONS_RELAY_ENROLL_LIMIT_PER_MINUTE",
      "OPENCONDITIONS_RELAY_TOKEN",
      "OPENCONDITIONS_REVIEWER_TOKEN",
      "OPENCONDITIONS_ROLLUP_DAILY_DAYS",
      "OPENCONDITIONS_ROLLUP_HOURLY_DAYS",
    ],
  };

  test.each(["ingest", "contributions-api", "federation"])(
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

  test("ingest: the container gets a literal 8g", () => {
    // The service's heap (55%) and the parse child's (30%) both fit; a segment
    // region's weekly rebuild needs about 1.7 GB of the service's heap.
    expect(manifest("ingest").container.memory).toBe("8g");
  });

  test("ingest: what it writes lands on its one volume", () => {
    const m = manifest("ingest");
    expect(m.volumes?.map((v) => v.mountAt)).toEqual(["/data"]);
    expect(m.container.environment).toEqual({
      PORT: "4100",
      HOST: "0.0.0.0",
      OPENCONDITIONS_INGEST_ROLE: "primary",
      OPENCONDITIONS_RAW_DIR: "/data/raw",
      OPENCONDITIONS_ARCHIVE_DIR: "/data/archive",
      OPENCONDITIONS_STATE_DIR: "/data",
    });
    // OpenMapX mounts no directory of the operator's: a custom catalogue comes
    // through the remote feed bundle.
    expect(properties(m)).not.toHaveProperty("OPENCONDITIONS_FEEDS_DIR");
  });

  test("ingest-heavy: the same image polling only its feeds, with the ingest service's fields", () => {
    const ingest = manifest("ingest");
    const m = manifest("ingest-heavy");
    expect(m.id).toBe("openconditions-ingest-heavy");
    expect(m.container.image).toBe(ingest.container.image);
    expect(m.container.environment).toEqual({
      PORT: "4100",
      HOST: "0.0.0.0",
      OPENCONDITIONS_INGEST_ROLE: "feeds",
      OPENCONDITIONS_RAW_DIR: "/data/raw",
      OPENCONDITIONS_STATE_DIR: "/data",
    });
    // Its raw payloads lie on its own volume, which its own eviction keeps.
    expect(m.volumes?.map((v) => v.mountAt)).toEqual(["/data"]);
    expect(m.container.memory).toBe("6g");
    // The primary migrates, syncs the catalogue and creates the partitions it writes into.
    expect(m.container.dependsOn).toContainEqual({
      service: "openconditions-ingest",
      condition: "service_healthy",
    });
    // The same fields, but the secrets key is copied from the ingest service, never generated.
    const { OPENCONDITIONS_SECRETS_KEY: heavyKey, ...heavyRest } = properties(m);
    const { OPENCONDITIONS_SECRETS_KEY: ingestKey, ...ingestRest } = properties(ingest);
    expect(heavyRest).toEqual(ingestRest);
    expect({ ...heavyKey, description: undefined }).toEqual({
      ...ingestKey,
      description: undefined,
    });
    expect(heavyKey?.description).toMatch(/^Required\. Copy the value of openconditions-ingest's/);
    expect(heavyKey?.description).not.toContain("openssl rand");
    expect(
      defaults(m, ["OPENCONDITIONS_INGEST_FEEDS", "OPENCONDITIONS_INGEST_FEEDS_EXCLUDE"]),
    ).toEqual({ OPENCONDITIONS_INGEST_FEEDS: "", OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: "" });
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

  test("contributions-api: its database URL, secrets key, grant secret, reviewer token and relay token are vault secrets", () => {
    const m = manifest("contributions-api");
    expect(m.container.environment).toEqual({ PORT: "4200", HOST: "0.0.0.0" });
    expect(secrets(m).sort()).toEqual([
      "DATABASE_URL",
      "OPENCONDITIONS_GRANT_SECRET",
      "OPENCONDITIONS_RELAY_TOKEN",
      "OPENCONDITIONS_REVIEWER_TOKEN",
      "OPENCONDITIONS_SECRETS_KEY",
    ]);
    const expected = {
      OPENCONDITIONS_INSTANCE_ID: "",
      OPENCONDITIONS_RELAY_ENROLL_LIMIT_PER_MINUTE: "",
      OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS: "",
      OPENCONDITIONS_ISSUER_NAME: "",
      OPENCONDITIONS_CROSS_VALIDATE_SWEEP: "",
      OPENCONDITIONS_CROWD_LICENSE: "",
      OPENCONDITIONS_CROWD_SOURCE_URI: "",
      OPENCONDITIONS_ALLOW_POLICE_CATEGORY: "",
    };
    expect(defaults(m, Object.keys(expected))).toEqual(expected);
  });

  test("federation: off by default, its database URL, secrets key and client certificate key the only secrets", () => {
    const m = manifest("federation");
    // Its registry cache and a peer's archive files while they land live on its volume.
    expect(m.container.environment).toEqual({
      PORT: "4300",
      HOST: "0.0.0.0",
      OPENCONDITIONS_FEDERATION_REGISTRY_CACHE: "/data/registry",
      TMPDIR: "/data",
    });
    expect(secrets(m)).toEqual([
      "DATABASE_URL",
      "OPENCONDITIONS_SECRETS_KEY",
      "OPENCONDITIONS_FEDERATION_CLIENT_KEY",
    ]);
    expect(properties(m)["OPENCONDITIONS_FEDERATION_ENABLED"]?.default).toBe("");
    expect(properties(m)["OPENCONDITIONS_SCHEMA_WAIT_TIMEOUT_MS"]?.default).toBe("");
  });

  test("federation: not in the extension, which would start it on every install unreachable", () => {
    const extension = JSON.parse(readFileSync(new URL("extension.json", repo), "utf8")) as {
      services: { service: string }[];
    };
    expect(extension.services.map((s) => s.service)).not.toContain(manifest("federation").id);
  });
});

describe("OpenMapX's community manifest rules", () => {
  const extension = JSON.parse(readFileSync(new URL("extension.json", repo), "utf8")) as Record<
    string,
    unknown
  > & { services: { service: string }[] };
  const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const all = (): [string, Record<string, unknown>][] => [
    ["extension.json", extension],
    ...manifests.map(
      ([dir, m]) =>
        [`services/${dir}/service.json`, m as unknown as Record<string, unknown>] as [
          string,
          Record<string, unknown>,
        ],
    ),
  ];

  test.each(all())("%s declares platform 1.0, a semver version and a valid id", (_path, m) => {
    expect(m["platform"]).toBe("1.0");
    expect(m["version"]).toMatch(SEMVER);
    expect(m["id"]).toMatch(ID);
    expect((m["id"] as string).length).toBeLessThanOrEqual(48);
  });

  test.each(manifests)("services/%s/service.json is labelled community", (_dir, m) => {
    expect((m as unknown as { quality: string }).quality).toBe("community");
  });

  test.each(manifests)(
    "services/%s/service.json names its capabilities and data types under the openconditions vendor",
    (_dir, m) => {
      const raw = m as unknown as {
        provides?: (string | { capability: string })[];
        produces?: { type: string }[];
        consumes?: { type: string }[];
      };
      const names = [
        ...(raw.provides ?? []).map((p) => (typeof p === "string" ? p : p.capability)),
        ...(raw.produces ?? []).map((p) => p.type),
        ...(raw.consumes ?? []).map((c) => c.type),
      ];
      for (const name of names) expect(name).toMatch(/^openconditions\/[a-z0-9]+(-[a-z0-9]+)*$/);
    },
  );

  test("the extension's licence is the licence of every service it installs", () => {
    for (const { service } of extension.services) {
      const found = manifests.find(([, m]) => m.id === service);
      expect(found, service).toBeDefined();
      expect((found![1] as unknown as { license: string }).license).toBe(extension["license"]);
    }
    expect(extension["license"]).toBe("AGPL-3.0-or-later");
  });

  test.each(manifests)(
    // OpenMapX checks `required` against the saved non-secret values, which
    // never hold a secret, and every service's configuration in one
    // generation, so a required field would block configuring the platform.
    // Each service refuses to start without what it needs instead, and says so.
    "services/%s/service.json lists no configSchema required fields",
    (_dir, m) => {
      expect(m.configSchema?.required).toBeUndefined();
    },
  );
});
