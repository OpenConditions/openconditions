import { describe, expect, it } from "vitest";
import {
  diffObservations,
  matchesTypeFilter,
  parseTypeFilter,
  sseFrame,
  streamSignature,
} from "../sse.js";
import { measurement, roadEvent } from "./fixture.js";

describe("sseFrame", () => {
  it("frames a JSON data event with a trailing blank line", () => {
    expect(sseFrame({ data: { a: 1 } })).toBe('data: {"a":1}\n\n');
  });

  it("includes id and event fields when given", () => {
    expect(sseFrame({ id: "x", event: "condition", data: { n: 2 } })).toBe(
      'id: x\nevent: condition\ndata: {"n":2}\n\n'
    );
  });

  it("passes string data through verbatim", () => {
    expect(sseFrame({ event: "remove", data: "raw" })).toBe("event: remove\ndata: raw\n\n");
  });
});

describe("parseTypeFilter / matchesTypeFilter", () => {
  it("returns null for no filter (matches everything)", () => {
    expect(parseTypeFilter(undefined)).toBeNull();
    expect(matchesTypeFilter(roadEvent({ type: "accident" }), null)).toBe(true);
    expect(matchesTypeFilter(measurement(), null)).toBe(true);
  });

  it("keeps only events of the listed types", () => {
    const types = parseTypeFilter("accident, road_closure");
    expect(matchesTypeFilter(roadEvent({ type: "accident" }), types)).toBe(true);
    expect(matchesTypeFilter(roadEvent({ type: "congestion" }), types)).toBe(false);
    expect(matchesTypeFilter(measurement(), types)).toBe(false);
  });
});

describe("diffObservations", () => {
  it("treats everything as changed on the first pass", () => {
    const { changed, removed, next } = diffObservations(new Map(), [
      roadEvent({ id: "a" }),
      roadEvent({ id: "b" }),
    ]);
    expect(changed.map((o) => o.id)).toEqual(["a", "b"]);
    expect(removed).toEqual([]);
    expect(next.size).toBe(2);
  });

  it("emits nothing when the snapshot is unchanged", () => {
    const first = diffObservations(new Map(), [roadEvent({ id: "a" })]);
    const second = diffObservations(first.next, [roadEvent({ id: "a" })]);
    expect(second.changed).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it("re-emits an observation whose content changed", () => {
    const first = diffObservations(new Map(), [
      roadEvent({ id: "a", dataUpdatedAt: "2026-06-23T10:00:00Z" }),
    ]);
    const second = diffObservations(first.next, [
      roadEvent({ id: "a", dataUpdatedAt: "2026-06-23T11:00:00Z" }),
    ]);
    expect(second.changed.map((o) => o.id)).toEqual(["a"]);
  });

  it("reports observations that disappeared as removed", () => {
    const first = diffObservations(new Map(), [roadEvent({ id: "a" }), roadEvent({ id: "b" })]);
    const second = diffObservations(first.next, [roadEvent({ id: "a" })]);
    expect(second.changed).toEqual([]);
    expect(second.removed).toEqual(["b"]);
  });

  it("does not mutate the previous map", () => {
    const prev = new Map<string, string>();
    diffObservations(prev, [roadEvent({ id: "a" })]);
    expect(prev.size).toBe(0);
  });
});

describe("streamSignature", () => {
  it("changes when status or update time changes", () => {
    const base = roadEvent({ id: "a", dataUpdatedAt: "2026-06-23T10:00:00Z" });
    expect(streamSignature(base)).toBe(streamSignature(roadEvent({ ...base })));
    expect(streamSignature(base)).not.toBe(
      streamSignature(roadEvent({ ...base, status: "inactive" }))
    );
  });
});
