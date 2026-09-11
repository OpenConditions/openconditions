import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResolverClient } from "../client.js";
import type { OpenLrLocation } from "../decode.js";

const DUMMY_LOCATION: OpenLrLocation = {
  type: "line",
  points: [
    {
      sequenceNumber: 1,
      longitude: 4.7539,
      latitude: 52.3749,
      frc: 6,
      fow: 3,
      lfrcnp: 5,
      bearing: 129,
      distanceToNext: 100,
      isLast: false,
    },
    {
      sequenceNumber: 2,
      longitude: 4.7552,
      latitude: 52.374,
      frc: 6,
      fow: 3,
      lfrcnp: null,
      bearing: 130,
      distanceToNext: 0,
      isLast: true,
    },
  ],
  positiveOffset: 0,
  negativeOffset: 0,
};

const DUMMY_GEOMETRY = {
  type: "LineString" as const,
  coordinates: [
    [4.7539, 52.3749],
    [4.7552, 52.374],
  ],
};

describe("createResolverClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to <baseUrl>/resolve with the location body and returns geometry on 200", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ geometry: DUMMY_GEOMETRY, confidence: 0.95 }, { status: 200 })
    );

    const client = createResolverClient("https://resolver.example.com");
    const result = await client.resolve(DUMMY_LOCATION);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://resolver.example.com/resolve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ location: DUMMY_LOCATION });

    expect(result).toEqual(DUMMY_GEOMETRY);
  });

  it("strips a trailing slash from baseUrl before appending /resolve", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ geometry: DUMMY_GEOMETRY, confidence: 0.8 }, { status: 200 })
    );

    const client = createResolverClient("https://resolver.example.com/");
    await client.resolve(DUMMY_LOCATION);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://resolver.example.com/resolve");
  });

  it("returns null on 404", async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 404 }));

    const client = createResolverClient("https://resolver.example.com");
    const result = await client.resolve(DUMMY_LOCATION);

    expect(result).toBeNull();
  });

  it("throws on non-2xx responses other than 404", async () => {
    fetchMock.mockResolvedValue(Response.json({}, { status: 500 }));

    const client = createResolverClient("https://resolver.example.com");
    await expect(client.resolve(DUMMY_LOCATION)).rejects.toThrow("500");
  });

  it("throws when a 200 response body is missing the geometry field", async () => {
    fetchMock.mockResolvedValue(Response.json({ confidence: 0.9 }, { status: 200 }));

    const client = createResolverClient("https://resolver.example.com");
    await expect(client.resolve(DUMMY_LOCATION)).rejects.toThrow(
      "openlr-resolver returned a 200 response with no geometry field"
    );
  });

  it.each([
    "bad",
    {},
    { type: "Point", coordinates: [8, 50] },
    { type: "LineString", coordinates: [[8, 50]] },
    {
      type: "LineString",
      coordinates: [
        [181, 50],
        [8, 50],
      ],
    },
    {
      type: "LineString",
      coordinates: [
        [8, 91],
        [8, 50],
      ],
    },
    {
      type: "LineString",
      coordinates: [
        ["8", 50],
        [8, 50],
      ],
    },
    {
      type: "LineString",
      coordinates: [
        [null, 50],
        [8, 50],
      ],
    },
  ])("rejects malformed geometry: %j", async (geometry) => {
    fetchMock.mockResolvedValue(Response.json({ geometry }));
    await expect(createResolverClient("http://resolver").resolve(DUMMY_LOCATION)).rejects.toThrow(
      "invalid LineString"
    );
  });

  it("bounds streamed bytes and cancels the response", async () => {
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(33));
          },
          cancel() {
            cancelled = true;
          },
        })
      )
    );
    await expect(
      createResolverClient("http://resolver", { maxResponseBytes: 32 }).resolve(DUMMY_LOCATION)
    ).rejects.toThrow("byte limit");
    expect(cancelled).toBe(true);
  });

  it("bounds headers and body on a real connection, then recovers", async () => {
    vi.unstubAllGlobals();
    let mode: "ok" | "headers" | "body" = "ok";
    const server = createServer((_req, res) => {
      if (mode === "headers") return;
      if (mode === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"geometry":');
        return;
      }
      res.end(JSON.stringify({ geometry: DUMMY_GEOMETRY }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = createResolverClient(`http://127.0.0.1:${address.port}`, { timeoutMs: 200 });
    try {
      expect(await client.resolve(DUMMY_LOCATION)).toEqual(DUMMY_GEOMETRY);
      for (const stalled of ["headers", "body"] as const) {
        mode = stalled;
        await expect(client.resolve(DUMMY_LOCATION)).rejects.toThrow("deadline exceeded");
      }
      mode = "ok";
      expect(await client.resolve(DUMMY_LOCATION)).toEqual(DUMMY_GEOMETRY);
      const abort = new AbortController();
      abort.abort(new Error("caller stopped"));
      await expect(client.resolve(DUMMY_LOCATION, abort.signal)).rejects.toThrow("caller stopped");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
