import { expect, test, vi } from "vitest";
import { acquisitionBudget } from "./acquisition-budget.js";

test("counts requests across roles and refuses before opening the excess socket", async () => {
  const fetch = vi.fn(async () => new Response("ok"));
  const b = acquisitionBudget({ requests: 1, bytes: 4, deadlineSec: 30 }, fetch);
  try {
    await (await b.fetch("https://example.org/a")).text();
    await expect(b.fetch("https://example.org/b")).rejects.toThrow("request budget");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => b.check()).toThrow("request budget");
  } finally {
    b.close();
  }
});
test("counts streamed bytes cumulatively even when length headers lie", async () => {
  const b = acquisitionBudget(
    { requests: 4, bytes: 3, deadlineSec: 30 },
    async () => new Response("xx"),
  );
  try {
    await (await b.fetch("https://example.org/a")).text();
    await expect((await b.fetch("https://example.org/b")).text()).rejects.toThrow("byte budget");
    expect(() => b.check()).toThrow("byte budget");
  } finally {
    b.close();
  }
});
test("deadline cancels in-flight I/O and remains fatal after a caught failure", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
  );
  const b = acquisitionBudget({ requests: 4, bytes: 100, deadlineSec: 1 }, fetch);
  const pending = expect(b.fetch("https://example.org/a")).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(() => b.check()).toThrow("deadline");
  b.close();
  vi.useRealTimers();
});

test("parent cancellation prevents subsequent requests", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => new Response("ok"));
  const b = acquisitionBudget(
    { requests: 5, bytes: 100, deadlineSec: 30 },
    fetch,
    controller.signal,
  );
  try {
    controller.abort(new Error("scheduler stop"));
    await expect(b.fetch("https://example.org/a")).rejects.toThrow("scheduler stop");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    b.close();
  }
});
