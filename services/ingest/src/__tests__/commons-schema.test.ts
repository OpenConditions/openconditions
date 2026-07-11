import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { canonicalId, phenomenonFingerprint } from "@openconditions/core";
import type { ConditionEvent, Observation } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { atomicSwap } from "../pipeline/write-postgis.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

const COMMONS_COLUMNS = [
  "instance_id",
  "canonical_id",
  "phenomenon_fingerprint",
  "replaces",
  "corroborations",
  "fuzziness",
  "confidence_score",
  "severity_level",
  "privacy_class",
  "k_anonymity",
  "dp_epsilon",
  "dp_delta",
  "informed",
  "source_uri",
  "source_license",
] as const;

describe("commons observation columns", () => {
  it("adds all 15 commons columns to conditions.observations", async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'observations'`;
    expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining([...COMMONS_COLUMNS]));
  }, 30_000);

  it("gives the expected data types and NOT NULL defaults", async () => {
    const cols = await sql<
      {
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'observations'
        AND column_name = ANY(${sql.array([...COMMONS_COLUMNS])})`;
    const byName = new Map(cols.map((c) => [c.column_name, c]));

    expect(byName.get("instance_id")?.data_type).toBe("text");
    expect(byName.get("canonical_id")?.data_type).toBe("text");
    expect(byName.get("phenomenon_fingerprint")?.data_type).toBe("text");
    expect(byName.get("replaces")?.data_type).toBe("jsonb");
    expect(byName.get("corroborations")?.data_type).toBe("jsonb");
    expect(byName.get("confidence_score")?.data_type).toBe("double precision");
    expect(byName.get("severity_level")?.data_type).toBe("smallint");
    expect(byName.get("k_anonymity")?.data_type).toBe("integer");
    expect(byName.get("dp_epsilon")?.data_type).toBe("double precision");
    expect(byName.get("dp_delta")?.data_type).toBe("double precision");
    expect(byName.get("informed")?.data_type).toBe("jsonb");
    expect(byName.get("source_uri")?.data_type).toBe("text");
    expect(byName.get("source_license")?.data_type).toBe("text");

    const fuzziness = byName.get("fuzziness");
    expect(fuzziness?.data_type).toBe("text");
    expect(fuzziness?.is_nullable).toBe("NO");
    expect(fuzziness?.column_default).toContain("'exact'");

    const privacyClass = byName.get("privacy_class");
    expect(privacyClass?.data_type).toBe("text");
    expect(privacyClass?.is_nullable).toBe("NO");
    expect(privacyClass?.column_default).toContain("'unknown'");
  }, 30_000);

  it("creates the four commons indexes", async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'conditions' AND tablename = 'observations'`;
    const names = idx.map((i) => i.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "idx_conditions_obs_canonical",
        "idx_conditions_obs_phenomenon",
        "idx_conditions_obs_instance",
        "idx_conditions_obs_privacy",
      ])
    );
  }, 30_000);
});

describe("commons CHECK constraints", () => {
  const BASE_COLS = `id, source, source_format, domain, kind, status, geom,
    origin, data_updated_at, fetched_at, is_stale`;
  const baseVals = (id: string) =>
    `'${id}', 'chk', 'native', 'roads', 'measurement', 'active',
     ST_SetSRID(ST_MakePoint(0, 0), 4326),
     '{}'::jsonb, now(), now(), false`;

  async function insertInvalid(id: string, col: string, value: string) {
    return sql.unsafe(
      `INSERT INTO conditions.observations (${BASE_COLS}, ${col})
       VALUES (${baseVals(id)}, ${value})`
    );
  }

  it("rejects confidence_score outside [0,1]", async () => {
    await expect(insertInvalid("chk:cs", "confidence_score", "1.5")).rejects.toThrow(
      /obs_confidence_score_range/
    );
  }, 30_000);

  it("rejects dp_delta = 1", async () => {
    await expect(insertInvalid("chk:dd", "dp_delta", "1")).rejects.toThrow(/obs_dp_delta_range/);
  }, 30_000);

  it("rejects dp_epsilon < 0", async () => {
    await expect(insertInvalid("chk:de", "dp_epsilon", "-0.1")).rejects.toThrow(
      /obs_dp_epsilon_nonneg/
    );
  }, 30_000);

  it("rejects k_anonymity = 0", async () => {
    await expect(insertInvalid("chk:k", "k_anonymity", "0")).rejects.toThrow(
      /obs_k_anonymity_positive/
    );
  }, 30_000);

  it("rejects severity_level = 6", async () => {
    await expect(insertInvalid("chk:sl", "severity_level", "6")).rejects.toThrow(
      /obs_severity_level_range/
    );
  }, 30_000);

  it("rejects an unknown fuzziness value", async () => {
    await expect(insertInvalid("chk:fz", "fuzziness", "'bogus'")).rejects.toThrow(
      /obs_fuzziness_enum/
    );
  }, 30_000);

  it("rejects an unknown privacy_class value", async () => {
    await expect(insertInvalid("chk:pc", "privacy_class", "'bogus'")).rejects.toThrow(
      /obs_privacy_class_enum/
    );
  }, 30_000);

  it("accepts the CHECK boundary values (0.999 delta, severity 1 and 5, k=1, score 0 and 1)", async () => {
    const cases: Array<[string, string, string]> = [
      ["chk:bound-dd", "dp_delta", "0.999"],
      ["chk:bound-sl1", "severity_level", "1"],
      ["chk:bound-sl5", "severity_level", "5"],
      ["chk:bound-k1", "k_anonymity", "1"],
      ["chk:bound-cs0", "confidence_score", "0"],
      ["chk:bound-cs1", "confidence_score", "1"],
    ];
    for (const [id, col, value] of cases) {
      await expect(insertInvalid(id, col, value)).resolves.toBeDefined();
    }
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE id LIKE 'chk:bound-%'`;
    expect(rows).toHaveLength(cases.length);
  }, 30_000);

  it("accepts a fully valid commons row", async () => {
    await sql.unsafe(
      `INSERT INTO conditions.observations (
         ${BASE_COLS},
         confidence_score, dp_delta, dp_epsilon, k_anonymity, severity_level,
         fuzziness, privacy_class
       )
       VALUES (
         ${baseVals("chk:ok")},
         0.5, 0.9, 0.1, 2, 3, 'low_res', 'authoritative'
       )`
    );
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM conditions.observations WHERE id = 'chk:ok'`;
    expect(rows).toHaveLength(1);
  }, 30_000);
});

describe("normalizeObservation seam — write through atomicSwap", () => {
  // A plain feed observation is now normalized at the write choke point: the seam
  // stamps instance_id/canonical_id/privacy_class and promotes the attribution
  // license into source_license, while fuzziness still comes from the DB default
  // and the aggregate/privacy columns stay null (no parser ever sets them).
  it("stamps provenance on a plain measurement and leaves the aggregate columns null", async () => {
    const prev = process.env["OPENCONDITIONS_INSTANCE_ID"];
    delete process.env["OPENCONDITIONS_INSTANCE_ID"];
    try {
      const obs: Observation = {
        id: "legacy:1",
        source: "legacysrc",
        sourceFormat: "native",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        geometry: { type: "Point", coordinates: [4.0, 52.0] },
        status: "active",
        origin: { kind: "feed", attribution: { provider: "X", license: "CC0-1.0" } },
        dataUpdatedAt: "2026-06-24T10:00:00Z",
        fetchedAt: "2026-06-24T10:00:00Z",
        isStale: false,
      } as unknown as Observation;

      await atomicSwap(sql, "legacysrc", [obs], 300);

      const rows = await sql<
        {
          fuzziness: string;
          privacy_class: string;
          instance_id: string | null;
          canonical_id: string | null;
          phenomenon_fingerprint: string | null;
          replaces: unknown;
          corroborations: unknown;
          confidence_score: number | null;
          severity_level: number | null;
          k_anonymity: number | null;
          dp_epsilon: number | null;
          dp_delta: number | null;
          informed: unknown;
          source_uri: string | null;
          source_license: string | null;
        }[]
      >`
        SELECT fuzziness, privacy_class, instance_id, canonical_id, phenomenon_fingerprint,
               replaces, corroborations, confidence_score, severity_level, k_anonymity,
               dp_epsilon, dp_delta, informed, source_uri, source_license
        FROM conditions.observations WHERE id = 'legacy:1'`;
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r.fuzziness).toBe("exact");
      expect(r.privacy_class).toBe("authoritative");
      expect(r.instance_id).toBe("local");
      expect(r.canonical_id).toBe(canonicalId({ namespace: "legacysrc", recordId: "legacy:1" }));
      expect(r.phenomenon_fingerprint).toBeNull();
      expect(r.replaces).toBeNull();
      expect(r.corroborations).toBeNull();
      expect(r.confidence_score).toBeNull();
      expect(r.severity_level).toBeNull();
      expect(r.k_anonymity).toBeNull();
      expect(r.dp_epsilon).toBeNull();
      expect(r.dp_delta).toBeNull();
      expect(r.informed).toBeNull();
      expect(r.source_uri).toBeNull();
      expect(r.source_license).toBe("CC0-1.0");
    } finally {
      if (prev === undefined) delete process.env["OPENCONDITIONS_INSTANCE_ID"];
      else process.env["OPENCONDITIONS_INSTANCE_ID"] = prev;
    }
  }, 30_000);

  it("stamps the event fingerprint + attribution provenance and honors the instance-id env", async () => {
    const prev = process.env["OPENCONDITIONS_INSTANCE_ID"];
    process.env["OPENCONDITIONS_INSTANCE_ID"] = "node-e2e";
    try {
      const evt: Observation = {
        id: "seam:evt-1",
        source: "seamsrc",
        sourceFormat: "geojson",
        domain: "roads",
        kind: "event",
        type: "roadworks",
        category: "planned",
        severity: "low",
        severitySource: "declared",
        headline: "Seam event",
        status: "active",
        validFrom: "2026-06-24T10:00:00Z",
        geometry: { type: "Point", coordinates: [4.0, 52.0] },
        origin: {
          kind: "feed",
          attribution: { provider: "Y", license: "CC-BY-4.0", url: "https://ex.test/seam" },
        },
        dataUpdatedAt: "2026-06-24T10:00:00Z",
        fetchedAt: "2026-06-24T10:00:00Z",
        isStale: false,
      } as unknown as Observation;

      const measurement: Observation = {
        id: "seam:meas-1",
        source: "seamsrc",
        sourceFormat: "native",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        geometry: { type: "Point", coordinates: [4.1, 52.1] },
        status: "active",
        origin: { kind: "feed", attribution: { provider: "Y", license: "CC-BY-4.0" } },
        dataUpdatedAt: "2026-06-24T10:00:00Z",
        fetchedAt: "2026-06-24T10:00:00Z",
        isStale: false,
      } as unknown as Observation;

      await atomicSwap(sql, "seamsrc", [evt, measurement], 300);

      const rows = await sql<
        {
          id: string;
          fuzziness: string;
          privacy_class: string;
          instance_id: string;
          canonical_id: string;
          phenomenon_fingerprint: string | null;
          source_uri: string | null;
          source_license: string | null;
        }[]
      >`
        SELECT id, fuzziness, privacy_class, instance_id, canonical_id,
               phenomenon_fingerprint, source_uri, source_license
        FROM conditions.observations WHERE source = 'seamsrc' ORDER BY id`;
      expect(rows).toHaveLength(2);
      const byId = new Map(rows.map((r) => [r.id, r]));

      const e = byId.get("seam:evt-1")!;
      expect(e.fuzziness).toBe("exact");
      expect(e.privacy_class).toBe("authoritative");
      expect(e.instance_id).toBe("node-e2e");
      expect(e.canonical_id).toBe(canonicalId({ namespace: "seamsrc", recordId: "seam:evt-1" }));
      expect(e.phenomenon_fingerprint).toBe(phenomenonFingerprint(evt as ConditionEvent));
      expect(e.source_uri).toBe("https://ex.test/seam");
      expect(e.source_license).toBe("CC-BY-4.0");

      const m = byId.get("seam:meas-1")!;
      expect(m.instance_id).toBe("node-e2e");
      expect(m.canonical_id).toBe(canonicalId({ namespace: "seamsrc", recordId: "seam:meas-1" }));
      expect(m.phenomenon_fingerprint).toBeNull();
      expect(m.source_uri).toBeNull();
      expect(m.source_license).toBe("CC-BY-4.0");
    } finally {
      if (prev === undefined) delete process.env["OPENCONDITIONS_INSTANCE_ID"];
      else process.env["OPENCONDITIONS_INSTANCE_ID"] = prev;
    }
  }, 30_000);
});
