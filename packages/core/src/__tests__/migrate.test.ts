import { describe, it, expect } from "vitest";
import { MIGRATION_SQL } from "../db/index.js";

describe("MIGRATION_SQL", () => {
  it("creates the conditions schema", () => {
    expect(MIGRATION_SQL).toContain("CREATE SCHEMA IF NOT EXISTS conditions");
  });

  it("creates the observations table", () => {
    expect(MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS conditions.observations");
  });

  it("includes the kind column", () => {
    expect(MIGRATION_SQL).toContain("kind");
  });

  it("includes the attributes column", () => {
    expect(MIGRATION_SQL).toContain("attributes");
  });

  it("includes the origin column", () => {
    expect(MIGRATION_SQL).toContain("origin");
  });

  it("includes the GiST index on geom", () => {
    expect(MIGRATION_SQL).toContain("USING GIST (geom)");
  });
});
