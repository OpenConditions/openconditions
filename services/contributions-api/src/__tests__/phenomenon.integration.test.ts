import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { phenomenonFingerprint, type ConditionEvent } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { applyCorroboration, applyNegation, findCandidates } from "../evidence/phenomenon.js";

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
  sql = postgres(url, { max: 5 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

interface EventOpts {
  id: string;
  lon: number;
  lat: number;
  validFrom: string;
  type?: string;
  reporterKey?: string;
  source?: string;
  status?: string;
  dataUpdatedAt?: string;
}

async function insertCrowdEvent(opts: EventOpts): Promise<void> {
  const type = opts.type ?? "hazard";
  const fp = phenomenonFingerprint({
    kind: "event",
    domain: "roads",
    type,
    geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
    validFrom: opts.validFrom,
  } as ConditionEvent);
  const origin =
    opts.reporterKey !== undefined
      ? { kind: "crowd", reporter: { keyId: opts.reporterKey } }
      : { kind: "crowd" };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, status, geom, origin,
       valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
    VALUES
      (${opts.id}, ${opts.source ?? "crowd"}, 'native', 'roads', 'event', ${type},
       ${opts.status ?? "active"},
       ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
       ${sql.json(origin as never)}, ${opts.validFrom}, ${fp},
       ${opts.dataUpdatedAt ?? opts.validFrom}, now(), false)`;
}

async function addReport(obsId: string, key: string, occurredAt: string): Promise<void> {
  await sql`
    INSERT INTO conditions.report_evidence
      (observation_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES (${obsId}, 'report', ${key}, ${occurredAt}, '{}'::jsonb)`;
}

interface EvidenceRow {
  evidence_kind: string;
  actor_key_id: string | null;
  source_id: string | null;
  occurred_at: Date;
  details: { observationId?: string } | null;
}

async function evidenceOf(obsId: string, kind: string): Promise<EvidenceRow[]> {
  return sql<EvidenceRow[]>`
    SELECT evidence_kind, actor_key_id, source_id, occurred_at, details
    FROM conditions.report_evidence
    WHERE observation_id = ${obsId} AND evidence_kind = ${kind}
    ORDER BY occurred_at, id`;
}

interface ObsRow {
  status: string;
  evidence_state: string | null;
  routing_eligible: boolean;
  corroborations: string[] | null;
  replaces: string[] | null;
}

async function obs(id: string): Promise<ObsRow> {
  const rows = await sql<ObsRow[]>`
    SELECT status, evidence_state, routing_eligible, corroborations, replaces
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0]!;
}

describe("findCandidates", () => {
  it("returns the other active event in the fingerprint neighborhood, excluding self", async () => {
    await insertCrowdEvent({
      id: "fc:target",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
    });
    await insertCrowdEvent({
      id: "fc:other",
      lon: 6.5001,
      lat: 52.0,
      validFrom: "2026-07-10T12:04:00Z",
      reporterKey: "key-b",
    });
    // An unrelated event far away must NOT surface.
    await insertCrowdEvent({
      id: "fc:far",
      lon: 2.0,
      lat: 48.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-c",
    });

    const candidates = await findCandidates(sql, "fc:target");
    expect(candidates.map((c) => c.id)).toEqual(["fc:other"]);
    const [other] = candidates;
    expect(other!.actor).toEqual({ kind: "crowd", keyId: "key-b", source: "crowd" });
    expect(other!.type).toBe("hazard");
    expect(other!.status).toBe("active");
  }, 30_000);

  it("returns [] for a non-existent observation", async () => {
    expect(await findCandidates(sql, "fc:nope")).toEqual([]);
  }, 30_000);
});

describe("applyCorroboration", () => {
  it("appends a confirm row, unions lineage, deactivates the later obs, recomputes to corroborated (never routing)", async () => {
    await insertCrowdEvent({
      id: "co:target",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
      dataUpdatedAt: "2026-07-10T12:00:00Z",
    });
    await addReport("co:target", "key-a", "2026-07-10T12:00:00Z");
    await insertCrowdEvent({
      id: "co:later",
      lon: 6.5001,
      lat: 52.0,
      validFrom: "2026-07-10T12:04:00Z",
      reporterKey: "key-b",
      dataUpdatedAt: "2026-07-10T12:04:00Z",
    });
    await addReport("co:later", "key-b", "2026-07-10T12:04:00Z");

    await applyCorroboration(sql, "co:later", "co:target", "2026-07-10T12:10:00Z");

    const confirms = await evidenceOf("co:target", "confirm");
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.actor_key_id).toBe("key-b");
    expect(confirms[0]!.source_id).toBe("crowd");
    expect(confirms[0]!.details?.observationId).toBe("co:later");
    expect(confirms[0]!.occurred_at.toISOString()).toBe("2026-07-10T12:04:00.000Z");

    const target = await obs("co:target");
    expect(target.corroborations).toContain("co:later");
    expect(target.replaces).toContain("co:later");
    expect(target.evidence_state).toBe("corroborated");
    expect(target.routing_eligible).toBe(false);

    expect((await obs("co:later")).status).toBe("inactive");
  }, 30_000);

  it("is COMMUTATIVE: the earlier observation survives regardless of argument order", async () => {
    for (const [first, second] of [
      ["comm:early", "comm:late"],
      ["comm:late", "comm:early"],
    ] as const) {
      await sql`DELETE FROM conditions.report_evidence WHERE observation_id IN ('comm:early', 'comm:late')`;
      await sql`DELETE FROM conditions.observations WHERE id IN ('comm:early', 'comm:late')`;
      await insertCrowdEvent({
        id: "comm:early",
        lon: 6.5,
        lat: 52.0,
        validFrom: "2026-07-10T12:00:00Z",
        reporterKey: "key-a",
        dataUpdatedAt: "2026-07-10T12:00:00Z",
      });
      await addReport("comm:early", "key-a", "2026-07-10T12:00:00Z");
      await insertCrowdEvent({
        id: "comm:late",
        lon: 6.5001,
        lat: 52.0,
        validFrom: "2026-07-10T12:04:00Z",
        reporterKey: "key-b",
        dataUpdatedAt: "2026-07-10T12:04:00Z",
      });
      await addReport("comm:late", "key-b", "2026-07-10T12:04:00Z");

      await applyCorroboration(sql, first, second, "2026-07-10T12:10:00Z");

      // Earlier survives (corroborated, active); later merges in (inactive) —
      // whichever order the ids were passed.
      const early = await obs("comm:early");
      expect(early.evidence_state).toBe("corroborated");
      expect(early.routing_eligible).toBe(false);
      expect(early.corroborations).toContain("comm:late");
      expect((await obs("comm:late")).status).toBe("inactive");
      expect(await evidenceOf("comm:early", "confirm")).toHaveLength(1);
    }
  }, 30_000);

  it("concurrent cross-race corroboration converges on ONE survivor, never annihilates", async () => {
    await insertCrowdEvent({
      id: "race:a",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
      dataUpdatedAt: "2026-07-10T12:00:00Z",
    });
    await addReport("race:a", "key-a", "2026-07-10T12:00:00Z");
    await insertCrowdEvent({
      id: "race:b",
      lon: 6.5001,
      lat: 52.0,
      validFrom: "2026-07-10T12:04:00Z",
      reporterKey: "key-b",
      dataUpdatedAt: "2026-07-10T12:04:00Z",
    });
    await addReport("race:b", "key-b", "2026-07-10T12:04:00Z");

    // Both landing hooks fire at once, each merging "self onto the other". Under
    // the naive design both would mark the other inactive → phenomenon vanishes.
    await Promise.all([
      applyCorroboration(sql, "race:a", "race:b", "2026-07-10T12:10:00Z"),
      applyCorroboration(sql, "race:b", "race:a", "2026-07-10T12:10:00Z"),
    ]);

    const a = await obs("race:a");
    const b = await obs("race:b");
    // Exactly ONE active survivor (the earlier, race:a), the other inactive —
    // NEITHER annihilated.
    const active = [a, b].filter((r) => r.status === "active");
    expect(active).toHaveLength(1);
    expect(a.status).toBe("active");
    expect(a.evidence_state).toBe("corroborated");
    expect(a.routing_eligible).toBe(false);
    expect(b.status).toBe("inactive");
    // One confirm row, one lineage entry (idempotent under the race).
    expect(await evidenceOf("race:a", "confirm")).toHaveLength(1);
    expect(a.corroborations).toEqual(["race:b"]);
  }, 30_000);

  it("throws a TypeError when an observation would corroborate itself", async () => {
    await expect(
      applyCorroboration(sql, "self:same", "self:same", "2026-07-10T12:10:00Z")
    ).rejects.toThrow(TypeError);
  }, 30_000);

  it("throws when either observation row is missing", async () => {
    await insertCrowdEvent({
      id: "miss:present",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
    });
    await expect(
      applyCorroboration(sql, "miss:absent", "miss:present", "2026-07-10T12:10:00Z")
    ).rejects.toThrow(/does not exist/);
    await expect(
      applyCorroboration(sql, "miss:present", "miss:absent", "2026-07-10T12:10:00Z")
    ).rejects.toThrow(/does not exist/);
  }, 30_000);

  it("is idempotent under a concurrent double-call: one confirm row, one corroborations entry", async () => {
    await insertCrowdEvent({
      id: "idem:target",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
      dataUpdatedAt: "2026-07-10T12:00:00Z",
    });
    await addReport("idem:target", "key-a", "2026-07-10T12:00:00Z");
    await insertCrowdEvent({
      id: "idem:later",
      lon: 6.5001,
      lat: 52.0,
      validFrom: "2026-07-10T12:04:00Z",
      reporterKey: "key-b",
      dataUpdatedAt: "2026-07-10T12:04:00Z",
    });

    await Promise.all([
      applyCorroboration(sql, "idem:later", "idem:target", "2026-07-10T12:10:00Z"),
      applyCorroboration(sql, "idem:later", "idem:target", "2026-07-10T12:10:00Z"),
    ]);

    expect(await evidenceOf("idem:target", "confirm")).toHaveLength(1);
    const target = await obs("idem:target");
    expect(target.corroborations).toEqual(["idem:later"]);
    expect(target.evidence_state).toBe("corroborated");
  }, 30_000);
});

describe("applyNegation", () => {
  it("from a distinct key appends a negate row; a lone peer negation stays under quorum (self_reported)", async () => {
    await insertCrowdEvent({
      id: "neg:target",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
    });
    await addReport("neg:target", "key-a", "2026-07-10T12:00:00Z");
    await insertCrowdEvent({
      id: "neg:cancel",
      lon: 6.5001,
      lat: 52.0,
      validFrom: "2026-07-10T12:05:00Z",
      reporterKey: "key-z",
      status: "cancelled",
      dataUpdatedAt: "2026-07-10T12:05:00Z",
    });

    await applyNegation(sql, "neg:cancel", "neg:target", "2026-07-10T12:06:00Z");

    const negates = await evidenceOf("neg:target", "negate");
    expect(negates).toHaveLength(1);
    expect(negates[0]!.actor_key_id).toBe("key-z");
    expect((await obs("neg:target")).evidence_state).toBe("self_reported");
  }, 30_000);

  it("from the originating key retracts the observation (negated)", async () => {
    await insertCrowdEvent({
      id: "ret:target",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
    });
    await addReport("ret:target", "key-a", "2026-07-10T12:00:00Z");
    await insertCrowdEvent({
      id: "ret:cancel",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:05:00Z",
      reporterKey: "key-a",
      status: "cancelled",
      dataUpdatedAt: "2026-07-10T12:05:00Z",
    });

    await applyNegation(sql, "ret:cancel", "ret:target", "2026-07-10T12:06:00Z");

    expect(await evidenceOf("ret:target", "negate")).toHaveLength(1);
    expect((await obs("ret:target")).evidence_state).toBe("negated");
  }, 30_000);

  it("throws when either the negation or the target observation is missing", async () => {
    await insertCrowdEvent({
      id: "negmiss:present",
      lon: 6.5,
      lat: 52.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "key-a",
    });
    await expect(
      applyNegation(sql, "negmiss:absent", "negmiss:present", "2026-07-10T12:10:00Z")
    ).rejects.toThrow(/does not exist/);
    await expect(
      applyNegation(sql, "negmiss:present", "negmiss:absent", "2026-07-10T12:10:00Z")
    ).rejects.toThrow(/does not exist/);
    expect(await evidenceOf("negmiss:present", "negate")).toHaveLength(0);
  }, 30_000);
});
