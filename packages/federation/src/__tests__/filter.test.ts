import { describe, expect, it } from "vitest";
import type { Observation, Provenance } from "@openconditions/core";
import { applyFederationFilter, type FederationFilter } from "../filter.js";
import type { OutboxEntry } from "../outbox.js";

const NOW = "2026-07-13T12:00:00.000Z";

const FEED_ORIGIN: Provenance = {
  kind: "feed",
  attribution: { provider: "Test Authority", license: "CC-BY-4.0" },
};

/** A crowd origin as it rests in the journal: reporter already stripped. */
const CROWD_ORIGIN = {
  kind: "crowd",
  attribution: { provider: "OpenConditions crowd", license: "CC0-1.0" },
} as Provenance;

function obs(overrides: Partial<Observation> & Record<string, unknown> = {}): Observation {
  return {
    id: "obs-1",
    source: "test-src",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    type: "incident",
    category: "incident",
    severity: "medium",
    severitySource: "declared",
    headline: "lane closed",
    status: "active",
    geometry: { type: "Point", coordinates: [5.1, 52.1] },
    origin: FEED_ORIGIN,
    dataUpdatedAt: "2026-07-13T11:00:00.000Z",
    fetchedAt: "2026-07-13T11:00:00.000Z",
    isStale: false,
    privacyClass: "authoritative",
    ...overrides,
  } as Observation;
}

let seq = 0;
function entry(observation: Observation, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  seq += 1;
  return {
    seq,
    txid: String(1000 + seq),
    operation: "create",
    objectId: observation.id,
    canonicalId: null,
    createdAt: NOW,
    observation,
    ...overrides,
  };
}

function tombstone(id: string): OutboxEntry {
  seq += 1;
  return {
    seq,
    txid: String(1000 + seq),
    operation: "delete",
    objectId: id,
    canonicalId: "can-1",
    createdAt: NOW,
    tombstone: true,
  };
}

function ids(entries: OutboxEntry[]): string[] {
  return entries.map((e) => e.objectId);
}

describe("applyFederationFilter — the safe default (no filter)", () => {
  it("keeps feed rows and corroborated-or-better crowd rows, drops self_reported", () => {
    const feed = entry(obs({ id: "feed-1" }));
    const selfReported = entry(
      obs({
        id: "crowd-self",
        origin: CROWD_ORIGIN,
        privacyClass: "crowd_pseudonym",
        evidenceState: "self_reported",
      })
    );
    const corroborated = entry(
      obs({
        id: "crowd-corr",
        origin: CROWD_ORIGIN,
        privacyClass: "crowd_pseudonym",
        evidenceState: "corroborated",
      })
    );
    const resolved = entry(
      obs({
        id: "crowd-res",
        origin: CROWD_ORIGIN,
        privacyClass: "crowd_pseudonym",
        evidenceState: "externally_resolved",
      })
    );
    const out = applyFederationFilter([feed, selfReported, corroborated, resolved], undefined, NOW);
    expect(ids(out)).toEqual(["feed-1", "crowd-corr", "crowd-res"]);
  });

  it("drops share-alike-licensed rows by default (permissive-only)", () => {
    const permissive = entry(obs({ id: "cc-by" }));
    const shareAlike = entry(
      obs({
        id: "odbl",
        origin: { kind: "feed", attribution: { provider: "SA", license: "ODbL-1.0" } },
      })
    );
    const out = applyFederationFilter([permissive, shareAlike], undefined, NOW);
    expect(ids(out)).toEqual(["cc-by"]);
  });

  it("drops crowd rows in a terminal negated/expired state even at the lowest tier", () => {
    const negated = entry(obs({ id: "crowd-neg", origin: CROWD_ORIGIN, evidenceState: "negated" }));
    const expired = entry(obs({ id: "crowd-exp", origin: CROWD_ORIGIN, evidenceState: "expired" }));
    const out = applyFederationFilter(
      [negated, expired],
      { minEvidenceTier: "self_reported" },
      NOW
    );
    expect(out).toEqual([]);
  });
});

describe("applyFederationFilter — explicit opt-ins", () => {
  it("an explicit self_reported opt-in includes self_reported crowd rows", () => {
    const selfReported = entry(
      obs({ id: "crowd-self", origin: CROWD_ORIGIN, evidenceState: "self_reported" })
    );
    const out = applyFederationFilter([selfReported], { minEvidenceTier: "self_reported" }, NOW);
    expect(ids(out)).toEqual(["crowd-self"]);
  });

  it("permissiveOnly: false keeps share-alike rows", () => {
    const shareAlike = entry(
      obs({
        id: "odbl",
        origin: { kind: "feed", attribution: { provider: "SA", license: "ODbL-1.0" } },
      })
    );
    const out = applyFederationFilter([shareAlike], { permissiveOnly: false }, NOW);
    expect(ids(out)).toEqual(["odbl"]);
  });

  it("minEvidenceTier: externally_resolved drops corroborated but never gates feed rows", () => {
    const feed = entry(obs({ id: "feed-1" }));
    const corroborated = entry(
      obs({ id: "crowd-corr", origin: CROWD_ORIGIN, evidenceState: "corroborated" })
    );
    const resolved = entry(
      obs({ id: "crowd-res", origin: CROWD_ORIGIN, evidenceState: "externally_resolved" })
    );
    const out = applyFederationFilter(
      [feed, corroborated, resolved],
      { minEvidenceTier: "externally_resolved" },
      NOW
    );
    expect(ids(out)).toEqual(["feed-1", "crowd-res"]);
  });
});

describe("applyFederationFilter — content filters", () => {
  const filter = (f: FederationFilter): FederationFilter => ({ permissiveOnly: false, ...f });

  it("bbox keeps intersecting geometries and drops the rest", () => {
    const inside = entry(obs({ id: "in", geometry: { type: "Point", coordinates: [5.1, 52.1] } }));
    const outside = entry(
      obs({ id: "out", geometry: { type: "Point", coordinates: [13.4, 52.5] } })
    );
    const crossing = entry(
      obs({
        id: "cross",
        geometry: {
          type: "LineString",
          coordinates: [
            [4.0, 52.0],
            [6.0, 52.2],
          ],
        },
      })
    );
    const out = applyFederationFilter(
      [inside, outside, crossing],
      filter({ bbox: [5.0, 52.0, 5.5, 52.5] }),
      NOW
    );
    expect(ids(out)).toEqual(["in", "cross"]);
  });

  it("types keeps only the listed types", () => {
    const incident = entry(obs({ id: "incident-1", type: "incident" }));
    const roadwork = entry(obs({ id: "roadwork-1", type: "roadwork" }));
    const out = applyFederationFilter([incident, roadwork], filter({ types: ["incident"] }), NOW);
    expect(ids(out)).toEqual(["incident-1"]);
  });

  it("privacyClasses keeps only the listed privacy tiers", () => {
    const authoritative = entry(obs({ id: "auth-1", privacyClass: "authoritative" }));
    const kAnon = entry(obs({ id: "kanon-1", privacyClass: "k_anon" }));
    const out = applyFederationFilter(
      [authoritative, kAnon],
      filter({ privacyClasses: ["authoritative"] }),
      NOW
    );
    expect(ids(out)).toEqual(["auth-1"]);
  });

  it("maxAgeSec drops entries whose dataUpdatedAt is older than the window", () => {
    const fresh = entry(obs({ id: "fresh", dataUpdatedAt: "2026-07-13T11:59:00.000Z" }));
    const old = entry(obs({ id: "old", dataUpdatedAt: "2026-07-13T10:00:00.000Z" }));
    const out = applyFederationFilter([fresh, old], filter({ maxAgeSec: 600 }), NOW);
    expect(ids(out)).toEqual(["fresh"]);
  });
});

describe("applyFederationFilter — tombstones", () => {
  it("always passes delete tombstones through, even under the default filter", () => {
    const gone = tombstone("deleted-1");
    const out = applyFederationFilter([gone], undefined, NOW);
    expect(out).toEqual([gone]);
    const bboxed = applyFederationFilter([gone], { bbox: [0, 0, 1, 1] }, NOW);
    expect(bboxed).toEqual([gone]);
  });
});
