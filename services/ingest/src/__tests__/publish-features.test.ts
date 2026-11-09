import type { CatalogFeed } from "@openconditions/ingest-framework";
import { beforeEach, expect, it, vi } from "vitest";

const { writeSnapshotIn, upsertSourceStatus } = vi.hoisted(() => ({
  writeSnapshotIn: vi.fn(),
  upsertSourceStatus: vi.fn(),
}));
vi.mock("@openconditions/storage", () => ({
  writeSnapshotIn,
  LatestCache: class {
    begin() {
      return { commit() {}, discard() {} };
    }
  },
}));
vi.mock("../pipeline/source-status.js", () => ({ upsertSourceStatus }));

import { publishFeatures, writeModel } from "../pipeline/publish.js";

beforeEach(() => {
  vi.clearAllMocks();
  const count = { created: 0, restored: 0, updated: 0, withdrawn: 0 };
  writeSnapshotIn.mockResolvedValue({
    counts: { feature: count, offer: count },
    rejected: [],
    observations: { unchanged: 0 },
  });
});

it.each([
  { partial: false, input: undefined, publication: undefined, expected: [true, true, true] },
  { partial: true, input: true, publication: undefined, expected: [false, false, false] },
  {
    partial: true,
    input: true,
    publication: { featuresComplete: true, offersComplete: true, statesComplete: true },
    expected: [false, false, false],
  },
  { partial: false, input: false, publication: undefined, expected: [false, true, true] },
  {
    partial: false,
    input: true,
    publication: { featuresComplete: false, offersComplete: false, statesComplete: false },
    expected: [false, false, false],
  },
  {
    partial: false,
    input: true,
    publication: { featuresComplete: true, offersComplete: false, statesComplete: true },
    expected: [true, false, true],
  },
])(
  "composes catalogue and publication authority: %j",
  async ({ partial, input, publication, expected }) => {
    const tx = vi.fn().mockResolvedValue([{ live: 0 }]);
    const sql = { begin: (run: (tx: unknown) => unknown) => run(tx) };
    await publishFeatures(
      sql as never,
      {
        id: "authority-test",
        freshnessWindowSec: 300,
        ...(partial ? { snapshot: { completeness: "partial" } as CatalogFeed["snapshot"] } : {}),
      },
      {
        output: { features: [], observations: [], offers: [], publication },
        featuresComplete: input,
        statesComplete: true,
        poll: { id: 1, at: "2026-11-10T00:00:00Z" },
        now: "2026-11-10T00:00:00Z",
        model: writeModel({ instanceId: "test.local" }),
        rejected: 0,
        durationMs: 1,
      },
    );
    const context = writeSnapshotIn.mock.calls[0]![3];
    expect(context.complete).toEqual({ feature: expected[0], offer: expected[1] });
    expect(context.statesComplete).toBe(expected[2]);
    expect(upsertSourceStatus).toHaveBeenCalledOnce();
  },
);
