import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { JmaAcquisition, type JmaDownloadStore } from "../jma-acquisition.js";

const now = Date.parse("2026-11-09T11:17:00Z");
const fixture = readFileSync(
  new URL(
    "../../../../../packages/hazards/src/__tests__/fixtures/jma/33_12_01_240613_VXSE52.xml",
    import.meta.url,
  ),
  "utf8",
);
const report = fixture.replace("</Body>", `<Text>${"x".repeat(240_000)}</Text></Body>`);
const urls = Array.from(
  { length: 40 },
  (_, i) => `https://www.data.jma.go.jp/developer/xml/data/20261109010000_${i}_VXSE52_010000.xml`,
);
const index = `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-09T11:00:00Z</updated>${urls.map((url) => `<entry><id>${url}</id><link href="${url}"/></entry>`).join("")}</feed>`;
test("cached native aggregate refuses before collecting the next body", async () => {
  let reads = 0;
  const store: JmaDownloadStore = {
    withUrl: async (url, action) => {
      if (urls.includes(url)) reads++;
      return action(
        {
          body: Buffer.from(urls.includes(url) ? report : index).toString("base64"),
          checkedAt: now,
        },
        async () => {},
      );
    },
    reserve: async () => {},
    settle: async () => {},
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const acquisition = new JmaAcquisition(store, "test", () => now, fetch);
  await expect(
    acquisition.poll("eqvol", ["VXSE52"], now, AbortSignal.timeout(30_000)),
  ).rejects.toThrow(/aggregate/);
  expect(reads).toBeLessThan(40);
  expect(fetch).not.toHaveBeenCalled();
});

test("network aggregate stops before the next reservation and transport allocation", async () => {
  let reservations = 0;
  const cache = new Map();
  const store: JmaDownloadStore = {
    withUrl: async (url, action) =>
      action(cache.get(url), async (value) => {
        cache.set(url, value);
      }),
    reserve: async () => {
      reservations++;
    },
    settle: async () => {},
  };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (input) => new Response(urls.includes(String(input)) ? report : index),
  );
  const acquisition = new JmaAcquisition(
    store,
    "test",
    () => now,
    fetch,
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  await expect(
    acquisition.poll("eqvol", ["VXSE52"], now, AbortSignal.timeout(30_000)),
  ).rejects.toThrow(/aggregate/);
  expect(fetch.mock.calls.length).toBeLessThan(41);
  expect(reservations).toBe(fetch.mock.calls.length);
  expect(cache.size).toBe(reservations);
});

test("shared warning-channel budget refuses before even opening the second index cache", async () => {
  let opened = 0;
  const store: JmaDownloadStore = {
    withUrl: async (_url, action) => {
      opened++;
      return action(
        { body: Buffer.from(index).toString("base64"), checkedAt: now },
        async () => {},
      );
    },
    reserve: async () => {},
    settle: async () => {},
  };
  const acquisition = new JmaAcquisition(store, "test", () => now);
  const budget = { used: 8_000_000 };
  await acquisition.poll("extra", [], now, AbortSignal.timeout(10_000), budget);
  await expect(
    acquisition.poll("eqvol", [], now, AbortSignal.timeout(10_000), budget),
  ).rejects.toThrow(/aggregate/);
  expect(opened).toBe(1);
});

test("cached abort discards the batch, releases native child and permits a fresh poll", async () => {
  const controller = new AbortController();
  let messages = 0;
  let stop = true;
  const store: JmaDownloadStore = {
    withUrl: async (url, action) => {
      if (urls.includes(url) && ++messages === 2 && stop)
        controller.abort(new Error("controlled cached cancellation"));
      return action(
        {
          body: Buffer.from(urls.includes(url) ? report : index).toString("base64"),
          checkedAt: now,
        },
        async () => {},
      );
    },
    reserve: async () => {},
    settle: async () => {},
  };
  const acquisition = new JmaAcquisition(store, "test", () => now);
  await expect(acquisition.poll("eqvol", ["VXSE52"], now, controller.signal)).rejects.toThrow(
    "controlled cached cancellation",
  );
  stop = false;
  expect(await acquisition.poll("eqvol", [], now, AbortSignal.timeout(10_000))).toHaveProperty(
    "reports",
    [],
  );
  await acquisition.close();
});
