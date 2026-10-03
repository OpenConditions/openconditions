import {
  assertStoredCodesRegistered,
  runMigrations,
  storedRegistryCodes,
} from "@openconditions/core/server";
import { PRIVACY_CLASSES, RegistryCoverageError } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The kernel-closed CHECKs follow the model constants, and the boot check
 * fails a service whose database holds a code the production registry does
 * not register (domain-contributed columns carry no CHECK).
 */
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

async function insertSource(id: string, format: string) {
  await sql`
    INSERT INTO conditions.source (id, domain, format, produces, access_mode, tier, country,
      operator, license, attribution, cadence_sec, freshness_window_sec)
    VALUES (${id}, 'roads', ${format}, 'events', 'bulk', 'authoritative', 'NL', 'ndw',
      'CC0-1.0', 'NDW', 60, 300)`;
}

describe("kernel-closed CHECK constraints", () => {
  it("accept every value of the model's closed vocabularies", async () => {
    for (const [i, privacyClass] of PRIVACY_CLASSES.entries()) {
      await insertRecord("feature", `oc:feature:nl-ndw-flow:chk${i}`, "measurement_site", {
        privacyClass,
      });
    }
    await expect(
      insertRecord("feature", "oc:feature:nl-ndw-flow:bad", "measurement_site", {
        privacyClass: "bogus",
      }),
    ).rejects.toThrow(/feature_privacy_class_enum/);
    await sql`DELETE FROM conditions.feature`;
  }, 60_000);
});

describe("boot coverage check", () => {
  it("passes when every loaded source's format is registered", async () => {
    await insertSource("nl-ndw", "datex2");
    await insertSource("be-miv", "miv");
    expect(await storedRegistryCodes(sql)).toEqual({
      sourceFormats: ["datex2", "miv"],
      kinds: [],
      properties: [],
    });
    await expect(assertStoredCodesRegistered(sql, productionRegistry())).resolves.toBeUndefined();
  }, 30_000);

  it("fails when the database holds a format the registry does not register", async () => {
    await insertSource("xx-old", "retired-format");
    const error = await assertStoredCodesRegistered(sql, productionRegistry()).catch((e) => e);
    expect(error).toBeInstanceOf(RegistryCoverageError);
    expect((error as RegistryCoverageError).gaps).toEqual(['source_format "retired-format"']);
    await sql`DELETE FROM conditions.source`;
  }, 30_000);

  it("ignores the format of a source no longer loaded", async () => {
    await insertSource("nl-ndw", "datex2");
    await insertSource("xx-retired", "retired-format");
    await sql`UPDATE conditions.source SET active = false WHERE id = 'xx-retired'`;
    expect((await storedRegistryCodes(sql)).sourceFormats).toEqual(["datex2"]);
    await expect(assertStoredCodesRegistered(sql, productionRegistry())).resolves.toBeUndefined();
    await sql`DELETE FROM conditions.source`;
  }, 30_000);

  it("lets a service that reads no feed boot before ingest has synced a retired format", async () => {
    await insertSource("xx-old", "retired-format");
    await expect(
      assertStoredCodesRegistered(sql, productionRegistry(), { sourceFormats: false }),
    ).resolves.toBeUndefined();
    await insertRecord("situation", "oc:situation:nl-ndw:s3", "volcano");
    const error = await assertStoredCodesRegistered(sql, productionRegistry(), {
      sourceFormats: false,
    }).catch((e) => e);
    expect((error as RegistryCoverageError).gaps).toEqual(['situation kind "volcano"']);
    await sql`DELETE FROM conditions.situation`;
    await sql`DELETE FROM conditions.source`;
  }, 30_000);

  it("reads the kinds of the class tables and the formats of the loaded sources", async () => {
    await insertRecord("situation", "oc:situation:nl-ndw:s1", "incident");
    await insertRecord("feature", "oc:feature:nl-ndw-flow:f1", "measurement_site");
    await insertSource("nl-ndw", "datex2");
    expect(await storedRegistryCodes(sql)).toEqual({
      sourceFormats: ["datex2"],
      kinds: [
        { class: "feature", code: "measurement_site" },
        { class: "situation", code: "incident" },
      ],
      properties: [],
    });
    await expect(assertStoredCodesRegistered(sql, productionRegistry())).resolves.toBeUndefined();
  }, 30_000);

  it("fails when a class table holds a kind the registry does not register", async () => {
    await insertRecord("situation", "oc:situation:nl-ndw:s2", "volcano");
    const error = await assertStoredCodesRegistered(sql, productionRegistry()).catch((e) => e);
    expect((error as RegistryCoverageError).gaps).toEqual(['situation kind "volcano"']);
    await sql`DELETE FROM conditions.situation`;
    await sql`DELETE FROM conditions.feature`;
    await sql`DELETE FROM conditions.source`;
  }, 30_000);

  it("fails when a series holds a property the registry does not register", async () => {
    await sql`
      INSERT INTO conditions.observation_latest (subject_key, property, source_id, subject_kind,
        reading, template, template_hash, access_mode, result_type, effective_from, since_at)
      VALUES ('location:x', 'air.pm10', 'de-uba', 'location', '{}'::jsonb, '{}'::jsonb, '', 'bulk',
        'quantity', now(), now())`;
    const error = await assertStoredCodesRegistered(sql, productionRegistry()).catch((e) => e);
    expect((error as RegistryCoverageError).gaps).toEqual(['property "air.pm10"']);
    await sql`DELETE FROM conditions.observation_latest`;
  }, 30_000);
});

/** A class-table row with only its required columns; the record body is irrelevant here. */
async function insertRecord(
  table: "situation" | "feature",
  id: string,
  kind: string,
  over: { privacyClass?: string } = {},
) {
  const extra =
    table === "situation"
      ? {
          cols: ", severity, certainty, planned, validity_status",
          vals: ", 'unknown', 'unknown', false, 'active'",
        }
      : { cols: ", lifecycle", vals: ", 'operational'" };
  await sql.unsafe(
    `INSERT INTO conditions.${table} (id, record, canonical_id, kind, domain, temporality,
       source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
       recorded_at, content_hash, fetched_at${extra.cols})
     VALUES ('${id}', '{}'::jsonb, 'c', '${kind}', 'roads', 'live', 'nl-ndw', 'x', 'feed',
       'bulk', '${over.privacyClass ?? "authoritative"}', 'local', 1, now(), 'h', now()${extra.vals})`,
  );
}
