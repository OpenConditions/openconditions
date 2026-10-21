import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventSource } from "eventsource";
import { afterEach, describe, expect, it } from "vitest";
import { startRecordStream } from "../record-stream.js";

type Rec = Record<string, unknown>;

/**
 * The public record stream read by the `eventsource` package, which follows
 * the WHATWG EventSource processing model (framing, last event ID,
 * reconnection) independently of the emitter, over a real HTTP connection.
 */

const plain: Rec = {
  id: "oc:situation:interop:plain",
  class: "situation",
  contentHash: "h1",
  headline: [{ lang: "de", text: "Düsseldorf 🚧 Süd" }],
};
const awkward: Rec = {
  // A source id may hold NUL; the EventSource algorithm ignores such an id.
  id: "oc:situation:interop:a\u0000b",
  class: "situation",
  contentHash: "h2",
  description: "line one\nline two\r\nline three\rline four   \u0085 ﻿",
  long: "x".repeat(512 * 1024),
};

const servers: Server[] = [];
const sources: EventSource[] = [];
afterEach(() => {
  for (const source of sources.splice(0)) source.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Serves the stream; each connection reads the next snapshot list in turn. */
async function serve(snapshots: Rec[][][]): Promise<{ url: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    const reads = snapshots[requests.length] ?? [[]];
    requests.push(req);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let read = 0;
    const stop = startRecordStream({
      output: res,
      read: async () => {
        const records = reads[Math.min(read, reads.length - 1)]!;
        read += 1;
        // The last snapshot of a connection ends it, so the client reconnects.
        if (read === reads.length) setTimeout(() => stop(), 50);
        return records;
      },
      pollMs: 10,
      onError: (error) => {
        throw error;
      },
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/stream`, requests };
}

interface Received {
  type: string;
  data: unknown;
  lastEventId: string;
}

function collect(url: string, until: (events: Received[]) => boolean): Promise<Received[]> {
  const source = new EventSource(url);
  sources.push(source);
  const events: Received[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stream stalled: ${events.length}`)), 10_000);
    for (const type of ["situation", "remove"]) {
      source.addEventListener(type, (event) => {
        events.push({ type, data: JSON.parse(event.data), lastEventId: event.lastEventId });
        if (until(events)) {
          clearTimeout(timer);
          source.close();
          resolve(events);
        }
      });
    }
  });
}

describe("public record stream through a WHATWG EventSource client", () => {
  it("delivers records, removals and ids exactly as written", async () => {
    const { url } = await serve([[[plain, awkward], [plain]]]);
    const events = await collect(url, (e) => e.some((x) => x.type === "remove"));
    expect(events).toEqual([
      { type: "situation", data: plain, lastEventId: plain["id"] },
      // The NUL id is not sent, so the last event ID stays the previous one.
      { type: "situation", data: awkward, lastEventId: plain["id"] },
      { type: "remove", data: { id: awkward["id"] }, lastEventId: plain["id"] },
    ]);
  });

  it("reconnects with the last event ID the stream set", async () => {
    const { url, requests } = await serve([[[plain, awkward]], [[awkward]]]);
    // The second connection starts afresh and sends its whole snapshot again.
    const events = await collect(url, (e) => e.length === 3);
    expect(events.map((e) => [(e.data as Rec)["id"], e.lastEventId])).toEqual([
      [plain["id"], plain["id"]],
      [awkward["id"], plain["id"]],
      [awkward["id"], plain["id"]],
    ]);
    expect(requests[0]!.headers["last-event-id"]).toBeUndefined();
    expect(requests[1]!.headers["last-event-id"]).toBe(plain["id"]);
  });
});
