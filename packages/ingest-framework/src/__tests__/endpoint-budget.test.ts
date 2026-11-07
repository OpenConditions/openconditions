import { expect, test } from "vitest";
import { budgetFetch } from "../endpoint-budget.js";

test("caps declared and streamed bytes and bounds slow headers and bodies", async () => {
  const budget = { maxBytes: 4, deadlineSec: 0.02 };
  const wrap = (response: Response) =>
    budgetFetch(async () => response, budget)("https://example.test");
  await expect(wrap(new Response("large", { headers: { "content-length": "5" } }))).rejects.toThrow(
    /budget/,
  );
  const res = await wrap(new Response("large"));
  await expect(res.text()).rejects.toThrow(/budget/);
  const ok = await wrap(new Response("okay"));
  expect(await ok.text()).toBe("okay");
  await expect(
    budgetFetch(() => new Promise(() => {}), budget)("https://example.test"),
  ).rejects.toThrow(/deadline/);
  const slow = await wrap(new Response(new ReadableStream({ start() {} })));
  await expect(slow.text()).rejects.toThrow(/deadline/);
});

test("the shared endpoint path applies the budget and leaves legacy endpoints unchanged", async () => {
  const { fetchEndpoint, createFetchState } = await import("../fetch.js");
  const { catalogFeed } = await import("./helpers/catalog-feed.js");
  const feed = catalogFeed({
    id: "budget",
    endpoints: {
      main: {
        url: "https://example.test",
        cadenceSec: 86400,
        budget: { maxBytes: 4, deadlineSec: 1 },
      },
    },
  });
  const upstream = async () => new Response("oversized");
  await expect(
    fetchEndpoint(feed, "main", upstream, { state: createFetchState() }),
  ).rejects.toThrow(/budget/);
  delete feed.endpoints["main"]!.budget;
  const result = await fetchEndpoint(feed, "main", upstream, { state: createFetchState() });
  expect(result.status).toBe("fetched");
});

test("budget applies to the selected impersonation transport too", async () => {
  const { fetchEndpoint, createFetchState } = await import("../fetch.js");
  const { catalogFeed } = await import("./helpers/catalog-feed.js");
  const feed = catalogFeed({
    id: "impersonation-budget",
    endpoints: {
      main: {
        url: "https://example.test",
        cadenceSec: 86400,
        impersonate: true,
        budget: { maxBytes: 4, deadlineSec: 1 },
      },
    },
  });
  await expect(
    fetchEndpoint(
      feed,
      "main",
      async () => {
        throw new Error("wrong transport");
      },
      {
        state: createFetchState(),
        impersonation: {
          client: { fetch: async () => new Response("oversized") },
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        },
      },
    ),
  ).rejects.toThrow(/budget/);
});

test("declared overrun rejects promptly even when transport cancellation never settles", async () => {
  let aborted: AbortSignal | undefined;
  let cancelled = false;
  const request = budgetFetch(
    async (_url, init) => {
      aborted = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
        { headers: { "content-length": "5" } },
      );
    },
    { maxBytes: 4, deadlineSec: 0.01 },
  )("https://example.test");
  const result = await Promise.race([
    request.then(
      () => "resolved",
      (error) => String(error),
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  expect(result).toMatch(/byte budget exceeded/);
  expect(cancelled).toBe(true);
  expect(aborted?.aborted).toBe(true);
});
