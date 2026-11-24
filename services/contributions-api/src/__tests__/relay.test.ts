import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY_ENROLL_LIMIT_PER_MINUTE, isRelayed, resolveRelayTrust } from "../relay.js";

const TOKEN = "r".repeat(32);

const request = (authorization?: string) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

describe("resolveRelayTrust", () => {
  it("trusts no relay without a token", () => {
    expect(resolveRelayTrust({})).toBeUndefined();
    expect(resolveRelayTrust({ OPENCONDITIONS_RELAY_TOKEN: "" })).toBeUndefined();
  });

  it("takes a token of at least 32 characters with the default enroll limit", () => {
    expect(resolveRelayTrust({ OPENCONDITIONS_RELAY_TOKEN: TOKEN })).toEqual({
      token: TOKEN,
      enrollLimitPerMinute: DEFAULT_RELAY_ENROLL_LIMIT_PER_MINUTE,
    });
    expect(DEFAULT_RELAY_ENROLL_LIMIT_PER_MINUTE).toBe(600);
  });

  it("fails boot on a set but short token", () => {
    expect(() => resolveRelayTrust({ OPENCONDITIONS_RELAY_TOKEN: "r".repeat(31) })).toThrow(
      /OPENCONDITIONS_RELAY_TOKEN must be at least 32 characters/,
    );
  });

  it("reads the relay enroll limit, refusing anything but a whole number above 0", () => {
    expect(
      resolveRelayTrust({
        OPENCONDITIONS_RELAY_TOKEN: TOKEN,
        OPENCONDITIONS_RELAY_ENROLL_LIMIT_PER_MINUTE: "1200",
      })?.enrollLimitPerMinute,
    ).toBe(1200);
    for (const bad of ["0", "-1", "1.5", "lots"]) {
      expect(() =>
        resolveRelayTrust({
          OPENCONDITIONS_RELAY_TOKEN: TOKEN,
          OPENCONDITIONS_RELAY_ENROLL_LIMIT_PER_MINUTE: bad,
        }),
      ).toThrow(/OPENCONDITIONS_RELAY_ENROLL_LIMIT_PER_MINUTE must be a whole number above 0/);
    }
  });
});

describe("isRelayed", () => {
  const relay = { token: TOKEN, enrollLimitPerMinute: 600 };

  it("is true only for the configured token as the bearer", () => {
    expect(isRelayed(request(`Bearer ${TOKEN}`), relay)).toBe(true);
    expect(isRelayed(request(`Bearer ${TOKEN}x`), relay)).toBe(false);
    expect(isRelayed(request(TOKEN), relay)).toBe(false);
    expect(isRelayed(request(), relay)).toBe(false);
  });

  it("is never true without a configured relay", () => {
    expect(isRelayed(request(`Bearer ${TOKEN}`), undefined)).toBe(false);
  });
});
