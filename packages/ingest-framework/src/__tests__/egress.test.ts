import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  assertPublicUrl,
  assertResolvesToPublicIp,
  boundedGunzip,
  DEFAULT_MAX_FEED_BYTES,
  guardOptionsFromEnv,
  guardedFetch,
  isPublicUrl,
  resolvePublicIps,
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

  it("rejects the full fe80::/10 link-local range, not just the fe80: prefix", () => {
    // fea0:: falls inside fe80::/10 (second byte 0x80-0xbf) but outside the fe80:/fe8/fe9 prefixes.
    expect(() => assertPublicUrl("http://[fea0::1]")).toThrow(/internal\/private/);
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

  it("rejects a hostname resolving into the fe80::/10 range beyond the fe80: prefix", async () => {
    await expect(
      assertResolvesToPublicIp("evil-linklocal", fakeLookup([{ address: "fea0::1", family: 6 }]))
    ).rejects.toThrow(/private IP/);
  });
});

describe("resolvePublicIps", () => {
  it("returns the validated addresses when all are public", async () => {
    const addrs = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];
    await expect(resolvePublicIps("ok.example.com", fakeLookup(addrs))).resolves.toEqual(addrs);
  });

  it("throws when any address is private", async () => {
    await expect(
      resolvePublicIps(
        "evil.example.com",
        fakeLookup([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ])
      )
    ).rejects.toThrow(/private IP/);
  });

  it("throws when no records resolve", async () => {
    await expect(resolvePublicIps("nx", fakeLookup([]))).rejects.toThrow(/No DNS records/);
  });
});

// A public IPv4 literal as the initial host so the default DNS lookup resolves
// the literal locally (no network) and passes assertResolvesToPublicIp.
const PUBLIC = "http://93.184.216.34/";
const OPTS = { maxBytes: 1_000, timeoutMs: 1_000, maxRedirects: 3 };
// A lookup that pins any hostname to a fixed set of addresses, for the wiring tests.
const pinLookup = (addrs: LookupAddr[]) =>
  (async () => addrs) as unknown as Parameters<typeof guardedFetch>[3];

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

  it("strips the Authorization header on a cross-origin redirect", async () => {
    const start = "http://198.51.100.7/";
    const seenAuth: Array<string | null> = [];
    const base = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seenAuth.push(new Headers(init?.headers).get("authorization"));
      if (url === start) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.34/next" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await guardedFetch(base, OPTS)(start, {
      headers: { Authorization: "Bearer SEKRET" },
    });
    expect(await res.text()).toBe("ok");
    expect(seenAuth).toEqual(["Bearer SEKRET", null]);
  });

  it("preserves the Authorization header on a same-host redirect", async () => {
    const seenAuth: Array<string | null> = [];
    const base = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seenAuth.push(new Headers(init?.headers).get("authorization"));
      if (url === PUBLIC) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.34/next" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await guardedFetch(base, OPTS)(PUBLIC, {
      headers: { Authorization: "Bearer SEKRET" },
    });
    expect(await res.text()).toBe("ok");
    expect(seenAuth).toEqual(["Bearer SEKRET", "Bearer SEKRET"]);
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

  it("reaches the base fetch for a bracketed public IPv6-literal URL (DNS check strips brackets)", async () => {
    const base = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await guardedFetch(base, OPTS)("http://[2606:2800:220:1:248:1893:25c8:1946]/");
    expect(await res.text()).toBe("ok");
  });

  it("pins the connection: passes an undici dispatcher built from the validated IP", async () => {
    const seen: { dispatcher?: unknown } = {};
    const base = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.dispatcher = (init as { dispatcher?: unknown }).dispatcher;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await guardedFetch(
      base,
      OPTS,
      {},
      pinLookup([{ address: "93.184.216.34", family: 4 }])
    )("https://rebind.example.com/");
    expect(await res.text()).toBe("ok");
    // undici's Agent exposes a `dispatch` method — a plain object would not.
    expect(seen.dispatcher).toBeDefined();
    expect(typeof (seen.dispatcher as { dispatch?: unknown }).dispatch).toBe("function");
  });

  it("rejects before opening a socket when the hostname resolves to a private IP", async () => {
    const base = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    await expect(
      guardedFetch(
        base,
        OPTS,
        {},
        pinLookup([{ address: "10.0.0.5", family: 4 }])
      )("https://rebind.example.com/")
    ).rejects.toThrow(/private IP/);
    expect(base).not.toHaveBeenCalled();
  });

  it("guardOptionsFromEnv reads the caps with sane defaults", () => {
    expect(guardOptionsFromEnv({})).toEqual({
      maxBytes: DEFAULT_MAX_FEED_BYTES,
      timeoutMs: 60_000,
      maxRedirects: 5,
    });
    // The default must clear the largest default-enabled feed: NDW's site table
    // decompresses to ~373 MiB, so the cap has to sit comfortably above it.
    expect(DEFAULT_MAX_FEED_BYTES).toBe(512 * 1024 * 1024);
    expect(DEFAULT_MAX_FEED_BYTES).toBeGreaterThan(390 * 1024 * 1024);
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
