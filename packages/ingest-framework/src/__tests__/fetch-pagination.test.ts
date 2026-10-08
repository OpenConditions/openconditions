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
