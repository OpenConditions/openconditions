import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { grantConsumerRoles } from "../db/migrate.js";

/** A client whose queries fail with the given errors in turn, then succeed. */
function clientFailing(...errors: object[]) {
  const queries: string[] = [];
  const client = ((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    const error = errors.shift();
    return error === undefined ? Promise.resolve([]) : Promise.reject(error);
  }) as unknown as postgres.Sql;
  return { client, queries };
}

const concurrent = { code: "XX000", message: "tuple concurrently updated" };

describe("grantConsumerRoles", () => {
  it("calls the grant function once", async () => {
    const { client, queries } = clientFailing();
    await grantConsumerRoles(client);
    expect(queries).toEqual(["SELECT conditions.grant_consumer_roles()"]);
  });

  it.each([
    ["a concurrent catalog update", concurrent],
    ["a serialization failure", { code: "40001", message: "could not serialize access" }],
  ])("tries once more after %s", async (_name, error) => {
    const { client, queries } = clientFailing(error);
    await grantConsumerRoles(client);
    expect(queries).toHaveLength(2);
  });

  it("gives up when the second try fails too", async () => {
    const { client, queries } = clientFailing(concurrent, concurrent);
    await expect(grantConsumerRoles(client)).rejects.toBe(concurrent);
    expect(queries).toHaveLength(2);
  });

  it.each([
    ["any other error", { code: "42501", message: "permission denied for table source" }],
    ["another internal error", { code: "XX000", message: "cache lookup failed" }],
  ])("fails at once on %s", async (_name, error) => {
    const { client, queries } = clientFailing(error);
    await expect(grantConsumerRoles(client)).rejects.toBe(error);
    expect(queries).toHaveLength(1);
  });
});
