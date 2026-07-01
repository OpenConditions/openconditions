import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { feedSourceBaseSchema } from "../feed-schema.js";
import type { FeedSourceBase } from "../feed-source.js";

const valid: FeedSourceBase = {
  id: "ndw",
  name: "NDW (Netherlands)",
  format: "datex2",
  url: "http://opendata.ndw.nu/actueel_beeld.xml.gz",
  gzip: true,
  cadenceSec: 60,
  freshnessWindowSec: 300,
  license: "CC0-1.0",
  licenseUrl: "https://www.ndw.nu",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  privacyUrl: "https://www.ndw.nu/privacy",
  enabledByDefault: true,
};

describe("feedSourceBaseSchema", () => {
  it("parses a valid feed", () => {
    const parsed = feedSourceBaseSchema.parse(valid);
    expect(parsed.id).toBe("ndw");
  });

  it("accepts every FeedAuth kind via the discriminated union", () => {
    const auths = [
      { kind: "none" },
      { kind: "query-key", param: "key", envVar: "K" },
      { kind: "header-key", header: "AccountKey", envVar: "K" },
      { kind: "basic", userEnvVar: "U", passEnvVar: "P" },
      { kind: "bearer", envVar: "K" },
      {
        kind: "oauth2-client-credentials",
        tokenUrl: "https://t/token",
        clientIdEnvVar: "CID",
        clientSecretEnvVar: "CSEC",
      },
      { kind: "mtls", certEnvVar: "C", keyEnvVar: "K" },
    ] as const;
    for (const auth of auths) {
      expect(feedSourceBaseSchema.safeParse({ ...valid, auth }).success).toBe(true);
    }
  });

  it("rejects a feed missing license", () => {
    const { license: _drop, ...noLicense } = valid;
    expect(feedSourceBaseSchema.safeParse(noLicense).success).toBe(false);
  });

  it("rejects an unknown auth.kind (union exhaustiveness at the data boundary)", () => {
    const res = feedSourceBaseSchema.safeParse({ ...valid, auth: { kind: "cookie-jar" } });
    expect(res.success).toBe(false);
  });

  it("rejects an unknown top-level key (.strict — no silent-ignore like Transitous)", () => {
    const res = feedSourceBaseSchema.safeParse({ ...valid, discover: "somethingExecutable" });
    expect(res.success).toBe(false);
  });
});

// Both directions: the inferred type and the hand-written interface must agree.
// If either line fails to compile the schema has drifted from FeedSourceBase.
type Inferred = z.infer<typeof feedSourceBaseSchema>;
const _a = {} as Inferred satisfies FeedSourceBase;
const _b = {} as FeedSourceBase satisfies Inferred;
void _a;
void _b;
