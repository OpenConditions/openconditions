import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The migrations folder holds one generated baseline and one custom file with
// what drizzle-kit cannot express. Everything else belongs in the schema code,
// where `drizzle-kit generate` sees it.
const folder = new URL("../../drizzle/", import.meta.url);

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", folder), "utf8")) as Journal;

/** Removes dollar-quoted bodies, string literals and comments, leaving the statement's shape. */
function shape(statement: string): string {
  return statement
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "<body>")
    .replace(/--[^\n]*/g, "")
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/\s+/g, " ")
    .trim();
}

const roleGuard = /^DO <body>( LANGUAGE plpgsql)?;?$/;

/**
 * A DO block may only guard grants by the existence of a role, since the
 * grantee may not exist where the migration runs (the plain PostGIS image of
 * the tests has none of OpenMapX's roles).
 */
function isRoleGuardedGrant(raw: string): boolean {
  const body = /\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/.exec(raw)?.[2];
  if (body === undefined) return false;
  const inner = body
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const guarded =
    /^BEGIN IF (NOT )?EXISTS \(SELECT (1 )?FROM pg_roles WHERE rolname = '[a-z_]+'\) THEN (.*) END IF; END;?$/i.exec(
      inner,
    );
  if (!guarded?.[3]) return false;
  return guarded[3]
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => /^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) /i.test(s));
}

const allowed: { kind: string; pattern: RegExp }[] = [
  { kind: "grant", pattern: /^(GRANT|REVOKE) [^;]*;?$/ },
  { kind: "default privileges", pattern: /^ALTER DEFAULT PRIVILEGES [^;]*;?$/ },
  { kind: "function body check", pattern: /^SET LOCAL check_function_bodies = (on|off);?$/ },
  {
    kind: "function",
    pattern: /^CREATE (OR REPLACE )?FUNCTION "?conditions"?\.[^;]*<body>[^;]*;?$/,
  },
  {
    kind: "trigger",
    pattern:
      /^CREATE TRIGGER \w+ (BEFORE|AFTER) [A-Z ]+ ON "conditions"\."\w+" FOR EACH ROW EXECUTE FUNCTION "conditions"\.\w+\(\);?$/,
  },
  {
    kind: "partitioned observation table",
    pattern:
      /^CREATE TABLE "conditions"\."observation" \([^;]*\) PARTITION BY LIST \("retention_days"\);?$/,
  },
  {
    kind: "observation partition index",
    pattern: /^CREATE INDEX "\w+" ON "conditions"\."observation" USING \w+ \("\w+"\);?$/,
  },
  {
    kind: "observation_latest storage parameters",
    pattern:
      /^ALTER TABLE "conditions"\."observation_latest" SET \([a-z_]+ = [0-9.]+(, [a-z_]+ = [0-9.]+)*\);?$/,
  },
  {
    kind: "observation_latest column storage",
    pattern:
      /^ALTER TABLE "conditions"\."observation_latest" ALTER COLUMN "\w+" SET STORAGE (EXTERNAL|MAIN);?$/,
  },
  // Until the schema code declares this CHECK, the custom file carries it.
  {
    kind: "geonet coverage order",
    pattern:
      /^ALTER TABLE "conditions"\."geonet_coverage" ADD CONSTRAINT "geonet_coverage_order" CHECK \("covered_from" < "covered_until"\);?$/,
  },
];

// The federation journal's first epoch, the one seed row.
const seedRow =
  'INSERT INTO "conditions"."federation_journal" (epoch, started_at, seen_xid, timeline_id) VALUES (gen_random_uuid(), now(), pg_snapshot_xmax(pg_current_snapshot()), NULL);';

/** The statements of a custom migration that are not of an allowed kind, each with why. */
function refusals(sql: string): string[] {
  const refused: string[] = [];
  let seeds = 0;
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const s = shape(chunk);
    if (s.length === 0) continue;
    // A dollar sign in a comment could pair with another and hide the text between them.
    if (/^\s*--.*\$/m.test(chunk)) {
      refused.push(`dollar sign in a comment: ${s}`);
      continue;
    }
    // drizzle runs a chunk as one query, so a chunk is one statement.
    if (s.replace(/;$/, "").includes(";")) {
      refused.push(`more than one statement: ${s}`);
      continue;
    }
    if (s === seedRow) {
      seeds += 1;
      if (seeds > 1) refused.push(`second seed row: ${s}`);
      continue;
    }
    const ok = roleGuard.test(s)
      ? isRoleGuardedGrant(chunk)
      : allowed.some((a) => a.pattern.test(s));
    if (!ok) refused.push(s);
  }
  return refused;
}

describe("migration files", () => {
  it("are one generated baseline and one custom file", () => {
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_baseline", "0001_database_objects"]);
  });

  it("the custom migration holds only allowed statement kinds", () => {
    const raw = readFileSync(new URL("0001_database_objects.sql", folder), "utf8");
    expect(raw.split("--> statement-breakpoint").length).toBeGreaterThan(1);
    expect(refusals(raw)).toEqual([]);
  });

  it.each([
    ["an UPDATE", 'UPDATE "conditions"."source" SET restricted = true;'],
    ["an unguarded DO block", "DO $$ BEGIN DELETE FROM conditions.source; END $$;"],
    [
      "a DO block that does more than grant",
      "DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'openmapx_tiles') THEN DELETE FROM conditions.source; END IF; END $$;",
    ],
    [
      "an index drizzle-kit can generate",
      'CREATE INDEX "x_idx" ON "conditions"."source" USING btree ("id");',
    ],
    [
      "a lowercase table",
      'create table "conditions"."observation" ("id" bigint) partition by list ("id");',
    ],
    [
      "a statement hidden between dollar signs in comments",
      "CREATE FUNCTION conditions.f() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;\n-- costs $$\nDELETE FROM conditions.source;\n-- $$",
    ],
    [
      "a seed row with more rows",
      'INSERT INTO "conditions"."federation_journal" (epoch, started_at, seen_xid, timeline_id) VALUES (gen_random_uuid(), now(), pg_snapshot_xmax(pg_current_snapshot()), NULL), (gen_random_uuid(), now(), pg_snapshot_xmax(pg_current_snapshot()), NULL);',
    ],
    [
      "a seed row with a trailing clause",
      'INSERT INTO "conditions"."federation_journal" (epoch, started_at, seen_xid, timeline_id) VALUES (gen_random_uuid(), now(), pg_snapshot_xmax(pg_current_snapshot()), NULL) ON CONFLICT DO NOTHING;',
    ],
    ["a second seed row", `${seedRow}\n--> statement-breakpoint\n${seedRow}`],
    [
      "two statements in one chunk",
      "GRANT USAGE ON SCHEMA conditions TO a; DROP TABLE conditions.source;",
    ],
  ])("refuses %s", (_name, sql) => {
    expect(refusals(sql)).not.toEqual([]);
  });

  it.each([
    [
      "a role-guarded grant",
      "DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'openmapx_tiles_owner') THEN GRANT USAGE ON SCHEMA conditions TO openmapx_tiles_owner; END IF; END $$;",
    ],
    ["a plain grant", "GRANT SELECT ON conditions.source TO openmapx_tiles_owner;"],
    ["the seed row", seedRow],
  ])("accepts %s", (_name, sql) => {
    expect(refusals(sql)).toEqual([]);
  });
});
