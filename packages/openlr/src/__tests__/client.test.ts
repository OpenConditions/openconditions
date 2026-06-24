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
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ geometry: DUMMY_GEOMETRY, confidence: 0.95 }),
    });

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
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ geometry: DUMMY_GEOMETRY, confidence: 0.8 }),
    });

    const client = createResolverClient("https://resolver.example.com/");
    await client.resolve(DUMMY_LOCATION);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://resolver.example.com/resolve");
  });

  it("returns null on 404", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    });

    const client = createResolverClient("https://resolver.example.com");
    const result = await client.resolve(DUMMY_LOCATION);

    expect(result).toBeNull();
  });

  it("throws on non-2xx responses other than 404", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    });

    const client = createResolverClient("https://resolver.example.com");
    await expect(client.resolve(DUMMY_LOCATION)).rejects.toThrow("500");
  });

  it("throws when a 200 response body is missing the geometry field", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ confidence: 0.9 }),
    });

    const client = createResolverClient("https://resolver.example.com");
    await expect(client.resolve(DUMMY_LOCATION)).rejects.toThrow(
      "openlr-resolver returned a 200 response with no geometry field"
    );
  });
});
