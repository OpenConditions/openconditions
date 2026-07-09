import { describe, expect, it } from "vitest";
import { resolveUrlTemplate, resolveFeedUrls, allowedTemplateVars } from "../index.js";
import { resolvedEnv } from "../index.js";

describe("resolveUrlTemplate", () => {
  it("interpolates ${VAR} tokens from env", () => {
    const out = resolveUrlTemplate(
      "https://h/${K}?id=${ID}",
      { K: "abc", ID: "42" },
      new Set(["K", "ID"])
    );
    expect(out).toBe("https://h/abc?id=42");
  });

  it("leaves a template with no tokens unchanged", () => {
    expect(resolveUrlTemplate("https://h/static.xml", {}, new Set())).toBe("https://h/static.xml");
  });

  it("throws naming the variable when a declared var is unset", () => {
    expect(() => resolveUrlTemplate("https://h?k=${MISSING}", {}, new Set(["MISSING"]))).toThrow(
      /unset variable MISSING/
    );
  });

  it("throws naming the variable when it is not in the allowed set (undeclared)", () => {
    // The template-exfiltration guard: a token naming a var outside the feed's
    // declared `requiredEnv`/auth vars throws BEFORE the env lookup, even when
    // that var happens to be set — it must never resolve from the full env.
    expect(() =>
      resolveUrlTemplate("https://h?k=${SECRET}", { SECRET: "leaked" }, new Set())
    ).toThrow(/undeclared variable SECRET/);
  });

  it("resolves via resolvedEnv so *_FILE-backed values interpolate", () => {
    const env = resolvedEnv({ ID: "  z9 " }); // resolvedEnv trims credential-shaped values
    expect(resolveUrlTemplate("https://h?id=${ID}", env, new Set(["ID"]))).toBe("https://h?id=z9");
  });
});

describe("allowedTemplateVars", () => {
  it("unions requiredEnvVars(auth) with the feed's own requiredEnv", () => {
    const vars = allowedTemplateVars({
      auth: { kind: "bearer", envVar: "TOKEN" },
      requiredEnv: ["EXTRA_ID"],
    });
    expect(vars).toEqual(new Set(["TOKEN", "EXTRA_ID"]));
  });

  it("is empty for a feed with no auth and no requiredEnv", () => {
    expect(allowedTemplateVars({})).toEqual(new Set());
  });
});

describe("resolveFeedUrls", () => {
  it("resolves a single template url", () => {
    const urls = resolveFeedUrls(
      { id: "a", url: "https://h?k=${K}", requiredEnv: ["K"] },
      { K: "v" }
    );
    expect(urls).toEqual(["https://h?k=v"]);
  });

  it("resolves an array of templates", () => {
    const urls = resolveFeedUrls(
      { id: "a", url: ["https://h/1?k=${K}", "https://h/2?k=${K}"], requiredEnv: ["K"] },
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
        requiredEnv: ["SUB"],
      },
      { SUB: "2000001, 2000002" }
    );
    expect(urls).toEqual([
      "https://mobilithek.info/api/subscription/2000001/clientPullService?subscriptionID=2000001",
      "https://mobilithek.info/api/subscription/2000002/clientPullService?subscriptionID=2000002",
    ]);
  });

  it("returns [] when the expandEnv var is unset (a dormant feed)", () => {
    expect(
      resolveFeedUrls(
        { id: "mob", url: "https://h/${SUB}", expandEnv: "SUB", requiredEnv: ["SUB"] },
        {}
      )
    ).toEqual([]);
  });

  it("returns [] when url is absent (discover-only feed)", () => {
    expect(resolveFeedUrls({ id: "d" }, {})).toEqual([]);
  });

  it("throws when a template references a var outside requiredEnv/auth (undeclared)", () => {
    expect(() =>
      resolveFeedUrls({ id: "leaky", url: "https://h?x=${DATABASE_URL}" }, { DATABASE_URL: "x" })
    ).toThrow(/undeclared variable DATABASE_URL/);
  });
});
