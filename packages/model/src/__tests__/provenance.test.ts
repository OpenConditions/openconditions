import { describe, expect, it } from "vitest";
import { FUSION_TIERS, provenanceSchema, SOURCE_TIERS } from "../kernel/provenance.js";
import { anyVocab } from "../kernel/vocab.js";

const stored = provenanceSchema(anyVocab, "stored");
const draft = provenanceSchema(anyVocab, "draft");

const feed = {
  origin: "feed",
  sourceId: "nl-ndw",
  sourceFormat: "datex2",
  accessMode: "bulk",
  recordId: "SRA-1",
  attribution: { provider: "NDW", license: "CC0-1.0" },
  instanceId: "maps.example.org",
  privacy: { class: "authoritative" },
};
const { instanceId: _instance, ...feedDraft } = feed;

describe("Provenance", () => {
  it("requires the writing instance on stored records and forbids it on drafts", () => {
    expect(stored.safeParse(feed).success).toBe(true);
    expect(stored.safeParse(feedDraft).success).toBe(false);
    expect(draft.safeParse(feedDraft).success).toBe(true);
    expect(draft.safeParse(feed).success).toBe(false);
  });

  it("ties the source id to the origin", () => {
    expect(stored.safeParse({ ...feed, sourceId: "maps.example.org" }).success).toBe(false);
    expect(stored.safeParse({ ...feed, origin: "crowd" }).success).toBe(false);
    expect(stored.safeParse({ ...feed, origin: "crowd", sourceId: "crowd" }).success).toBe(true);
    expect(stored.safeParse({ ...feed, sourceId: "@fused" }).success).toBe(false);
    expect(stored.safeParse({ ...feed, origin: "derived", sourceId: "@fused" }).success).toBe(true);
  });

  it("keeps a raw payload reference as a sha256", () => {
    expect(stored.safeParse({ ...feed, rawRef: { hash: "a".repeat(64) } }).success).toBe(true);
    expect(stored.safeParse({ ...feed, rawRef: { hash: "abc" } }).success).toBe(false);
  });

  it("ranks source tiers before crowd evidence in the default fusion order", () => {
    expect(FUSION_TIERS.slice(0, SOURCE_TIERS.length)).toEqual(SOURCE_TIERS);
    expect(FUSION_TIERS.at(-1)).toBe("crowd_self_reported");
  });
});
