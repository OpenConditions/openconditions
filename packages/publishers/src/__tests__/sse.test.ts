import { createParser, type EventSourceMessage } from "eventsource-parser";
import { describe, expect, it } from "vitest";
import { diffRecords, recordSignature, type SseMessage, sseFrame } from "../sse.js";

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

  it("sends each line of multi-line data as its own data field", () => {
    expect(sseFrame({ data: "a\nb\r\nc\rd" })).toBe("data: a\ndata: b\ndata: c\ndata: d\n\n");
  });

  it("refuses an event name that would end its field", () => {
    expect(() => sseFrame({ event: "a\nb", data: 1 })).toThrow(TypeError);
  });
});

/**
 * Parses a stream with eventsource-parser, an implementation of the WHATWG
 * `text/event-stream` interpretation rules that shares no code with
 * {@link sseFrame}. The stream is fed in chunks of `size` code units, so
 * fields split across reads are reassembled.
 */
function parse(stream: string, size = stream.length) {
  const events: EventSourceMessage[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const errors: unknown[] = [];
  const parser = createParser({
    onEvent: (event) => events.push(event),
    onComment: (comment) => comments.push(comment),
    onRetry: (retry) => retries.push(retry),
    onError: (error) => errors.push(error),
  });
  for (let i = 0; i < stream.length; i += size) parser.feed(stream.slice(i, i + size));
  return { events, comments, retries, errors };
}

/** What a conforming client receives for one message. */
const received = (msg: SseMessage): EventSourceMessage => ({
  id: msg.id,
  event: msg.event,
  data: typeof msg.data === "string" ? msg.data.replace(/\r\n?/g, "\n") : JSON.stringify(msg.data),
});

const tricky: SseMessage[] = [
  { id: "oc:situation:x:1", event: "situation", data: { id: "oc:situation:x:1", n: 1 } },
  { event: "situation", data: { text: "line\nbreak\r\nand\rcarriage", tab: "\t" } },
  { data: "first\nsecond\r\nthird\rfourth" },
  { data: "trailing line feed\n" },
  { data: "\n\nleading blank lines" },
  { data: "  two leading spaces" },
  { data: ": not a comment" },
  { data: "data: not a field" },
  { data: "" },
  { event: "remove", data: { id: "oc:situation:x:2" } },
  { data: { text: "Düsseldorf 🚧    \u0085 ﻿ 道路 \u0000" } },
  { id: "id with spaces and ünïcode ✓", data: "x" },
  { data: { long: "x".repeat(1_048_576) } },
  { data: "y".repeat(262_144) },
];

describe("sseFrame against an independent text/event-stream parser", () => {
  it("frames every message so the parser receives its id, event and data unchanged", () => {
    const stream = tricky.map(sseFrame).join("");
    const { events, comments, retries, errors } = parse(stream);
    expect(errors).toEqual([]);
    expect(comments).toEqual([]);
    expect(retries).toEqual([]);
    expect(events).toEqual(tricky.map(received));
  });

  it("frames identically however the stream is split into reads", () => {
    const short = tricky.slice(0, 12);
    const stream = short.map(sseFrame).join("");
    for (const size of [1, 2, 3, 7, 64]) {
      expect(parse(stream, size).events, `chunks of ${size}`).toEqual(short.map(received));
    }
  });

  it("keeps heartbeats as comments between events", () => {
    const stream = `${sseFrame({ data: 1 })}: ping\n\n${sseFrame({ data: 2 })}: ping 7.3\n\n`;
    const { events, comments } = parse(stream);
    expect(events.map((e) => e.data)).toEqual(["1", "2"]);
    expect(comments).toEqual(["ping", "ping 7.3"]);
  });

  it("leaves out an id a client could not take, keeping the event", () => {
    for (const id of ["a\nid: forged", "a\rb", "a\u0000b"]) {
      const { events } = parse(sseFrame({ id, event: "situation", data: "x" }));
      expect(events).toEqual([{ id: undefined, event: "situation", data: "x" }]);
    }
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
