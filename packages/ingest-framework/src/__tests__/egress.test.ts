import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPublicUrl } from "../egress.js";

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
