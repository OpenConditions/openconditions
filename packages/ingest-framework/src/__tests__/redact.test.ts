import { describe, expect, it } from "vitest";
import { feedSecretValues, redactSecrets, redactUrl } from "../redact.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

describe("redactUrl", () => {
  it("blanks query-string values but keeps param names and the path", () => {
    const out = redactUrl("https://h.test/a?client_id=abc123&client_secret=xyz789");
    expect(out).toBe("https://h.test/a?client_id=***&client_secret=***");
  });

  it("is path-blind: a secret duplicated into the URL PATH survives (Mobilithek shape)", () => {
    const out = redactUrl(
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/999999secretid/clientPullService?subscriptionID=999999secretid",
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
      "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription/***/clientPullService?subscriptionID=***",
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
  const keyed = catalogFeed({
    auth: { kind: "bearer", credential: "token" },
    endpoints: {
      main: { url: "https://m/${sub_id}?region=${short}", cadenceSec: 60 },
    },
  });

  it("collects resolved values of the feed's credentials, filtered by length", () => {
    const values = feedSecretValues(keyed, {
      XX_TEST_EVENTS_TOKEN: "longenoughtoken",
      XX_TEST_EVENTS_SUB_ID: "999999secretid",
      XX_TEST_EVENTS_SHORT: "ab",
    });
    expect(values.sort()).toEqual(["999999secretid", "longenoughtoken"].sort());
  });

  it("collects each item of an expanded list, as the URLs carry them", () => {
    const fanned = catalogFeed({
      credentials: { subscription_id: { title: "Subscription ids" } },
      endpoints: {
        main: {
          url: "https://m/subscription/${subscription_id}/pull?id=${subscription_id}",
          expand: "subscription_id",
          cadenceSec: 60,
        },
      },
    });
    const env = { XX_TEST_EVENTS_SUBSCRIPTION_ID: "648508602333433856, 648512079906336768" };
    expect(feedSecretValues(fanned, env).sort()).toEqual(
      ["648508602333433856, 648512079906336768", "648508602333433856", "648512079906336768"].sort(),
    );
    const message = "HTTP 403 fetching https://m/subscription/648512079906336768/pull";
    expect(redactSecrets(message, feedSecretValues(fanned, env))).toBe(
      "HTTP 403 fetching https://m/subscription/***/pull",
    );
  });

  it("skips credentials that are unset", () => {
    expect(feedSecretValues(keyed, {})).toEqual([]);
  });

  it("is empty for a feed that names no credential", () => {
    expect(feedSecretValues(catalogFeed(), { RANDOM: "somevalue" })).toEqual([]);
  });
});
