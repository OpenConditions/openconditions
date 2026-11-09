import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { punCoordinationDirectory, withPunCoordination } from "../pun-coordination.js";

it("retains cooldown after a failed client and rejects a second client until it expires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pun-budget-"));
  try {
    await expect(
      withPunCoordination(dir, async (budget) => {
        await budget.reserveUntil(Date.now() + 90000000);
        throw Error("failed acquisition");
      }),
    ).rejects.toThrow("failed acquisition");
    let called = false;
    await expect(
      withPunCoordination(
        dir,
        async () => {
          called = true;
        },
        { deadline: Date.now() + 1000 },
      ),
    ).rejects.toThrow(/cooldown/);
    expect(called).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "budget.json"), "utf8")).next).toBeGreaterThan(
      Date.now(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("holds one lease across clients and releases it after failure without losing the budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pun-budget-"));
  try {
    await withPunCoordination(dir, async () => {
      await expect(
        withPunCoordination(dir, async () => {}, { deadline: Date.now() + 50 }),
      ).rejects.toThrow(/lease/);
    });
    await withPunCoordination(dir, async () => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("fails closed on corrupt state and never removes another client's lease on abort", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "pun-budget-"));
  try {
    await writeFile(join(dir, "budget.json"), "broken");
    await expect(withPunCoordination(dir, async () => {})).rejects.toThrow();
    await mkdir(join(dir, "lease"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      withPunCoordination(dir, async () => {}, { signal: controller.signal }),
    ).rejects.toThrow();
    await expect(mkdir(join(dir, "lease"))).rejects.toMatchObject({ code: "EEXIST" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("defaults container coordination to its existing persistent state directory", () => {
  vi.stubEnv("OPENCONDITIONS_STATE_DIR", "/data");
  vi.stubEnv("PUN_COORDINATION_DIR", "");
  try {
    expect(punCoordinationDirectory()).toBe("/data/cruscotto-italia-client");
  } finally {
    vi.unstubAllEnvs();
  }
});
it("paces a cold client from the persisted previous request rather than process memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pun-cold-client-"));
  vi.stubEnv("PUN_COORDINATION_DIR", dir);
  try {
    vi.resetModules();
    const first = await import("../pun.js");
    const starts: number[] = [];
    const provider = async () => {
      starts.push(Date.now());
      return new Response("ok");
    };
    await first.punHostFetch(provider)("https://cruscotto-italia.dati.gov.it/data/pun/092090.json");
    vi.resetModules();
    const cold = await import("../pun.js");
    await cold.punHostFetch(provider)("https://cruscotto-italia.dati.gov.it/data/pun/092090.json");
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
it("retains the lease if cooldown persistence fails, so another process cannot evade it", async () => {
  const { mkdir } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "pun-write-failure-"));
  try {
    await expect(
      withPunCoordination(dir, async (budget) => {
        await mkdir(join(dir, "budget.json.tmp"));
        await budget.reserveUntil(Date.now() + 90000000);
      }),
    ).rejects.toThrow();
    let called = false;
    await expect(
      withPunCoordination(
        dir,
        async () => {
          called = true;
        },
        { deadline: Date.now() + 50 },
      ),
    ).rejects.toThrow(/lease/);
    expect(called).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
