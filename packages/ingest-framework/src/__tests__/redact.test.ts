import { describe, expect, it } from "vitest";
import { redactUrl, redactSecrets, feedSecretValues } from "../redact.js";

describe("redactUrl", () => {
  it("blanks query-string values but keeps param names and the path", () => {
    const out = redactUrl("https://h.test/a?client_id=abc123&client_secret=xyz789");
    expect(out).toBe("https://h.test/a?client_id=***&client_secret=***");
  });

  it("is path-blind: a secret duplicated into the URL PATH survives (Mobilithek shape)", () => {
    const out = redactUrl(
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/999999secretid/clientPullService?subscriptionID=999999secretid"
    );
    // The query copy is blanked...
    expect(out).not.toContain("subscriptionID=999999secretid");
    // ...but the same value embedded in the path is left untouched — the gap
    // redactSecrets exists to close.
    expect(out).toContain("/subscription/999999secretid/clientPullService");
  });
});

describe("redactSecrets", () => {
  it("blanks a secret value wherever it appears — path, query, and body", () => {
    const text =
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/999999secretid/clientPullService?subscriptionID=999999secretid";
    const out = redactSecrets(text, ["999999secretid"]);
    expect(out).not.toContain("999999secretid");
    expect(out).toBe(
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/***/clientPullService?subscriptionID=***"
    );
  });

  it("does NOT redact a value shorter than the length threshold", () => {
    // A 3-character value (e.g. a country code) is left alone — blanking it
    // would corrupt unrelated substrings elsewhere in the text.
    const out = redactSecrets("https://h.test/de/roads", ["de"]);
    expect(out).toBe("https://h.test/de/roads");
  });

  it("skips empty and whitespace-only values", () => {
    expect(redactSecrets("https://h.test/x", ["", "   "])).toBe("https://h.test/x");
  });

  it("scrubs every occurrence when a secret repeats", () => {
    const out = redactSecrets("id=abcdef123 and again abcdef123", ["abcdef123"]);
    expect(out).toBe("id=*** and again ***");
  });

  it("treats the secret as a literal string, not a regex (metacharacters don't leak a pattern)", () => {
    const weird = "a.b*c+d(zz)"; // 11 chars, over the threshold
    const out = redactSecrets(`url?token=${weird}&x=1`, [weird]);
    expect(out).toBe("url?token=***&x=1");
  });

  it("leaves text with no matching secret unchanged", () => {
    expect(redactSecrets("https://h.test/x", ["unrelated-longer-value"])).toBe("https://h.test/x");
  });

  it("fully redacts both values when one secret is a substring of another (longest-first, no residual)", () => {
    // The shorter value ("secret12") is a substring of the longer one
    // ("secret123456"). If the shorter ran first it would mangle the longer's
    // occurrence, leaving a residual "3456" fragment of the real secret. Both
    // orderings of the input array must produce a fully-scrubbed result.
    const short = "secret12";
    const long = "secret123456";
    const text = `path/${long}/q?id=${short}`;
    for (const order of [
      [short, long],
      [long, short],
    ]) {
      const out = redactSecrets(text, order);
      expect(out).toBe("path/***/q?id=***");
      expect(out).not.toContain("secret");
      expect(out).not.toContain("3456");
    }
  });
});

describe("feedSecretValues", () => {
  it("collects resolved values of the feed's allowed template vars, filtered by length", () => {
    const values = feedSecretValues(
      { auth: { kind: "bearer", envVar: "TOKEN" }, requiredEnv: ["SUB_ID", "SHORT"] },
      { TOKEN: "longenoughtoken", SUB_ID: "999999secretid", SHORT: "ab" }
    );
    expect(values.sort()).toEqual(["999999secretid", "longenoughtoken"].sort());
  });

  it("skips vars that are unset", () => {
    const values = feedSecretValues({ requiredEnv: ["MISSING"] }, {});
    expect(values).toEqual([]);
  });

  it("is empty for a feed with no auth and no requiredEnv", () => {
    expect(feedSecretValues({}, { RANDOM: "somevalue" })).toEqual([]);
  });
});
