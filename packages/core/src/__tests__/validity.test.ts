import { describe, expect, it } from "vitest";
import type { QueryRunner } from "../query-runner.js";
import { validWhilePolled, withPolledValidity } from "../validity.js";

type Rec = Record<string, unknown>;

const registry = {
  property: (code: string) =>
    code === "charging.evse_status"
      ? ({ retention: { changeOnly: true } } as never)
      : code === "traffic.speed"
        ? ({ retention: { rawDays: 2 } } as never)
        : undefined,
};

const reading = (over: Rec = {}, provenance: Rec = {}): Rec => ({
  id: "r",
  property: "charging.evse_status",
  result: { type: "category", value: "available", vocabulary: "evse_status" },
  phenomenonTime: { instant: "2026-10-04T10:00:00.000Z" },
  provenance: { origin: "feed", sourceId: "fr-irve", accessMode: "bulk", ...provenance },
  ...over,
});

/**
 * A runner answering the polling query with `untils` (source → valid until)
 * and the receipt query with `receipts` (peer → source → valid until),
 * recording the sources each query asked for.
 */
function runner(
  untils: Record<string, string>,
  receipts: Record<string, Record<string, string>> = {},
): QueryRunner & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    execute: async <T>(query: string, params?: unknown[]) => {
      calls.push(params ?? []);
      const wanted = (params?.[0] as string[]) ?? [];
      if (query.includes("federation_source_receipt")) {
        return Object.entries(receipts).flatMap(([peer, bySource]) =>
          wanted
            .filter((s) => bySource[s] !== undefined)
            .map((s) => ({
              peer_instance_id: peer,
              source_id: s,
              valid_until: new Date(bySource[s]!),
            })),
        ) as T;
      }
      return wanted
        .filter((s) => untils[s] !== undefined)
        .map((source) => ({ source, valid_until: new Date(untils[source]!) })) as T;
    },
  };
}

describe("validWhilePolled", () => {
  it("holds for a bulk feed's reading of a change-only property only", () => {
    expect(validWhilePolled(registry, reading())).toBe(true);
    expect(validWhilePolled(registry, reading({}, { accessMode: "on_demand" }))).toBe(false);
    expect(validWhilePolled(registry, reading({}, { origin: "crowd" }))).toBe(false);
    expect(validWhilePolled(registry, reading({ property: "traffic.speed" }))).toBe(false);
  });
});

describe("withPolledValidity", () => {
  it("dates a polled reading by its source's polling, and leaves the rest as they are", async () => {
    const db = runner({ "fr-irve": "2026-10-07T12:28:00.000Z" });
    const stated = reading({ validUntil: "2026-10-07T13:00:00.000Z" });
    const speed = reading({ property: "traffic.speed" });
    const out = await withPolledValidity(db, registry, [reading(), stated, speed]);
    expect(out).toEqual([{ ...reading(), validUntil: "2026-10-07T12:28:00.000Z" }, stated, speed]);
    expect(db.calls).toEqual([[["fr-irve"]]]);
  });

  it("gives a fused reading the latest validity of its feeds, never a crowd report's", async () => {
    const db = runner({ a: "2026-10-07T12:00:00.000Z", b: "2026-10-07T12:30:00.000Z" });
    const fused = reading(
      {},
      {
        origin: "derived",
        sourceId: "@fused",
        mergedSources: [{ source: "a" }, { source: "crowd" }, { source: "b" }],
      },
    );
    const [out] = await withPolledValidity(db, registry, [fused]);
    expect(out).toEqual({ ...fused, validUntil: "2026-10-07T12:30:00.000Z" });
    // The feeds' own polling; their arrivals from peers in case this instance polls none.
    expect(db.calls).toEqual([[["a", "b"]], [["a", "b"]]]);
  });

  it("dates a peer's reading by its source's arrival from that peer, never by polling here", async () => {
    const peer = (instanceId: string) =>
      reading(
        {},
        { instanceId, originChain: [{ instanceId, receivedAt: "2026-10-07T12:00:00.000Z" }] },
      );
    const db = runner(
      { "fr-irve": "2026-10-07T12:59:00.000Z" },
      {
        "peer.a": { "fr-irve": "2026-10-07T12:20:00.000Z" },
        "peer.b": { "fr-irve": "2026-10-07T12:40:00.000Z" },
      },
    );
    const out = await withPolledValidity(db, registry, [peer("peer.a"), peer("peer.c"), reading()]);
    expect(out.map((r) => r["validUntil"])).toEqual([
      "2026-10-07T12:20:00.000Z",
      undefined,
      "2026-10-07T12:59:00.000Z",
    ]);
    // A fused reading of a source polled nowhere here takes its latest arrival.
    const fused = reading(
      {},
      { origin: "derived", sourceId: "@fused", mergedSources: [{ source: "fr-irve" }] },
    );
    const [onlyPeers] = await withPolledValidity(
      runner({}, { "peer.a": { "fr-irve": "2026-10-07T12:20:00.000Z" } }),
      registry,
      [fused],
    );
    expect(onlyPeers?.["validUntil"]).toBe("2026-10-07T12:20:00.000Z");
  });

  it("gives none where the source never polled successfully, and asks nothing for no such reading", async () => {
    const unknown = reading({}, { sourceId: "peer-feed" });
    expect(await withPolledValidity(runner({}), registry, [unknown])).toEqual([unknown]);
    const db = runner({});
    await withPolledValidity(db, registry, [reading({}, { origin: "crowd", sourceId: "crowd" })]);
    expect(db.calls).toEqual([]);
  });
});
