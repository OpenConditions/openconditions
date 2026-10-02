import { describe, expect, it } from "vitest";
import { diffRecords, recordSignature, sseFrame } from "../sse.js";

type Rec = Record<string, unknown>;

const record = (id: string, contentHash = "h1", evidence?: Rec): Rec => ({
  id,
  contentHash,
  ...(evidence ? { evidence } : {}),
});

describe("sseFrame", () => {
  it("frames a JSON data event with a trailing blank line", () => {
    expect(sseFrame({ data: { a: 1 } })).toBe('data: {"a":1}\n\n');
  });

  it("includes id and event fields when given", () => {
    expect(sseFrame({ id: "x", event: "situation", data: { n: 2 } })).toBe(
      'id: x\nevent: situation\ndata: {"n":2}\n\n',
    );
  });

  it("passes string data through verbatim", () => {
    expect(sseFrame({ event: "remove", data: "raw" })).toBe("event: remove\ndata: raw\n\n");
  });
});

describe("diffRecords", () => {
  it("treats everything as changed on the first pass", () => {
    const { changed, removed, next } = diffRecords(new Map(), [record("a"), record("b")]);
    expect(changed.map((r) => r["id"])).toEqual(["a", "b"]);
    expect(removed).toEqual([]);
    expect(next.size).toBe(2);
  });

  it("emits nothing when the snapshot is unchanged", () => {
    const first = diffRecords(new Map(), [record("a")]);
    const second = diffRecords(first.next, [record("a")]);
    expect(second.changed).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it("re-emits a record whose content or evidence changed", () => {
    const first = diffRecords(new Map(), [record("a"), record("b")]);
    const second = diffRecords(first.next, [
      record("a", "h2"),
      record("b", "h1", { state: "corroborated", confidenceScore: 0.9 }),
    ]);
    expect(second.changed.map((r) => r["id"])).toEqual(["a", "b"]);
  });

  it("reports ids that disappeared, without mutating the previous snapshot", () => {
    const first = diffRecords(new Map(), [record("a"), record("b")]);
    const before = new Map(first.next);
    const second = diffRecords(first.next, [record("b")]);
    expect(second.removed).toEqual(["a"]);
    expect(first.next).toEqual(before);
  });

  it("signs a record by its content hash and evidence summary", () => {
    expect(recordSignature(record("a", "h1"))).not.toBe(recordSignature(record("a", "h2")));
    expect(recordSignature(record("a", "h1", { state: "reported" }))).not.toBe(
      recordSignature(record("a", "h1", { state: "corroborated" })),
    );
  });
});
