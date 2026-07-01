import { describe, expect, it } from "vitest";
import { assertPublicUrl, assertResolvesToPublicIp, isPublicUrl } from "../egress.js";

describe("assertPublicUrl", () => {
  it("accepts ordinary public https/http URLs", () => {
    expect(() => assertPublicUrl("https://example.com")).not.toThrow();
    // an existing keyless road feed that legitimately serves over http:
    expect(() => assertPublicUrl("http://opendata.ndw.nu/some/path")).not.toThrow();
  });

  it("rejects the cloud-metadata endpoint and other private/loopback addresses", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data")).toThrow(
      /internal\/private/
    );
    expect(() => assertPublicUrl("http://127.0.0.1")).toThrow(/internal\/private/);
    expect(() => assertPublicUrl("http://10.1.2.3")).toThrow(/internal\/private/);
    expect(() => assertPublicUrl("http://[::1]")).toThrow(/internal\/private/);
    expect(() => assertPublicUrl("http://localhost:8080")).toThrow(/internal\/private/);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("ftp://example.com")).toThrow(/HTTP\(S\)/);
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(/HTTP\(S\)/);
  });

  it("isPublicUrl mirrors assertPublicUrl without throwing", () => {
    expect(isPublicUrl("https://example.com")).toBe(true);
    expect(isPublicUrl("http://169.254.169.254")).toBe(false);
    expect(isPublicUrl("not a url")).toBe(false);
  });
});

type LookupAddr = { address: string; family: number };
const fakeLookup = (addrs: LookupAddr[]) =>
  (async () => addrs) as unknown as Parameters<typeof assertResolvesToPublicIp>[1];

describe("assertResolvesToPublicIp", () => {
  it("rejects a hostname that resolves to a private IPv4 (DNS rebinding)", async () => {
    await expect(
      assertResolvesToPublicIp("evil.example.com", fakeLookup([{ address: "10.0.0.5", family: 4 }]))
    ).rejects.toThrow(/private IP/);
  });

  it("rejects the metadata IP even reached via DNS", async () => {
    await expect(
      assertResolvesToPublicIp("meta.evil", fakeLookup([{ address: "169.254.169.254", family: 4 }]))
    ).rejects.toThrow(/private IP/);
  });

  it("rejects a hostname resolving to IPv6 loopback", async () => {
    await expect(
      assertResolvesToPublicIp("evil6", fakeLookup([{ address: "::1", family: 6 }]))
    ).rejects.toThrow(/private IP/);
  });

  it("accepts a hostname resolving only to public addresses", async () => {
    await expect(
      assertResolvesToPublicIp(
        "ok.example.com",
        fakeLookup([{ address: "93.184.216.34", family: 4 }])
      )
    ).resolves.toBeUndefined();
  });

  it("throws when no records resolve", async () => {
    await expect(assertResolvesToPublicIp("nx", fakeLookup([]))).rejects.toThrow(/No DNS records/);
  });
});
