import { describe, expect, it } from "vitest";
import { acquire } from "../lib/feed-discovery/acquire.js";

const uuid = (i: number) => `10000000-0000-4000-8000-${i.toString().padStart(12, "0")}`;
const data = (i: number) => ({
  id: uuid(i),
  title: "Parking",
  resources: [
    {
      id: uuid(i + 10000),
      url: "https://transportdata.be/dataset/payload/download/x",
      license_id: "cc0-10",
    },
  ],
});
const response = (count: number, rows: unknown[]) =>
  Response.json({
    success: true,
    result: { count, results: rows },
    nextURL: "https://transportdata.be/dataset/payload/download/x",
  });
function fixture(fn: (url: URL, init: RequestInit | undefined) => Promise<Response> | Response) {
  return (async (input, init) => fn(new URL(String(input)), init)) as typeof fetch;
}
describe("metadata-only acquisition", () => {
  it("advances capped pages by actual count using fixed sort/query and never follows response URLs", async () => {
    const calls: string[] = [];
    const found = await acquire(
      "belgium",
      fixture((url, init) => {
        calls.push(url.href);
        expect(url.origin + url.pathname).toBe(
          "https://transportdata.be/api/3/action/package_search",
        );
        expect([...url.searchParams.keys()].sort()).toEqual(["q", "rows", "sort", "start"]);
        expect(url.searchParams.get("q")).toBe("*:*");
        expect(url.searchParams.get("sort")).toBe("id asc");
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const start = Number(url.searchParams.get("start"));
        return response(
          101,
          Array.from({ length: Math.min(50, 101 - start) }, (_, i) => data(start + i)),
        );
      }),
    );
    expect(calls).toHaveLength(3);
    expect(new URL(calls[1]!).searchParams.get("start")).toBe("50");
    expect(found.result).toMatchObject({ complete: true, datasets: 101, distributions: 101 });
  });
  it.each([
    [() => response(1, []), "premature_empty"],
    [() => Response.json({ success: false, error: { message: "secret" } }), "invalid_envelope"],
    [() => new Response('{"secret-body":bad'), "invalid_json"],
    [() => new Response("secret", { status: 500 }), "http_status"],
    [
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://transportdata.be/dataset/payload" },
        }),
      "redirect_refused",
    ],
    [
      () => {
        throw new Error("body echo secret a@b.org");
      },
      "request_failed",
    ],
  ])("returns an incomplete fixed-code report for adverse metadata", async (fn, code) => {
    const found = await acquire("mobidrom", fixture(fn));
    expect(found.result.complete).toBe(false);
    expect(found.result.diagnostics).toContain(code);
    expect(JSON.stringify(found)).not.toMatch(/secret|a@b/);
  });
  it("distinguishes a healthy empty catalog", async () =>
    expect(
      (
        await acquire(
          "belgium",
          fixture(() => response(0, [])),
        )
      ).result,
    ).toMatchObject({ complete: true, datasets: 0 }));
  it("keeps first-page evidence on count drift and repeated IDs", async () => {
    let calls = 0;
    const drift = await acquire(
      "belgium",
      fixture(() => (++calls === 1 ? response(2, [data(1)]) : response(3, [data(2)]))),
    );
    expect(drift.result).toMatchObject({
      complete: false,
      datasets: 1,
      diagnostics: ["count_drift"],
    });
    const repeat = await acquire(
      "belgium",
      fixture(() => response(2, [data(1)])),
    );
    expect(repeat.result).toMatchObject({
      complete: false,
      datasets: 1,
      diagnostics: ["repeated_id"],
    });
  });
  it("reports page and dataset caps without silent truncation", async () => {
    let i = 0;
    const found = await acquire(
      "belgium",
      fixture(() => response(2001, [data(++i)])),
    );
    expect(found.result.complete).toBe(false);
    expect(found.result.diagnostics).toContain("page_limit");
    expect(found.result.datasets).toBeLessThanOrEqual(2000);
  });
  it("caps streamed bytes even without Content-Length", async () => {
    const body = new Uint8Array(1024 * 1024);
    const found = await acquire(
      "belgium",
      fixture(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 11; i++) controller.enqueue(body);
                controller.close();
              },
            }),
          ),
      ),
    );
    expect(found.result.diagnostics).toContain("body_cap");
  });
  it("allows only the one fixed Latvia metadata path", async () => {
    const found = await acquire(
      "latvia",
      fixture((url) => {
        expect(url.href).toBe("https://transportdata.gov.lv/api/v1/subscriber/metadata_dcat");
        return new Response(
          '<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://www.w3.org/ns/dcat#"><c:Catalog r:about="https://example.org"/></r:RDF>',
        );
      }),
    );
    expect(found.result.complete).toBe(true);
    expect(found.result.metadataUrls).toHaveLength(1);
  });
});
it("enforces a request deadline on a transport waiting for abort", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
    return controller.signal;
  });
  try {
    const pending = acquire(
      "belgium",
      fixture(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("secret", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    await vi.advanceTimersByTimeAsync(30001);
    expect((await pending).result.diagnostics).toEqual(["timeout"]);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
it("marks a twenty-page cap incomplete even when the provider serves one dataset per page", async () => {
  let start = 0;
  const result = await acquire(
    "belgium",
    fixture(() => response(21, [data(start++)])),
  );
  expect(result.result).toMatchObject({
    complete: false,
    datasets: 20,
    diagnostics: ["page_limit"],
  });
});
it("caps cumulative catalog bytes without discarding earlier pages", async () => {
  let i = 0;
  const padding = "x".repeat(8 * 1024 * 1024);
  const found = await acquire(
    "belgium",
    fixture(() =>
      Response.json({
        success: true,
        result: { count: 4, results: [data(i++)] },
        ignored: padding,
      }),
    ),
  );
  expect(found.result).toMatchObject({ complete: false, datasets: 3, diagnostics: ["total_cap"] });
  expect(found.distributions).toHaveLength(3);
});
it("enforces the catalog deadline across individually timely pages and hung injected transports", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  try {
    let i = 0;
    const pending = acquire(
      "belgium",
      fixture(
        () => new Promise((resolve) => setTimeout(() => resolve(response(4, [data(i++)])), 29000)),
      ),
    );
    await vi.advanceTimersByTimeAsync(90001);
    expect((await pending).result).toMatchObject({
      complete: false,
      datasets: 3,
      diagnostics: ["timeout"],
    });
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
it("refuses a declared response exceeding the remaining catalog budget before reading it", async () => {
  let calls = 0,
    reads = 0;
  const found = await acquire(
    "belgium",
    fixture(() => {
      if (calls++ < 3)
        return Response.json({
          success: true,
          result: { count: 4, results: [data(calls)] },
          ignored: "x".repeat(8 * 1024 * 1024),
        });
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new TextEncoder().encode("not-json"));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-length": String(8 * 1024 * 1024) } },
      );
    }),
  );
  expect(found.result.diagnostics).toEqual(["total_cap"]);
  expect(reads).toBe(0);
});
