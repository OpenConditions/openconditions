import { describe, expect, it } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { guardedImpersonatingFetch, type ImpersonationClient } from "../impersonate.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
const guard = { maxBytes: 1000, timeoutMs: 2000, maxRedirects: 3 };

/** A stand-in for impit: serves `responses` in order and records each request. */
function client(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impit: ImpersonationClient = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responses.shift() ?? new Response("", { status: 500 });
    },
  };
  return { impit, calls };
}

describe("impersonated fetch", () => {
  it("goes through the client and returns the body", async () => {
    const { impit, calls } = client([new Response("hello")]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    const res = await f("https://api.test/poi", { headers: { "X-API-Key": "k" } });
    expect(await res.text()).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init?.headers).get("x-api-key")).toBe("k");
  });

  it("refuses a private-address URL before the client is called", async () => {
    const { impit, calls } = client([new Response("secret")]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    await expect(f("https://127.0.0.1/x")).rejects.toThrow(/internal\/private/);
    await expect(f("https://localhost/x")).rejects.toThrow(/internal\/private/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const { impit, calls } = client([new Response("secret")]);
    const lookup = (async () => [{ address: "10.0.0.5", family: 4 }]) as never;
    const f = guardedImpersonatingFetch({ client: impit, lookup, guard });
    await expect(f("https://rebind.test/x")).rejects.toThrow(/private IP/);
    expect(calls).toHaveLength(0);
  });

  it("refuses http", async () => {
    const { impit, calls } = client([new Response("x")]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    await expect(f("http://api.test/x")).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("re-checks every redirect hop", async () => {
    const { impit, calls } = client([
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }),
    ]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    await expect(f("https://api.test/x")).rejects.toThrow(/internal\/private/);
    expect(calls).toHaveLength(1);
  });

  it("follows a public redirect and drops the credentials across hosts", async () => {
    const { impit, calls } = client([
      new Response(null, { status: 302, headers: { location: "https://cdn.test/y" } }),
      new Response("ok"),
    ]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    const res = await f("https://api.test/x", { headers: { authorization: "Bearer t" } });
    expect(await res.text()).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual(["https://api.test/x", "https://cdn.test/y"]);
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBeNull();
  });

  it("turns a POST into a GET on a 302, as fetch does", async () => {
    const { impit, calls } = client([
      new Response(null, { status: 302, headers: { location: "https://api.test/next" } }),
      new Response("ok"),
    ]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    await f("https://api.test/x", {
      method: "POST",
      body: "payload",
      headers: { "Content-Type": "text/plain", "Content-Encoding": "identity", "X-Trace": "1" },
    });
    expect(calls[1]!.init?.method).toBe("GET");
    expect(calls[1]!.init?.body).toBeUndefined();
    // The body's own headers go with the body; the others stay on the same host.
    expect(Object.keys(calls[1]!.init?.headers ?? {})).toEqual(["x-trace"]);
  });

  it("sends a form body as the form it is, and refuses a body it cannot send", async () => {
    const { impit, calls } = client([new Response("token")]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    await f("https://auth.test/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    expect(calls[0]!.init?.body).toBe("grant_type=client_credentials");
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    await expect(
      f("https://auth.test/upload", { method: "POST", body: new Blob(["x"]) }),
    ).rejects.toThrow(/body/);
    expect(calls).toHaveLength(1);
  });

  it("gives up on a name that never resolves within the deadline", async () => {
    const { impit, calls } = client([new Response("x")]);
    const hung = (() => new Promise(() => {})) as never;
    const f = guardedImpersonatingFetch({
      client: impit,
      lookup: hung,
      guard: { ...guard, timeoutMs: 50 },
    });
    await expect(f("https://slow-dns.test/x")).rejects.toThrow(/timed out/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to replay a request body to another host", async () => {
    const { impit, calls } = client([
      new Response(null, { status: 307, headers: { location: "https://other.test/token" } }),
    ]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    await expect(
      f("https://auth.test/token", { method: "POST", body: "client_secret=SEKRET" }),
    ).rejects.toThrow(/body/);
    expect(calls).toHaveLength(1);
  });

  it("enforces the byte cap on the body", async () => {
    const { impit } = client([new Response("x".repeat(2000))]);
    const f = guardedImpersonatingFetch({ client: impit, lookup: publicLookup, guard });
    const res = await f("https://api.test/big");
    await expect(res.arrayBuffer()).rejects.toThrow(/exceeded/);
  });
});

describe("fetchEndpoint with impersonate", () => {
  const feed = catalogFeed({
    id: "xx-test-events",
    endpoints: {
      main: { url: "https://api.test/poi", cadenceSec: 300, impersonate: true },
    },
    auth: { kind: "header-key", header: "X-API-Key", credential: "key" },
    credentials: { key: { title: "Key" } },
  });

  it("sends the feed's auth through impit, not through the plain fetch", async () => {
    const { impit, calls } = client([new Response("[1]")]);
    let plainCalled = false;
    const plain = (async () => {
      plainCalled = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const env = { XX_TEST_EVENTS_KEY: "secret" };
    const res = await fetchEndpoint(feed, "main", plain, {
      state: createFetchState(),
      env,
      impersonation: { client: impit, lookup: publicLookup },
    });
    expect(res.status === "fetched" && res.buffers[0]!.toString()).toBe("[1]");
    expect(plainCalled).toBe(false);
    expect(new Headers(calls[0]!.init?.headers).get("x-api-key")).toBe("secret");
  });

  it("fetches a followed URL through impit without the feed's auth", async () => {
    const followFeed = catalogFeed({
      id: "xx-test-events",
      endpoints: {
        main: {
          url: "https://api.test/batch",
          cadenceSec: 300,
          impersonate: true,
          follow: { path: "link" },
        },
      },
      auth: { kind: "header-key", header: "X-API-Key", credential: "key" },
      credentials: { key: { title: "Key" } },
    });
    const { impit, calls } = client([
      new Response(`{"link":"https://files.test/x"}`),
      new Response("data"),
    ]);
    const res = await fetchEndpoint(followFeed, "main", fetch, {
      state: createFetchState(),
      env: { XX_TEST_EVENTS_KEY: "secret" },
      impersonation: { client: impit, lookup: publicLookup },
    });
    expect(res.status === "fetched" && res.buffers[0]!.toString()).toBe("data");
    expect(new Headers(calls[0]!.init?.headers).get("x-api-key")).toBe("secret");
    expect(calls[1]!.url).toBe("https://files.test/x");
    expect(new Headers(calls[1]!.init?.headers).get("x-api-key")).toBeNull();
  });

  it("still refuses a private-address endpoint", async () => {
    const privateFeed = catalogFeed({
      endpoints: { main: { url: "https://10.1.2.3/poi", cadenceSec: 300, impersonate: true } },
    });
    const { impit, calls } = client([new Response("[]")]);
    await expect(
      fetchEndpoint(privateFeed, "main", fetch, {
        state: createFetchState(),
        impersonation: { client: impit, lookup: publicLookup },
      }),
    ).rejects.toThrow(/internal\/private/);
    expect(calls).toHaveLength(0);
  });
});
