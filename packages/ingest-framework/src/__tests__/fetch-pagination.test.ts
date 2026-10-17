import { describe, expect, it } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

/** A page-numbered API: `rowsByPage[n - first]` rows on page n, none beyond. */
function pagedApi(rowsByPage: number[], first = 1) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("pageNo"));
    const rows = rowsByPage[page - first] ?? 0;
    return new Response(
      JSON.stringify({ items: { item: Array.from({ length: rows }, (_, i) => i) } }),
      {
        status: 200,
      },
    );
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const feed = (pagination: object) =>
  catalogFeed({
    endpoints: {
      main: {
        url: "https://api.test/chargers?dataType=JSON",
        cadenceSec: 300,
        pagination: { skipParam: "pageNo", pageSize: 3, recordsPath: "items.item", ...pagination },
      },
    },
  });

describe("fetchEndpoint page-number pagination", () => {
  it("counts pages from 1 and stops on a short page", async () => {
    const { fn, calls } = pagedApi([3, 3, 1]);
    const res = await fetchEndpoint(feed({ mode: "page" }), "main", fn, {
      state: createFetchState(),
    });
    expect(res.status === "fetched" && res.buffers).toHaveLength(3);
    expect(calls.map((u) => new URL(u).searchParams.get("pageNo"))).toEqual(["1", "2", "3"]);
  });

  it("starts at firstPage", async () => {
    const { fn, calls } = pagedApi([3, 2], 0);
    await fetchEndpoint(feed({ mode: "page", firstPage: 0 }), "main", fn, {
      state: createFetchState(),
    });
    expect(calls.map((u) => new URL(u).searchParams.get("pageNo"))).toEqual(["0", "1"]);
  });

  it("reads a single-item page and an empty last page the way XML-born JSON writes them", async () => {
    // data.go.kr writes a one-item list as the item, and an empty list as "".
    const row = (id: number) => ({ statId: String(id) });
    const pages = [
      { items: { item: [row(1), row(2), row(3)] } },
      { items: { item: row(4) } },
      { items: { item: [row(5), row(6), row(7)] } },
      { items: "" },
    ];
    const answer = (n: number) =>
      (async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(pages[Number(new URL(String(input)).searchParams.get("pageNo")) - n]),
        )) as unknown as typeof fetch;
    const xml = feed({ mode: "page", xmlLists: true });
    const single = await fetchEndpoint(xml, "main", answer(0), { state: createFetchState() });
    expect(single.status === "fetched" && single.buffers).toHaveLength(1);
    // A total that divides by the page size ends on an empty page.
    const full = await fetchEndpoint(xml, "main", answer(-1), { state: createFetchState() });
    expect(full.status === "fetched" && full.buffers).toHaveLength(1);
    // The first page must still hold the collection.
    await expect(
      fetchEndpoint(xml, "main", answer(-2), { state: createFetchState() }),
    ).rejects.toThrow(/missing collection/);
    // A feed that does not say so keeps the strict reading.
    await expect(
      fetchEndpoint(feed({ mode: "page" }), "main", answer(0), { state: createFetchState() }),
    ).rejects.toThrow(/expected array/);
  });

  it("still fails at maxPages without a terminal page", async () => {
    const { fn } = pagedApi([3, 3, 3, 3]);
    await expect(
      fetchEndpoint(feed({ mode: "page", maxPages: 2 }), "main", fn, { state: createFetchState() }),
    ).rejects.toThrow(/maxPages/);
  });

  it("keeps offset counting by default", async () => {
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ items: { item: calls.length < 2 ? [1, 2, 3] : [1] } }));
    }) as unknown as typeof fetch;
    await fetchEndpoint(feed({}), "main", fn, { state: createFetchState() });
    expect(calls.map((u) => new URL(u).searchParams.get("pageNo"))).toEqual(["0", "3"]);
  });
});

/**
 * An OCPI 2.2.1 server holding `total` locations that returns at most `cap`
 * per page whatever limit is asked, with `X-Limit`, `X-Total-Count` and a
 * `Link` to the next page while one remains. `next` rewrites the link it
 * would send (undefined: none).
 */
function ocpiServer(
  total: number,
  cap: number,
  opts: {
    next?: (offset: number, limit: number) => string | undefined;
    totalCount?: (offset: number) => number | undefined;
  } = {},
) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? cap), cap);
    const data = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
      id: String(offset + i),
    }));
    const headers = new Headers({ "X-Limit": String(cap) });
    const count = opts.totalCount ? opts.totalCount(offset) : total;
    if (count !== undefined) headers.set("X-Total-Count", String(count));
    const nextOffset = offset + data.length;
    const next = opts.next
      ? opts.next(offset, limit)
      : nextOffset < total
        ? `https://ocpi.test/ocpi/2.2.1/locations?offset=${nextOffset}&limit=${limit}`
        : undefined;
    if (next !== undefined) headers.set("Link", `<${next}>; rel="next"`);
    return new Response(
      JSON.stringify({ data, status_code: 1000, timestamp: "2026-10-16T00:00:00Z" }),
      { headers },
    );
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const linkFeed = (pagination: object = {}) =>
  catalogFeed({
    endpoints: {
      main: {
        url: "https://ocpi.test/ocpi/2.2.1/locations?limit=1000",
        cadenceSec: 300,
        pagination: { mode: "link", ...pagination },
      },
    },
  });

const recordsIn = (buffers: Buffer[]) =>
  buffers.flatMap((b) => (JSON.parse(b.toString("utf8")) as { data: { id: string }[] }).data);

describe("fetchEndpoint link pagination (OCPI)", () => {
  it("follows the Link header past a server that caps the page size", async () => {
    const { fn, calls } = ocpiServer(250, 100);
    const res = await fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() });
    if (res.status !== "fetched") throw new Error(res.status);
    expect(recordsIn(res.buffers).map((r) => r.id)).toEqual(
      Array.from({ length: 250 }, (_, i) => String(i)),
    );
    expect(calls).toEqual([
      "https://ocpi.test/ocpi/2.2.1/locations?limit=1000",
      "https://ocpi.test/ocpi/2.2.1/locations?offset=100&limit=100",
      "https://ocpi.test/ocpi/2.2.1/locations?offset=200&limit=100",
    ]);
    expect(res.urls).toEqual(calls);
  });

  it("ends on a page without a next link and takes short pages before it", async () => {
    // A server may return fewer objects than its limit on any page, none
    // even, and still link on; its links may be relative.
    const pages = [["a", "b", "c"], ["d"], [], ["e", "f"]];
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const page = Number(url.searchParams.get("page") ?? "0");
      const headers = new Headers({ "X-Total-Count": "6" });
      if (page < pages.length - 1)
        headers.set("Link", `</ocpi/2.2.1/locations?page=${page + 1}>; rel="next"`);
      return new Response(JSON.stringify({ data: pages[page]!.map((id) => ({ id })) }), {
        headers,
      });
    }) as unknown as typeof fetch;
    const res = await fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() });
    if (res.status !== "fetched") throw new Error(res.status);
    expect(recordsIn(res.buffers).map((r) => r.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toBe("https://ocpi.test/ocpi/2.2.1/locations?page=3");
    // The empty page is not passed on.
    expect(res.buffers).toHaveLength(3);
  });

  it("fails rather than publish fewer records than X-Total-Count reports", async () => {
    // The server stops linking after the first page of three.
    const { fn } = ocpiServer(250, 100, { next: () => undefined });
    await expect(
      fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() }),
    ).rejects.toThrow(/100 of the 250 records/);
  });

  it("reads the total from the last page, which counts objects created mid-crawl", async () => {
    const { fn } = ocpiServer(250, 100, { totalCount: (offset) => (offset < 200 ? 240 : 250) });
    const res = await fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() });
    expect(res.status === "fetched" && recordsIn(res.buffers)).toHaveLength(250);
  });

  it("publishes without a check when the server reports no total", async () => {
    const { fn } = ocpiServer(250, 100, { totalCount: () => undefined });
    const res = await fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() });
    expect(res.status === "fetched" && recordsIn(res.buffers)).toHaveLength(250);
  });

  it("refuses a next link that repeats a page already fetched", async () => {
    const { fn, calls } = ocpiServer(250, 100, {
      next: (offset) =>
        `https://ocpi.test/ocpi/2.2.1/locations?offset=${offset === 0 ? 100 : 0}&limit=100`,
    });
    await expect(
      fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() }),
    ).rejects.toThrow(/repeats/);
    // limit=1000, then offset=100, offset=0, and offset=100 again is refused.
    expect(calls).toHaveLength(3);
  });

  it("stops at maxPages while a next link remains", async () => {
    const { fn, calls } = ocpiServer(250, 100);
    await expect(
      fetchEndpoint(linkFeed({ maxPages: 2 }), "main", fn, { state: createFetchState() }),
    ).rejects.toThrow(/maxPages=2/);
    expect(calls).toHaveLength(2);
  });

  it("never follows a link to another origin", async () => {
    const { fn, calls } = ocpiServer(250, 100, {
      next: () => "https://elsewhere.test/ocpi/2.2.1/locations?offset=100",
    });
    await expect(
      fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() }),
    ).rejects.toThrow(/another origin/);
    expect(calls).toHaveLength(1);
  });

  it("fails on a Link header it cannot read instead of taking it for the last page", async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        headers: { Link: '<https://ocpi.test/next; rel="next"' },
      })) as unknown as typeof fetch;
    await expect(
      fetchEndpoint(linkFeed(), "main", fn, { state: createFetchState() }),
    ).rejects.toThrow(/malformed Link header/);
  });

  it("reads the next page and the total from the body where the publisher puts them there", async () => {
    // OCPDB: `{ items, total_count, next_path }`, next_path absent on the last page.
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const items = Array.from({ length: Math.min(2, 5 - offset) }, (_, i) => offset + i);
      const next = offset + 2 < 5 ? `${url.pathname}?limit=2&offset=${offset + 2}` : undefined;
      return new Response(JSON.stringify({ items, total_count: 5, next_path: next }));
    }) as unknown as typeof fetch;
    const feed = catalogFeed({
      endpoints: {
        main: {
          url: "https://ocpdb.test/ocpi/2.2/tariffs?limit=2",
          cadenceSec: 300,
          pagination: {
            mode: "link",
            recordsPath: "items",
            nextPath: "next_path",
            totalPath: "total_count",
          },
        },
      },
    });
    const res = await fetchEndpoint(feed, "main", fn, { state: createFetchState() });
    expect(res.status === "fetched" && res.buffers).toHaveLength(3);
    expect(calls.map((u) => new URL(u).searchParams.get("offset"))).toEqual([null, "2", "4"]);
  });
});
