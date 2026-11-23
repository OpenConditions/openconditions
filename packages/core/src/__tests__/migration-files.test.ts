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

function statements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map(shape)
    .filter((s) => s.length > 0);
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
    kind: "seed row",
    pattern: /^INSERT INTO "conditions"\."federation_journal" \([^)]*\) VALUES \([^;]*\);?$/,
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

describe("migration files", () => {
  it("are one generated baseline and one custom file", () => {
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_baseline", "0001_database_objects"]);
  });

  it("the custom migration holds only allowed statement kinds", () => {
    const raw = readFileSync(new URL("0001_database_objects.sql", folder), "utf8");
    const chunks = raw.split("--> statement-breakpoint").filter((c) => shape(c).length > 0);
    expect(chunks.length).toBeGreaterThan(0);
    const refused = chunks.filter((chunk) => {
      const s = shape(chunk);
      if (roleGuard.test(s)) return !isRoleGuardedGrant(chunk);
      return !allowed.some((a) => a.pattern.test(s));
    });
    expect(refused.map(shape)).toEqual([]);
    // Every chunk is one statement: drizzle runs a chunk as one query.
    for (const s of statements(raw)) {
      expect(s.replace(/;$/, "")).not.toContain(";");
    }
  });
});
