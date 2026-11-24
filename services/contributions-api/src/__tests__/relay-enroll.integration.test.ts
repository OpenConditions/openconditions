import {
  createTestDatabase,
  TEST_SECRETS_KEY,
  type TestDatabase,
} from "@openconditions/test-database";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTESTER_POLICY } from "../attester/policy.js";
import { build } from "../server.js";
import { INSTANCE } from "./crowd-fixtures.integration.js";

/**
 * The enrollment limit behind a relay: the relay forwards every user's
 * request from its own address, so a request bearing the relay token is
 * counted in the relay's bucket, never in its address's.
 */

const RELAY_TOKEN = "relay-token-for-the-enroll-limit-test";
const BASE_ENV = {
  OPENCONDITIONS_GRANT_SECRET: "relay-enroll-test-secret",
  OPENCONDITIONS_SECRETS_KEY: TEST_SECRETS_KEY,
  OPENCONDITIONS_INSTANCE_ID: INSTANCE,
};

let db: TestDatabase;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  for (const app of apps.splice(0)) await app.close();
  await db?.close();
}, 30_000);

async function app(env: Record<string, string>): Promise<FastifyInstance> {
  const built = await build({ sql: db.sql, env: { ...BASE_ENV, ...env }, logger: false });
  apps.push(built);
  return built;
}

/** Status codes of `count` empty enrollments from one address: 400 when admitted, 429 when limited. */
async function enrollments(
  server: FastifyInstance,
  count: number,
  remoteAddress: string,
  authorization?: string,
): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await server.inject({
      method: "POST",
      url: "/contrib/enroll",
      payload: {},
      remoteAddress,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });
    codes.push(res.statusCode);
  }
  return codes;
}

describe("the enrollment limit behind a relay", () => {
  const perAddress = ATTESTER_POLICY.enrollRateLimitPerMinute;

  it("keys on the address without a relay token configured, whatever the bearer", async () => {
    const server = await app({});
    const codes = await enrollments(server, perAddress + 1, "10.0.0.1", `Bearer ${RELAY_TOKEN}`);
    expect(codes.slice(0, perAddress).every((c) => c === 400)).toBe(true);
    expect(codes[perAddress]).toBe(429);
  });

  it("counts requests bearing the relay token in the relay bucket, not the address's", async () => {
    const server = await app({
      OPENCONDITIONS_RELAY_TOKEN: RELAY_TOKEN,
      OPENCONDITIONS_RELAY_ENROLL_LIMIT_PER_MINUTE: String(perAddress * 3),
    });
    const relayed = await enrollments(server, perAddress * 3, "10.0.0.2", `Bearer ${RELAY_TOKEN}`);
    expect(relayed.every((c) => c === 400)).toBe(true);
    // The relay's own ceiling holds.
    expect(await enrollments(server, 1, "10.0.0.2", `Bearer ${RELAY_TOKEN}`)).toEqual([429]);
    // The address the relay sends from keeps its own, untouched bucket.
    const direct = await enrollments(server, perAddress + 1, "10.0.0.2");
    expect(direct.slice(0, perAddress).every((c) => c === 400)).toBe(true);
    expect(direct[perAddress]).toBe(429);
  });

  it("keys a wrong bearer on its address", async () => {
    const server = await app({ OPENCONDITIONS_RELAY_TOKEN: RELAY_TOKEN });
    const codes = await enrollments(server, perAddress + 1, "10.0.0.3", "Bearer not-the-token");
    expect(codes[perAddress]).toBe(429);
  });

  it("refuses to build with a set but short relay token", async () => {
    await expect(app({ OPENCONDITIONS_RELAY_TOKEN: "short" })).rejects.toThrow(
      /OPENCONDITIONS_RELAY_TOKEN must be at least 32 characters/,
    );
  });
});
