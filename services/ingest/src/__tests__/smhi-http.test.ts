import { expect, test } from "vitest";
import { SmhiHttpPolicy } from "../pipeline/smhi-http.js";

test("receipt-time cache deadlines account for Date, Age, response delay and 304", async () => {
  let now = Date.parse("2026-11-09T14:00:00Z");
  const policy = new SmhiHttpPolicy(() => now);
  let calls = 0;
  const upstream = (async () => {
    calls++;
    now += 2000;
    return new Response(calls === 1 ? "body" : null, {
      status: calls === 1 ? 200 : 304,
      headers: {
        date: "Mon, 09 Nov 2026 14:00:00 GMT",
        age: "100",
        "cache-control": "max-age=600",
      },
    });
  }) as typeof fetch;
  const request = policy.wrap(upstream);
  await request("https://example.com/data");
  expect(policy.ready(["https://example.com/data"], now + 497999)).toBe(false);
  expect(policy.ready(["https://example.com/data"], now + 498000)).toBe(true);
  await expect(request("https://example.com/data")).rejects.toThrow(/deadline/);
  expect(calls).toBe(1);
  now += 498000;
  await request("https://example.com/data");
  expect(calls).toBe(2);
  // Date is now older than max-age; a 304 cannot reset the source clock or create a new 600s lease.
  expect(policy.ready(["https://example.com/data"], now + 100000)).toBe(true);
});

test.each(["1200", "Mon, 09 Nov 2026 14:20:00 GMT"])(
  "source-wide backoff honors Retry-After %s and blocks sibling fanout",
  async (retryAfter) => {
    let now = Date.parse("2026-11-09T14:00:00Z");
    const policy = new SmhiHttpPolicy(() => now);
    let calls = 0;
    const upstream = (async () => {
      calls++;
      return new Response("busy", { status: 503, headers: { "retry-after": retryAfter } });
    }) as typeof fetch;
    const request = policy.wrap(upstream);
    await request("https://example.com/1");
    await expect(request("https://example.com/2")).rejects.toThrow(/deadline/);
    expect(calls).toBe(1);
    expect(policy.ready(["https://example.com/2"], now + 1199999)).toBe(false);
    now += 1200000;
    expect(policy.ready(["https://example.com/2"], now)).toBe(true);
  },
);

test("network failure backs off", async () => {
  const now = Date.parse("2026-11-09T14:00:00Z");
  const policy = new SmhiHttpPolicy(() => now);
  await expect(
    policy.wrap((async () => {
      throw new Error("network");
    }) as typeof fetch)("https://example.com/data"),
  ).rejects.toThrow("network");
  expect(policy.ready(["https://example.com/data"], now + 599999)).toBe(false);
});

test.each([200, 304])(
  "stale %s cannot renew source status or enter conditional publication state",
  async (status) => {
    const now = Date.parse("2026-11-09T14:54:44Z");
    const policy = new SmhiHttpPolicy(() => now);
    const request = policy.wrap(
      (async () =>
        new Response(status === 200 ? "captured" : null, {
          status,
          headers: {
            date: "Mon, 09 Nov 2026 14:23:38 GMT",
            age: "1866",
            "cache-control": "max-age=600",
          },
        })) as typeof fetch,
    );
    await expect(request("https://example.com/data")).rejects.toThrow(/stale HTTP/);
  },
);

test("concurrent fanout is serialized and cumulative deadline stops subsequent requests", async () => {
  let now = 1000;
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const policy = new SmhiHttpPolicy(() => now);
  const request = policy.wrap(
    (async () => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      now += 70000;
      active--;
      return new Response("data", { headers: { "cache-control": "no-store" } });
    }) as typeof fetch,
    121000,
  );
  const results = await Promise.allSettled([
    request("https://example.com/1"),
    request("https://example.com/2"),
    request("https://example.com/3"),
  ]);
  expect(maximum).toBe(1);
  expect(calls).toBe(2);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
});

test("429 without Retry-After applies bounded exponential backoff", async () => {
  let now = 1000;
  const policy = new SmhiHttpPolicy(() => now);
  const request = policy.wrap((async () => new Response("busy", { status: 429 })) as typeof fetch);
  await request("https://example.com/1");
  expect(policy.ready([], now + 599999)).toBe(false);
  now += 600000;
  await request("https://example.com/1");
  expect(policy.ready([], now + 1199999)).toBe(false);
});
