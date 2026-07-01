import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  assertResolvesToPublicIp,
  boundedGunzip,
  guardOptionsFromEnv,
  guardedFetch,
  isPublicUrl,
} from "../egress.js";

describe("assertPublicUrl", () => {
  it("accepts ordinary public https/http URLs", () => {
    expect(() => assertPublicUrl("https://example.com")).not.toThrow();
    // an existing keyless road feed that legitimately serves over http:
    expect(() => assertPublicUrl("http://opendata.ndw.nu/some/path")).not.toThrow();
  });

  it("rejects the cloud-metadata endpoint and other private/loopback addresses", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data")).toThrow(
      /internal\/private/
    );
    expect(() => assertPublicUrl("http://127.0.0.1")).toThrow(/internal\/private/);
    expect(() => assertPublicUrl("http://10.1.2.3")).toThrow(/internal\/private/);
    expect(() => assertPublicUrl("http://[::1]")).toThrow(/internal\/private/);
    expect(() => assertPublicUrl("http://localhost:8080")).toThrow(/internal\/private/);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("ftp://example.com")).toThrow(/HTTP\(S\)/);
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(/HTTP\(S\)/);
  });

  it("isPublicUrl mirrors assertPublicUrl without throwing", () => {
    expect(isPublicUrl("https://example.com")).toBe(true);
    expect(isPublicUrl("http://169.254.169.254")).toBe(false);
    expect(isPublicUrl("not a url")).toBe(false);
  });
});

type LookupAddr = { address: string; family: number };
const fakeLookup = (addrs: LookupAddr[]) =>
  (async () => addrs) as unknown as Parameters<typeof assertResolvesToPublicIp>[1];

describe("assertResolvesToPublicIp", () => {
  it("rejects a hostname that resolves to a private IPv4 (DNS rebinding)", async () => {
    await expect(
      assertResolvesToPublicIp("evil.example.com", fakeLookup([{ address: "10.0.0.5", family: 4 }]))
    ).rejects.toThrow(/private IP/);
  });

  it("rejects the metadata IP even reached via DNS", async () => {
    await expect(
      assertResolvesToPublicIp("meta.evil", fakeLookup([{ address: "169.254.169.254", family: 4 }]))
    ).rejects.toThrow(/private IP/);
  });

  it("rejects a hostname resolving to IPv6 loopback", async () => {
    await expect(
      assertResolvesToPublicIp("evil6", fakeLookup([{ address: "::1", family: 6 }]))
    ).rejects.toThrow(/private IP/);
  });

  it("accepts a hostname resolving only to public addresses", async () => {
    await expect(
      assertResolvesToPublicIp(
        "ok.example.com",
        fakeLookup([{ address: "93.184.216.34", family: 4 }])
      )
    ).resolves.toBeUndefined();
  });

  it("throws when no records resolve", async () => {
    await expect(assertResolvesToPublicIp("nx", fakeLookup([]))).rejects.toThrow(/No DNS records/);
  });
});

// A public IPv4 literal as the initial host so the default DNS lookup resolves
// the literal locally (no network) and passes assertResolvesToPublicIp.
const PUBLIC = "http://93.184.216.34/";
const OPTS = { maxBytes: 1_000, timeoutMs: 1_000, maxRedirects: 3 };

describe("guardedFetch", () => {
  it("rejects a redirect that points at the metadata IP", async () => {
    const base = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      })) as unknown as typeof fetch;
    await expect(guardedFetch(base, OPTS)(PUBLIC)).rejects.toThrow(/internal\/private/);
  });

  it("follows a public redirect and returns the final response", async () => {
    const base = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === PUBLIC) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.34/next" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await guardedFetch(base, OPTS)(PUBLIC);
    expect(await res.text()).toBe("ok");
  });

  it("aborts a body that streams past maxBytes", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(5_000)));
        controller.close();
      },
    });
    const base = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const res = await guardedFetch(base, { ...OPTS, maxBytes: 100 })(PUBLIC);
    await expect(res.arrayBuffer()).rejects.toThrow(/exceeded/);
  });

  it("fires the timeout via the injected AbortSignal", async () => {
    const base = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(guardedFetch(base, { ...OPTS, timeoutMs: 10 })(PUBLIC)).rejects.toThrow();
  });

  it("stops after too many redirects", async () => {
    const base = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://93.184.216.34/loop" },
      })) as unknown as typeof fetch;
    await expect(guardedFetch(base, { ...OPTS, maxRedirects: 2 })(PUBLIC)).rejects.toThrow(
      /too many redirects/
    );
  });

  it("guardOptionsFromEnv reads the caps with sane defaults", () => {
    expect(guardOptionsFromEnv({})).toEqual({
      maxBytes: 256 * 1024 * 1024,
      timeoutMs: 60_000,
      maxRedirects: 5,
    });
    expect(
      guardOptionsFromEnv({
        OPENCONDITIONS_MAX_FEED_BYTES: "1024",
        OPENCONDITIONS_FETCH_TIMEOUT_MS: "",
      }).maxBytes
    ).toBe(1024);
  });
});

describe("boundedGunzip", () => {
  it("throws on a gzip bomb instead of buffering the whole expansion", async () => {
    const bomb = gzipSync(Buffer.alloc(50_000, 0)); // ~tiny gzip, expands to 50k
    await expect(boundedGunzip(bomb, 1_000)).rejects.toThrow(/exceeded/);
  });

  it("returns the decompressed bytes when under the cap", async () => {
    const raw = gzipSync(Buffer.from("hello world"));
    const out = await boundedGunzip(raw, 1_000);
    expect(out.toString("utf8")).toBe("hello world");
  });
});
