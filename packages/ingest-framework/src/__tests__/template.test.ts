import { describe, expect, it } from "vitest";
import { resolveUrlTemplate, resolveFeedUrls } from "../index.js";
import { resolvedEnv } from "../index.js";

describe("resolveUrlTemplate", () => {
  it("interpolates ${VAR} tokens from env", () => {
    const out = resolveUrlTemplate("https://h/${K}?id=${ID}", { K: "abc", ID: "42" });
    expect(out).toBe("https://h/abc?id=42");
  });

  it("leaves a template with no tokens unchanged", () => {
    expect(resolveUrlTemplate("https://h/static.xml", {})).toBe("https://h/static.xml");
  });

  it("throws naming the variable when a referenced var is unset", () => {
    expect(() => resolveUrlTemplate("https://h?k=${MISSING}", {})).toThrow(/MISSING/);
  });

  it("resolves via resolvedEnv so *_FILE-backed values interpolate", () => {
    const env = resolvedEnv({ ID: "  z9 " }); // resolvedEnv trims credential-shaped values
    expect(resolveUrlTemplate("https://h?id=${ID}", env)).toBe("https://h?id=z9");
  });
});

describe("resolveFeedUrls", () => {
  it("resolves a single template url", () => {
    const urls = resolveFeedUrls({ id: "a", url: "https://h?k=${K}" }, { K: "v" });
    expect(urls).toEqual(["https://h?k=v"]);
  });

  it("resolves an array of templates", () => {
    const urls = resolveFeedUrls(
      { id: "a", url: ["https://h/1?k=${K}", "https://h/2?k=${K}"] },
      { K: "v" }
    );
    expect(urls).toEqual(["https://h/1?k=v", "https://h/2?k=v"]);
  });

  it("expands expandEnv into one url per comma-separated item (id in path + query)", () => {
    const urls = resolveFeedUrls(
      {
        id: "mob",
        url: "https://mobilithek.info/api/subscription/${SUB}/clientPullService?subscriptionID=${SUB}",
        expandEnv: "SUB",
      },
      { SUB: "2000001, 2000002" }
    );
    expect(urls).toEqual([
      "https://mobilithek.info/api/subscription/2000001/clientPullService?subscriptionID=2000001",
      "https://mobilithek.info/api/subscription/2000002/clientPullService?subscriptionID=2000002",
    ]);
  });

  it("returns [] when the expandEnv var is unset (a dormant feed)", () => {
    expect(resolveFeedUrls({ id: "mob", url: "https://h/${SUB}", expandEnv: "SUB" }, {})).toEqual(
      []
    );
  });

  it("returns [] when url is absent (discover-only feed)", () => {
    expect(resolveFeedUrls({ id: "d" }, {})).toEqual([]);
  });
});
