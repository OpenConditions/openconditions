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

interface Scanned {
  /** The text with comments removed, whitespace collapsed and each dollar-quoted body as `<body>`. */
  shape: string;
  /** The dollar-quoted bodies, in order. */
  bodies: string[];
  /** The semicolons outside strings, identifiers, bodies and comments. */
  semicolons: number;
  /** Why the text cannot be scanned safely, if it cannot. */
  error?: string;
}

const identifierStart = /[A-Za-z_]/;
const identifierPart = /[A-Za-z0-9_$]/;

/**
 * Reads SQL left to right as PostgreSQL does, recognising `'…'` strings with
 * `''` escapes, `"…"` identifiers, `$tag$…$tag$` bodies, `--` comments and
 * `/* … *\/` comments in order of appearance, so a dollar sign or semicolon
 * inside one of them can neither open another nor end a statement. Strings
 * become `'…'` in the shape unless `keepStrings` is set; identifiers stay as
 * written. Escape strings (`E'…'`) are refused, since backslashes change
 * where they end.
 */
function scan(sql: string, keepStrings = false): Scanned {
  let shape = "";
  const bodies: string[] = [];
  let semicolons = 0;
  let i = 0;
  const fail = (error: string): Scanned => ({ shape, bodies, semicolons, error });
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      shape += " ";
    } else if (sql.startsWith("/*", i)) {
      // PostgreSQL nests block comments.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) return fail("unterminated block comment");
      i = j;
      shape += " ";
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        const end = sql.indexOf("'", j);
        if (end === -1) return fail("unterminated string");
        if (sql.charAt(end + 1) === "'") {
          j = end + 2;
          continue;
        }
        j = end + 1;
        break;
      }
      shape += keepStrings ? sql.slice(i, j) : "'…'";
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      for (;;) {
        const end = sql.indexOf('"', j);
        if (end === -1) return fail("unterminated quoted identifier");
        if (sql.charAt(end + 1) === '"') {
          j = end + 2;
          continue;
        }
        j = end + 1;
        break;
      }
      shape += sql.slice(i, j);
      i = j;
    } else if (c === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag === undefined) {
        shape += c;
        i += 1;
        continue;
      }
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) return fail(`unterminated ${tag} body`);
      bodies.push(sql.slice(i + tag.length, end));
      shape += "<body>";
      i = end + tag.length;
    } else if (identifierStart.test(c)) {
      let j = i + 1;
      while (j < sql.length && identifierPart.test(sql.charAt(j))) j += 1;
      const word = sql.slice(i, j);
      if (/^[Ee]$/.test(word) && sql.charAt(j) === "'") return fail("escape string");
      shape += word;
      i = j;
    } else {
      if (c === ";") semicolons += 1;
      shape += c;
      i += 1;
    }
  }
  return { shape: shape.replace(/\s+/g, " ").trim(), bodies, semicolons };
}

const roleGuard = /^DO <body>( LANGUAGE plpgsql)?;?$/;

/**
 * A DO block may only guard grants by the existence of a role, since the
 * grantee may not exist where the migration runs (the plain PostGIS image of
 * the tests has none of OpenMapX's roles).
 */
function isRoleGuardedGrant(body: string): boolean {
  const inner = scan(body, true);
  if (inner.error !== undefined) return false;
  const guarded =
    /^BEGIN IF (NOT )?EXISTS \(SELECT (1 )?FROM pg_roles WHERE rolname = '[a-z_]+'\) THEN (.*) END IF; END;?$/i.exec(
      inner.shape,
    );
  if (!guarded?.[3]) return false;
  return guarded[3]
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => /^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) [^']*$/i.test(s));
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
];

// The federation journal's first epoch, the one seed row.
const seedRow =
  'INSERT INTO "conditions"."federation_journal" (epoch, started_at, seen_xid, timeline_id) VALUES (gen_random_uuid(), now(), pg_snapshot_xmax(pg_current_snapshot()), NULL);';

/** The statements of a custom migration that are not of an allowed kind, each with why. */
function refusals(sql: string): string[] {
  const refused: string[] = [];
  let seeds = 0;
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const scanned = scan(chunk);
    const s = scanned.shape;
    if (scanned.error !== undefined) {
      refused.push(`${scanned.error}: ${s}`);
      continue;
    }
    if (s.length === 0) continue;
    // drizzle runs a chunk as one query, so a chunk is one statement.
    if (scanned.semicolons > 1 || (scanned.semicolons === 1 && !s.endsWith(";"))) {
      refused.push(`more than one statement: ${s}`);
      continue;
    }
    // A definer function runs with its owner's rights, so it pins its search path.
    if (/\bSECURITY DEFINER\b/i.test(s) && !/\bSET search_path\b/i.test(s)) {
      refused.push(`security definer function without a pinned search path: ${s}`);
      continue;
    }
    if (s === seedRow) {
      seeds += 1;
      if (seeds > 1) refused.push(`second seed row: ${s}`);
      continue;
    }
    const ok = roleGuard.test(s)
      ? scanned.bodies.length === 1 && isRoleGuardedGrant(scanned.bodies[0] ?? "")
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
      "a CHECK drizzle-kit can generate",
      'ALTER TABLE "conditions"."geonet_coverage" ADD CONSTRAINT "geonet_coverage_order_check" CHECK ("covered_from" < "covered_until");',
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
    [
      "a statement hidden between dollar signs in mid-line comments",
      "GRANT USAGE ON SCHEMA conditions TO a; -- $$\nDELETE FROM conditions.source; -- $$",
    ],
    [
      "a statement hidden between dollar signs in block comments",
      "GRANT USAGE ON SCHEMA conditions TO a /* $$ */; DELETE FROM conditions.source; /* $$ */",
    ],
    [
      "a statement hidden between dollar signs in quoted identifiers",
      'GRANT USAGE ON SCHEMA conditions TO "a$$"; DELETE FROM conditions.source; -- "$$"',
    ],
    [
      "a statement hidden in a role-guarded grant's string",
      "DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'a') THEN GRANT USAGE ON SCHEMA conditions TO a; END IF; END $$; DELETE FROM conditions.source; SELECT '$$';",
    ],
    ["an unterminated body", "CREATE FUNCTION conditions.f() RETURNS integer AS $$ SELECT 1;"],
    [
      "an escape string",
      "GRANT USAGE ON SCHEMA conditions TO a; SELECT E'\\'; DELETE FROM conditions.source; --';",
    ],
    [
      "a security definer function without a pinned search path",
      "CREATE FUNCTION conditions.f() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;",
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
    [
      "dollar signs and semicolons inside comments, strings and identifiers",
      'GRANT SELECT ON "conditions"."a$b" TO openmapx_tiles_owner; -- costs $$; more\n/* $x$ ; */',
    ],
    [
      "a security definer function with a pinned search path",
      "CREATE FUNCTION conditions.f() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;",
    ],
  ])("accepts %s", (_name, sql) => {
    expect(refusals(sql)).toEqual([]);
  });
});
