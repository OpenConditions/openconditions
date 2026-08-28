import { describe, expect, it } from "vitest";
import { createTrustProxy } from "../trust-proxy.js";

describe("createTrustProxy", () => {
  it("trusts a single private or loopback proxy by default", () => {
    const trustProxy = createTrustProxy(undefined);

    expect(trustProxy("127.0.0.1", 0)).toBe(true);
    expect(trustProxy("172.18.0.2", 0)).toBe(true);
    expect(trustProxy("fd00::2", 0)).toBe(true);
  });

  it("does not trust public peers", () => {
    const trustProxy = createTrustProxy(undefined);

    expect(trustProxy("203.0.113.10", 0)).toBe(false);
  });

  it("never trusts forwarded addresses beyond the immediate proxy", () => {
    const trustProxy = createTrustProxy(undefined);

    expect(trustProxy("172.18.0.2", 1)).toBe(false);
  });

  it("supports an explicit comma-separated address allowlist", () => {
    const trustProxy = createTrustProxy(" 192.0.2.0/24, 2001:db8::/32 ");

    expect(trustProxy("192.0.2.10", 0)).toBe(true);
    expect(trustProxy("2001:db8::10", 0)).toBe(true);
    expect(trustProxy("172.18.0.2", 0)).toBe(false);
  });

  it("fails closed when configured with an empty allowlist", () => {
    const trustProxy = createTrustProxy("  , ");

    expect(trustProxy("127.0.0.1", 0)).toBe(false);
  });

  it("rejects invalid proxy ranges at startup", () => {
    expect(() => createTrustProxy("not-an-address")).toThrow(/invalid IP address/);
  });
});
