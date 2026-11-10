import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createFetchState } from "../fetch.js";
import { acquirePun, PUN_BUDGET, punManifest } from "../pun.js";

// Local-byte replay only. Persistent coordination is separately tested with real filesystem clients.
vi.mock("../pun-coordination.js", () => ({
  punCoordinationDirectory: () => "offline-replay",
  withPunCoordination: async (
    _dir: string,
    work: (b: { next: number; reserveUntil: () => Promise<void> }) => Promise<unknown>,
  ) => work({ next: 0, reserveUntil: async () => {} }),
}));
const directory = process.env["PUN_CAPTURE_DIR"];
it.skipIf(!directory)(
  "replays the complete captured generation through the actual acquisition integrity and cache logic",
  async () => {
    const root = directory!;
    expect(JSON.parse(readFileSync(join(root, "capture-result.json"), "utf8")).status).toBe(
      "sealed",
    );
    const cache = join(root, "capture");
    const first = readFileSync(join(cache, "manifest-before.json"));
    const manifest = punManifest(first);
    const state = createFetchState();
    let calls = 0;
    let manifests = 0;
    vi.useFakeTimers();
    try {
      const pending = acquirePun(async (input) => {
        calls++;
        const path = new URL(String(input)).pathname.replace("/data/", "");
        return new Response(
          path === "manifest.json"
            ? readFileSync(
                join(cache, manifests++ === 0 ? "manifest-before.json" : "manifest-after.json"),
              )
            : readFileSync(join(cache, path.replace("/", "_"))),
        );
      }, state);
      let settled = false;
      const observed = pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Give native gzip real event-loop turns while only pacing is accelerated.
      for (let tick = 0; !settled && tick <= PUN_BUDGET.elapsedMs / 1000; tick++) {
        await vi.advanceTimersByTimeAsync(1000);
        await realDelay(1);
      }
      await observed;
      const result = await pending;
      expect(result.status).toBe("fetched");
      expect(calls).toBe(manifest.files.length + 2);
      expect(state.conditional.size).toBe(0);
      if (result.status === "fetched") {
        expect(result.buffers).toHaveLength(manifest.files.length + 2);
        writeFileSync(
          join(root, "acquisition-replay.json"),
          JSON.stringify(
            {
              status: "validated",
              shards: manifest.files.length,
              calls,
              providerCalls: 0,
              bodyBytes: result.buffers.reduce((n, b) => n + b.length, 0),
              cacheBeforeAccept: state.conditional.size,
              resourceUsage: process.resourceUsage(),
              memory: process.memoryUsage(),
              clock: "accelerated offline request spacing",
            },
            null,
            2,
          ),
        );
        result.accept();
        expect(state.conditional.size).toBe(manifest.files.length);
        let cachedCalls = 0;
        const cached = acquirePun(async (input) => {
          expect(String(input)).toContain("manifest.json");
          cachedCalls++;
          return new Response(first);
        }, state);
        let cachedDone = false;
        const cachedObserved = cached.then(
          () => {
            cachedDone = true;
          },
          () => {
            cachedDone = true;
          },
        );
        for (let tick = 0; !cachedDone && tick <= PUN_BUDGET.elapsedMs / 1000; tick++) {
          await vi.advanceTimersByTimeAsync(1000);
          await realDelay(1);
        }
        await cachedObserved;
        expect((await cached).status).toBe("fetched");
        expect(cachedCalls).toBe(2);
        writeFileSync(
          join(root, "cache-replay.json"),
          JSON.stringify(
            {
              municipalRequests: 0,
              manifestRequests: cachedCalls,
              cacheEntries: state.conditional.size,
              resourceUsage: process.resourceUsage(),
              memory: process.memoryUsage(),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      vi.useRealTimers();
    }
  },
);
