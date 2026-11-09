import { expect, test, vi } from "vitest";
import { JmaAcquisition, type JmaDownload, type JmaDownloadStore } from "../jma-acquisition.js";

const now = Date.parse("2026-11-09T11:17:00Z");
const xml = (updated = "2026-11-09T11:01:10Z") =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><updated>${updated}</updated></feed>`;
function setup(response: () => Response) {
  const cache = new Map<string, JmaDownload>();
  const store: JmaDownloadStore = {
    withUrl: async (url, action) =>
      action(cache.get(url), async (value) => {
        cache.set(url, value);
      }),
    reserve: async () => {},
    settle: async () => {},
  };
  const transport = vi.fn<typeof fetch>(async () => response());
  let clock = now;
  const acquisition = new JmaAcquisition(
    store,
    "test",
    () => clock,
    transport,
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  return {
    acquisition,
    cache,
    transport,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
test("quiet publication accepts fresh transport, cache cadence and conditional recovery", async () => {
  let conditional = false;
  const s = setup(() =>
    conditional
      ? new Response(null, {
          status: 304,
          headers: { date: new Date(now + 3_600_000).toUTCString() },
        })
      : new Response(xml(), { headers: { date: new Date(now).toUTCString(), etag: '"quiet"' } }),
  );
  expect((await s.acquisition.poll("eqvol", [], undefined, AbortSignal.timeout(1000))).gap).toBe(
    true,
  );
  s.advance(1000);
  expect(
    (await s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000))).networkValidated,
  ).toBe(false);
  expect(s.transport).toHaveBeenCalledTimes(2);
  conditional = true;
  s.advance(3_599_000);
  expect(
    (await s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000))).networkValidated,
  ).toBe(true);
  expect(s.transport).toHaveBeenCalledTimes(4);
});
test.each([
  new Headers({ age: "601" }),
  new Headers({ date: new Date(now - 601_000).toUTCString() }),
  new Headers({ date: new Date(now + 61_000).toUTCString() }),
  new Headers({ age: "invalid" }),
])("stale or invalid transport metadata refuses the recent index: %j", async (headers) => {
  const s = setup(() => new Response(xml(), { headers }));
  await expect(s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000))).rejects.toThrow(
    "transport",
  );
  expect(s.cache.size).toBe(0);
});
test("future publication and backward publication cannot replace an index validator", async () => {
  let updated = "2026-11-09T11:18:01Z";
  const s = setup(() => new Response(xml(updated)));
  await expect(s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000))).rejects.toThrow(
    "future",
  );
  expect(s.cache.size).toBe(0);
  updated = "2026-11-09T11:01:10Z";
  await s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000));
  const before = structuredClone([...s.cache]);
  updated = "2026-11-09T11:00:00Z";
  s.advance(60_000);
  await expect(s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000))).rejects.toThrow(
    "backward",
  );
  expect([...s.cache]).toEqual(before);
});

test("stale conditional response cannot advance retained validators or check time", async () => {
  let stale = false;
  const s = setup(() =>
    stale
      ? new Response(null, { status: 304, headers: { age: "601" } })
      : new Response(xml(), { headers: { etag: '"quiet"' } }),
  );
  await s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000));
  const before = structuredClone([...s.cache]);
  stale = true;
  s.advance(60_000);
  await expect(s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000))).rejects.toThrow(
    "transport",
  );
  expect([...s.cache]).toEqual(before);
});

test("a future local validation time cannot bypass transport validation", async () => {
  const s = setup(() => new Response(xml()));
  s.cache.set("https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml", {
    body: Buffer.from(xml()).toString("base64"),
    checkedAt: now + 61_000,
  });
  await expect(s.acquisition.poll("eqvol", [], now, AbortSignal.timeout(1000))).rejects.toThrow(
    "transport check time",
  );
  expect(s.transport).not.toHaveBeenCalled();
});
