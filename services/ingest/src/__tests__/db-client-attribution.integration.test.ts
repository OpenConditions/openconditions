import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const { postgres } = vi.hoisted(() => ({
  postgres: vi.fn((_url: string, _options: unknown) => ({})),
}));
vi.mock("postgres", () => ({ default: postgres }));
vi.mock("@openconditions/ingest-framework", () => ({
  requireCredential: () => "postgres://fixture:fixture@unused.invalid/fixture",
}));
afterEach(() => {
  vi.resetModules();
  postgres.mockClear();
});

function literal(node: ts.Node): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          throw new Error("Only static constructor properties are allowed");
        return [property.name.text, literal(property.initializer)];
      }),
    );
  throw new Error("Client labels and pool settings must remain static literals");
}
function mainOptions(service: string) {
  const file = resolve(import.meta.dirname, `../../../${service}/src/main.ts`);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const options: unknown[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "postgres"
    )
      options.push(literal(node.arguments[1]!));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return options;
}
const pool = { max: 5, idle_timeout: 30, connect_timeout: 10 };
describe("database client attribution", () => {
  it("keeps separate writer and HTTP pools with bounded static startup names", async () => {
    const { sql, apiSql } = await import("../db.js");
    expect(sql).not.toBe(apiSql);
    expect(postgres).toHaveBeenCalledTimes(2);
    expect(postgres.mock.calls.map((call) => call[1])).toEqual([
      { ...pool, connection: { application_name: "openconditions-ingest-writer" } },
      { ...pool, connection: { application_name: "openconditions-ingest-api" } },
    ]);
  });
  it.each([
    ["contributions-api", "openconditions-contributions-api"],
    ["federation", "openconditions-federation-api"],
  ])("keeps %s startup options static without booting the service", (service, name) => {
    expect(mainOptions(service!)).toEqual([{ ...pool, connection: { application_name: name } }]);
  });
  it.skipIf(process.env["OPENCONDITIONS_RUN_ATTRIBUTION_TEST"] !== "1")(
    "exposes all configured names on an owned PostgreSQL 18 instance",
    async () => {
      const { GenericContainer, Wait } = await import("testcontainers");
      const actual = await vi.importActual<{ default: typeof import("postgres") }>("postgres");
      const container = await new GenericContainer(
        "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8",
      )
        .withEnvironment({
          POSTGRES_DB: "attribution_test",
          POSTGRES_USER: "fixture",
          POSTGRES_PASSWORD: "fixture-only",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start();
      const clients: ReturnType<typeof actual.default>[] = [];
      try {
        await import("../db.js");
        const options = [
          ...postgres.mock.calls.map((call) => call[1]),
          ...mainOptions("contributions-api"),
          ...mainOptions("federation"),
        ];
        const observed: string[] = [];
        for (const option of options) {
          const client = actual.default(
            `postgres://fixture:fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/attribution_test`,
            option as Parameters<typeof actual.default>[1],
          );
          clients.push(client);
          const [row] =
            await client`SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
          observed.push(String(row!["application_name"]));
          expect(client.options.max).toBe(5);
          expect(client.options.idle_timeout).toBe(30);
          expect(client.options.connect_timeout).toBe(10);
        }
        expect(observed.sort()).toEqual(
          [
            "openconditions-ingest-writer",
            "openconditions-ingest-api",
            "openconditions-contributions-api",
            "openconditions-federation-api",
          ].sort(),
        );
        const [version] =
          await clients[0]!`SELECT current_setting('server_version_num')::int AS version`;
        expect(Number(version!["version"])).toBeGreaterThanOrEqual(180000);
        expect(Number(version!["version"])).toBeLessThan(190000);
      } finally {
        try {
          await Promise.all(clients.map((client) => client.end({ timeout: 2 })));
        } finally {
          await container.stop();
        }
      }
    },
    120_000,
  );
});
