import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { phenomenonFingerprint, type ConditionEvent } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { autoCorroborateOnLanding } from "../evidence/autoCorroborate.js";
import { resolveSurvivor } from "../evidence/phenomenon.js";
import { recomputeEvidence } from "../evidence/recompute.js";

const M_PER_DEG = 111_320;

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

/** Latitude offset (degrees) for a north–south distance in metres. */
function latOffset(meters: number): number {
  return meters / M_PER_DEG;
}

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

async function insertReporter(keyId: string, alpha = 2, beta = 2): Promise<void> {
  await sql`
    INSERT INTO conditions.reporter
      (key_id, pub_jwk, reputation_alpha, reputation_beta,
       entitlement_expires_at, status, created_at, last_active_at)
    VALUES
      (${keyId}, '{}'::jsonb, ${alpha}, ${beta},
       '2027-01-01T00:00:00Z', 'active', '2026-07-10T12:00:00Z', '2026-07-10T12:00:00Z')
    ON CONFLICT (key_id) DO NOTHING`;
}

/** Seed a landed crowd witness: obs row + reporter + originating report + recompute. */
async function seedWitness(opts: EventOpts & { reporterKey: string }): Promise<void> {
  await insertCrowdEvent(opts);
  await insertReporter(opts.reporterKey);
  await addReport(opts.id, opts.reporterKey, opts.dataUpdatedAt ?? opts.validFrom);
  await recomputeEvidence(sql, opts.id, opts.dataUpdatedAt ?? opts.validFrom);
}

interface ObsRow {
  status: string;
  evidence_state: string | null;
  routing_eligible: boolean;
  confidence_score: number | null;
  corroborations: string[] | null;
  replaces: string[] | null;
}

async function obs(id: string): Promise<ObsRow> {
  const rows = await sql<ObsRow[]>`
    SELECT status, evidence_state, routing_eligible, confidence_score, corroborations, replaces
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0]!;
}

async function distinctConfirmers(obsId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(DISTINCT actor_key_id)::int AS n FROM conditions.report_evidence
    WHERE observation_id = ${obsId} AND evidence_kind = 'confirm'`;
  return rows[0]!.n;
}

async function confirmRowCount(obsId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.report_evidence
    WHERE observation_id = ${obsId} AND evidence_kind = 'confirm'`;
  return rows[0]!.n;
}

async function reporterPosterior(keyId: string): Promise<{ alpha: number; beta: number }> {
  const rows = await sql<{ reputation_alpha: number; reputation_beta: number }[]>`
    SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${keyId}`;
  return { alpha: rows[0]!.reputation_alpha, beta: rows[0]!.reputation_beta };
}

describe("resolveSurvivor", () => {
  it("returns the row itself when active", async () => {
    await insertCrowdEvent({
      id: "rs:active",
      lon: 6.5,
      lat: 40.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "rs-a",
    });
    expect(await resolveSurvivor(sql, "rs:active")).toBe("rs:active");
  }, 30_000);

  it("follows an inactive row UP to its active survivor via corroborations", async () => {
    await insertCrowdEvent({
      id: "rs:survivor",
      lon: 6.5,
      lat: 40.1,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "rs-s",
    });
    await insertCrowdEvent({
      id: "rs:merged",
      lon: 6.5,
      lat: 40.1001,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "rs-m",
      status: "inactive",
    });
    await sql`
      UPDATE conditions.observations
      SET corroborations = ${sql.json(["rs:merged"] as never)},
          replaces = ${sql.json(["rs:merged"] as never)}
      WHERE id = 'rs:survivor'`;
    expect(await resolveSurvivor(sql, "rs:merged")).toBe("rs:survivor");
  }, 30_000);

  it("follows a MULTI-LEVEL chain (B→A→Z) to the earliest active head", async () => {
    // Z earliest active head; A merged into Z (inactive); B merged into A (inactive).
    await insertCrowdEvent({
      id: "rs:z",
      lon: 6.5,
      lat: 41.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "rs-z",
    });
    await insertCrowdEvent({
      id: "rs:a2",
      lon: 6.5,
      lat: 41.0001,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "rs-a2",
      status: "inactive",
    });
    await insertCrowdEvent({
      id: "rs:b2",
      lon: 6.5,
      lat: 41.0002,
      validFrom: "2026-07-10T12:03:00Z",
      reporterKey: "rs-b2",
      status: "inactive",
    });
    await sql`
      UPDATE conditions.observations SET corroborations = ${sql.json(["rs:a2"] as never)}
      WHERE id = 'rs:z'`;
    await sql`
      UPDATE conditions.observations SET corroborations = ${sql.json(["rs:b2"] as never)}
      WHERE id = 'rs:a2'`;
    expect(await resolveSurvivor(sql, "rs:b2")).toBe("rs:z");
  }, 30_000);

  it("returns null when the chain dead-ends in an archived cluster (never a target)", async () => {
    await insertCrowdEvent({
      id: "rs:arch-head",
      lon: 6.5,
      lat: 42.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "rs-ah",
      status: "archived",
    });
    await insertCrowdEvent({
      id: "rs:arch-merged",
      lon: 6.5,
      lat: 42.0001,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "rs-am",
      status: "inactive",
    });
    await sql`
      UPDATE conditions.observations SET corroborations = ${sql.json(["rs:arch-merged"] as never)}
      WHERE id = 'rs:arch-head'`;
    expect(await resolveSurvivor(sql, "rs:arch-merged")).toBeNull();
  }, 30_000);

  it("returns null (no hang) for a self-referential / looping lineage", async () => {
    await insertCrowdEvent({
      id: "rs:loop-x",
      lon: 6.5,
      lat: 43.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "rs-lx",
      status: "inactive",
    });
    await insertCrowdEvent({
      id: "rs:loop-y",
      lon: 6.5,
      lat: 43.0001,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "rs-ly",
      status: "inactive",
    });
    await sql`
      UPDATE conditions.observations SET corroborations = ${sql.json(["rs:loop-y"] as never)}
      WHERE id = 'rs:loop-x'`;
    await sql`
      UPDATE conditions.observations SET corroborations = ${sql.json(["rs:loop-x"] as never)}
      WHERE id = 'rs:loop-y'`;
    expect(await resolveSurvivor(sql, "rs:loop-x")).toBeNull();
  }, 30_000);

  it("follows CORROBORATION lineage only — a `replaces` cancellation record is never taken", async () => {
    // T merged into survivor S (corroboration lineage). A SEPARATE cancellation
    // record N (status='cancelled', replaces=[T]) also references T via `replaces`.
    // resolveSurvivor must deterministically return S, never N, never null.
    await insertCrowdEvent({
      id: "rp:S",
      lon: 6.5,
      lat: 44.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "rp-s",
    });
    await insertCrowdEvent({
      id: "rp:T",
      lon: 6.5,
      lat: 44.0001,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "rp-t",
      status: "inactive",
    });
    await sql`
      UPDATE conditions.observations SET corroborations = ${sql.json(["rp:T"] as never)}
      WHERE id = 'rp:S'`;
    // The cancellation record: a 'cancelled' row whose `replaces` points at T.
    await insertCrowdEvent({
      id: "rp:N",
      lon: 6.5,
      lat: 44.0002,
      validFrom: "2026-07-10T12:03:00Z",
      reporterKey: "rp-n",
      status: "cancelled",
    });
    await sql`
      UPDATE conditions.observations SET replaces = ${sql.json(["rp:T"] as never)}
      WHERE id = 'rp:N'`;

    for (let i = 0; i < 3; i++) {
      expect(await resolveSurvivor(sql, "rp:T")).toBe("rp:S");
    }
  }, 30_000);

  it("returns null for a non-existent observation", async () => {
    expect(await resolveSurvivor(sql, "rs:nope")).toBeNull();
  }, 30_000);
});

describe("autoCorroborateOnLanding — 3-way corroboration-chain re-crediting", () => {
  it("redirects a 3rd witness that only neighbors a MERGED row to the active survivor, corroborating it — never routing, never training", async () => {
    // A is the earliest active head. B merges into A. C lands in B's fingerprint
    // neighborhood but OUTSIDE A's neighborhood (2 grid cells north), yet within
    // the 250 m match radius of A — so only the merged B bridges C to A.
    const lon = 6.5;
    const latA = 52.0;
    const latB = 52.0 + latOffset(150);
    const latC = 52.0 + latOffset(230);

    await seedWitness({
      id: "ch:A",
      lon,
      lat: latA,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "ch-a",
    });
    await seedWitness({
      id: "ch:B",
      lon,
      lat: latB,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "ch-b",
    });
    // Landing B corroborates A (B merges in, A survives).
    await autoCorroborateOnLanding(sql, "ch:B", "2026-07-10T12:02:30Z");
    expect((await obs("ch:B")).status).toBe("inactive");
    expect((await obs("ch:A")).corroborations).toContain("ch:B");

    await seedWitness({
      id: "ch:C",
      lon,
      lat: latC,
      validFrom: "2026-07-10T12:03:00Z",
      reporterKey: "ch-c",
    });
    const beforeA = await reporterPosterior("ch-a");

    const corroborated = await autoCorroborateOnLanding(sql, "ch:C", "2026-07-10T12:03:30Z");

    // C redirected onto the survivor A.
    expect(corroborated).toEqual(["ch:A"]);
    const a = await obs("ch:A");
    expect(a.status).toBe("active");
    expect(a.evidence_state).toBe("corroborated");
    expect(a.corroborations).toEqual(expect.arrayContaining(["ch:B", "ch:C"]));
    expect((await obs("ch:C")).status).toBe("inactive");

    // Two distinct confirmers (B and C) → a real 3-witness phenomenon.
    expect(await distinctConfirmers("ch:A")).toBe(2);
    // Confidence reflects TWO confirmers under the asymmetric model:
    // base 0.3 + (0.75 - 0.3) * (1 - 0.5^2) = 0.6375 (a single confirmer is 0.525).
    expect(a.confidence_score).toBeCloseTo(0.6375, 4);

    // HARD GUARDRAILS: corroboration never routes and never trains reputation.
    expect(a.routing_eligible).toBe(false);
    expect(await reporterPosterior("ch-a")).toEqual(beforeA);
    expect(await reporterPosterior("ch-b")).toEqual({ alpha: 2, beta: 2 });
    expect(await reporterPosterior("ch-c")).toEqual({ alpha: 2, beta: 2 });
  }, 60_000);

  it("still corroborates a DIRECT active match (unchanged path)", async () => {
    const lon = 5.0;
    await seedWitness({
      id: "dm:A",
      lon,
      lat: 48.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "dm-a",
    });
    await seedWitness({
      id: "dm:B",
      lon: lon + 0.0001,
      lat: 48.0,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "dm-b",
    });

    const corroborated = await autoCorroborateOnLanding(sql, "dm:B", "2026-07-10T12:02:30Z");
    expect(corroborated).toEqual(["dm:A"]);
    expect((await obs("dm:A")).evidence_state).toBe("corroborated");
    expect((await obs("dm:A")).routing_eligible).toBe(false);
    expect((await obs("dm:B")).status).toBe("inactive");
  }, 60_000);

  it("credits the survivor ONCE when the 3rd witness neighbors BOTH the merged row and the active survivor (no double-credit)", async () => {
    // C sits close enough to reach A directly AND to see the merged B — A must be
    // credited exactly once.
    const lon = 4.0;
    const latA = 50.0;
    const latB = 50.0 + latOffset(60);
    const latC = 50.0 + latOffset(30);

    await seedWitness({
      id: "dc:A",
      lon,
      lat: latA,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "dc-a",
    });
    await seedWitness({
      id: "dc:B",
      lon,
      lat: latB,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "dc-b",
    });
    await autoCorroborateOnLanding(sql, "dc:B", "2026-07-10T12:02:30Z");
    expect((await obs("dc:B")).status).toBe("inactive");

    await seedWitness({
      id: "dc:C",
      lon,
      lat: latC,
      validFrom: "2026-07-10T12:03:00Z",
      reporterKey: "dc-c",
    });
    const corroborated = await autoCorroborateOnLanding(sql, "dc:C", "2026-07-10T12:03:30Z");

    expect(corroborated).toEqual(["dc:A"]);
    const a = await obs("dc:A");
    // C appears exactly once in the lineage and yields exactly one confirm row.
    expect(a.corroborations!.filter((x) => x === "dc:C")).toHaveLength(1);
    expect(await confirmRowCount("dc:A")).toBe(2);
    expect(await distinctConfirmers("dc:A")).toBe(2);
  }, 60_000);

  it("never resolves-to or corroborates a status='archived' neighborhood row", async () => {
    const lon = 3.0;
    // An archived tombstone sits in the landing's neighborhood — it must never be
    // a corroboration target, directly or via resolution.
    await insertCrowdEvent({
      id: "ar:archived",
      lon,
      lat: 47.0,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "ar-x",
      status: "archived",
    });
    await seedWitness({
      id: "ar:lander",
      lon: lon + 0.0001,
      lat: 47.0,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "ar-l",
    });

    const corroborated = await autoCorroborateOnLanding(sql, "ar:lander", "2026-07-10T12:02:30Z");
    expect(corroborated).toEqual([]);
    expect((await obs("ar:archived")).status).toBe("archived");
    expect(await confirmRowCount("ar:archived")).toBe(0);
    expect((await obs("ar:lander")).evidence_state).toBe("self_reported");
  }, 60_000);

  it("does NOT corroborate onto a FLAGGED survivor reached through the merged chain", async () => {
    const lon = 2.0;
    const latA = 46.0;
    const latB = 46.0 + latOffset(150);
    const latC = 46.0 + latOffset(230);

    await seedWitness({
      id: "fl:A",
      lon,
      lat: latA,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "fl-a",
    });
    await seedWitness({
      id: "fl:B",
      lon,
      lat: latB,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "fl-b",
    });
    await autoCorroborateOnLanding(sql, "fl:B", "2026-07-10T12:02:30Z");
    // Now dispute the survivor A.
    await sql`UPDATE conditions.observations SET flagged_at = '2026-07-10T12:02:45Z' WHERE id = 'fl:A'`;

    await seedWitness({
      id: "fl:C",
      lon,
      lat: latC,
      validFrom: "2026-07-10T12:03:00Z",
      reporterKey: "fl-c",
    });
    const corroborated = await autoCorroborateOnLanding(sql, "fl:C", "2026-07-10T12:03:30Z");

    expect(corroborated).toEqual([]);
    // A gained no new confirm from C; C stays a distinct row for review.
    expect(await distinctConfirmers("fl:A")).toBe(1);
    expect((await obs("fl:C")).status).toBe("active");
  }, 60_000);

  it("FAN-IN: a survivor with two merges (A←B, A←D) credits a 3rd witness that resolves through either merge exactly once", async () => {
    const lon = 7.0;
    const latA = 52.0;
    const latD = 52.0 + latOffset(130);
    const latB = 52.0 + latOffset(150);
    const latC = 52.0 + latOffset(230);

    await seedWitness({
      id: "fi:A",
      lon,
      lat: latA,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "fi-a",
    });
    await seedWitness({
      id: "fi:B",
      lon,
      lat: latB,
      validFrom: "2026-07-10T12:02:00Z",
      reporterKey: "fi-b",
    });
    await autoCorroborateOnLanding(sql, "fi:B", "2026-07-10T12:02:30Z");
    await seedWitness({
      id: "fi:D",
      lon,
      lat: latD,
      validFrom: "2026-07-10T12:03:00Z",
      reporterKey: "fi-d",
    });
    await autoCorroborateOnLanding(sql, "fi:D", "2026-07-10T12:03:30Z");
    // A now has two merges; both B and D are inactive and resolve to A.
    expect((await obs("fi:B")).status).toBe("inactive");
    expect((await obs("fi:D")).status).toBe("inactive");
    expect((await obs("fi:A")).corroborations).toEqual(expect.arrayContaining(["fi:B", "fi:D"]));

    await seedWitness({
      id: "fi:C",
      lon,
      lat: latC,
      validFrom: "2026-07-10T12:04:00Z",
      reporterKey: "fi-c",
    });
    // C neighbors both merged B and D (both resolve to A) — A must be credited by C ONCE.
    const corroborated = await autoCorroborateOnLanding(sql, "fi:C", "2026-07-10T12:04:30Z");

    expect(corroborated).toEqual(["fi:A"]);
    const a = await obs("fi:A");
    expect(a.status).toBe("active");
    expect(a.corroborations!.filter((x) => x === "fi:C")).toHaveLength(1);
    // Exactly one new confirm carrying C's identity (three total: B, D, C).
    const cConfirms = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence
      WHERE observation_id = 'fi:A' AND evidence_kind = 'confirm'
        AND details ->> 'observationId' = 'fi:C'`;
    expect(cConfirms[0]!.n).toBe(1);
    expect(await distinctConfirmers("fi:A")).toBe(3);
    expect(a.routing_eligible).toBe(false);
  }, 60_000);

  it("EARLIER-landed head composition: a just-landed report earlier than the survivor becomes the head and INHERITS the prior witnesses' confirms (no split brain)", async () => {
    // A is the head with confirmer B. C lands with an EARLIER valid_from and
    // matches A directly → isEarlier flips the head to C. C must show BOTH
    // confirmers (A itself + B, migrated), not just one.
    const lon = 8.0;
    const lat = 54.0;
    await seedWitness({
      id: "ei:A",
      lon,
      lat,
      validFrom: "2026-07-10T12:05:00Z",
      reporterKey: "ei-a",
    });
    await seedWitness({
      id: "ei:B",
      lon: lon + 0.0001,
      lat,
      validFrom: "2026-07-10T12:07:00Z",
      reporterKey: "ei-b",
    });
    await autoCorroborateOnLanding(sql, "ei:B", "2026-07-10T12:07:30Z");
    expect((await obs("ei:A")).corroborations).toContain("ei:B");
    expect(await distinctConfirmers("ei:A")).toBe(1);

    // C is EARLIER (12:00) than A (12:05) yet within the match window.
    await seedWitness({
      id: "ei:C",
      lon: lon - 0.0001,
      lat,
      validFrom: "2026-07-10T12:00:00Z",
      reporterKey: "ei-c",
    });
    const corroborated = await autoCorroborateOnLanding(sql, "ei:C", "2026-07-10T12:08:00Z");

    expect(corroborated).toEqual(["ei:A"]);
    // C is now the single active head; A merged in.
    const c = await obs("ei:C");
    expect(c.status).toBe("active");
    expect((await obs("ei:A")).status).toBe("inactive");
    // C inherits A's own confirm (A as a witness) AND B's confirm (migrated).
    expect(await distinctConfirmers("ei:C")).toBe(2);
    expect(c.evidence_state).toBe("corroborated");
    expect(c.confidence_score).toBeCloseTo(0.6375, 4);
    // HARD GUARDRAILS still hold.
    expect(c.routing_eligible).toBe(false);
    expect(await reporterPosterior("ei-a")).toEqual({ alpha: 2, beta: 2 });
    expect(await reporterPosterior("ei-b")).toEqual({ alpha: 2, beta: 2 });
    expect(await reporterPosterior("ei-c")).toEqual({ alpha: 2, beta: 2 });
  }, 60_000);
});
