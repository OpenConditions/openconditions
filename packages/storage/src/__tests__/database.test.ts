import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callerProfile = process.env["OC_TEST_POSTGIS_PROFILE"];

const state = vi.hoisted(() => {
  const query = vi.fn();
  const end = vi.fn();
  const mocks = {
    query,
    end,
    sql: Object.assign(query, { end }),
    postgres: vi.fn(),
    migrations: vi.fn(),
    construct: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    host: vi.fn(),
    port: vi.fn(),
    runtime: vi.fn(),
    getById: vi.fn(),
    inspect: vi.fn(),
  };
  class GenericContainer {
    readonly image: string;
    constructor(image: string) {
      this.image = image;
      mocks.construct(image);
    }
    withEnvironment() {
      return this;
    }
    withExposedPorts() {
      return this;
    }
    withWaitStrategy() {
      return this;
    }
    start() {
      return mocks.start(this);
    }
  }
  return { ...mocks, GenericContainer };
});

vi.mock("@openconditions/core/server", () => ({ runMigrations: state.migrations }));
vi.mock("postgres", () => ({ default: state.postgres }));
vi.mock("testcontainers", () => ({
  GenericContainer: state.GenericContainer,
  Wait: { forLogMessage: vi.fn() },
  getContainerRuntimeClient: state.runtime,
}));
const GenericContainer = state.GenericContainer;

import { createDedicatedTestDatabase } from "./database.integration.js";
import {
  captureDatabaseStart,
  cleanupProfileDatabase,
  type OwnedDatabase,
} from "./database-profile-audit.integration.js";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("OC_TEST_POSTGIS_PROFILE", undefined);
  vi.resetAllMocks();
  state.query.mockResolvedValue([{ server_version_num: "160004" }]);
  state.end.mockResolvedValue(undefined);
  state.stop.mockResolvedValue(undefined);
  state.host.mockReturnValue("localhost");
  state.port.mockReturnValue(54321);
  state.postgres.mockReturnValue(state.sql);
  state.start.mockResolvedValue({
    getId: () => "unit-test-container",
    getHost: state.host,
    getMappedPort: state.port,
    stop: state.stop,
  });
  state.migrations.mockResolvedValue(undefined);
  state.runtime.mockResolvedValue({
    container: { getById: state.getById, inspect: state.inspect },
  });
  state.getById.mockImplementation((id: string) => ({ id }));
  state.inspect.mockRejectedValue({ statusCode: 404 });
});

describe("disposable storage database profiles and cleanup", () => {
  it.each([undefined, "pg16"])("preserves the PG16 default for %s", async (profile) => {
    if (profile !== undefined) vi.stubEnv("OC_TEST_POSTGIS_PROFILE", profile);
    const db = await createDedicatedTestDatabase();
    expect(state.construct).toHaveBeenCalledWith("postgis/postgis:16-3.4");
    expect(state.postgres).toHaveBeenCalledWith(expect.any(String), {
      max: 4,
      onnotice: expect.any(Function),
    });
    expect(state.query).toHaveBeenCalledOnce();
    expect(state.query.mock.calls[0]?.[0].join("")).toBe("SHOW server_version_num");
    expect(state.migrations).toHaveBeenCalledOnce();
    await db.close();
    expect(state.end).toHaveBeenCalledOnce();
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("selects pinned PG18 and reads the profile on each call", async () => {
    const first = await createDedicatedTestDatabase();
    await first.close();
    vi.stubEnv("OC_TEST_POSTGIS_PROFILE", "pg18");
    state.query.mockResolvedValue([{ server_version_num: "180006" }]);
    const second = await createDedicatedTestDatabase();
    expect(state.construct).toHaveBeenLastCalledWith(
      "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8",
    );
    await second.close();
  });

  it.each(["", "unsupported", "PG18", "pg18 "])(
    "rejects unsupported profile %s before starting any container",
    async (profile) => {
      vi.stubEnv("OC_TEST_POSTGIS_PROFILE", profile);
      await expect(createDedicatedTestDatabase()).rejects.toThrow(
        `Unsupported OC_TEST_POSTGIS_PROFILE: ${profile}`,
      );
      expect(state.construct).not.toHaveBeenCalled();
      expect(state.start).not.toHaveBeenCalled();
      expect(state.postgres).not.toHaveBeenCalled();
    },
  );

  it.each(["180006", undefined, 160004, "NaN", "160004junk", "9007199254740992"])(
    "rejects mismatched or malformed actual server version %s and cleans up",
    async (version) => {
      state.query.mockResolvedValue([{ server_version_num: version }]);
      await expect(createDedicatedTestDatabase()).rejects.toThrow("Unexpected PostgreSQL version");
      expect(state.migrations).not.toHaveBeenCalled();
      expect(state.end).toHaveBeenCalledOnce();
      expect(state.stop).toHaveBeenCalledOnce();
    },
  );

  it("stops after post-start address resolution failure without a pool", async () => {
    const failure = new Error("address unavailable");
    state.host.mockImplementation(() => {
      throw failure;
    });
    await expect(createDedicatedTestDatabase()).rejects.toBe(failure);
    expect(state.end).not.toHaveBeenCalled();
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("stops after pool construction failure", async () => {
    const failure = new Error("pool construction failed");
    state.postgres.mockImplementation(() => {
      throw failure;
    });
    await expect(createDedicatedTestDatabase()).rejects.toBe(failure);
    expect(state.end).not.toHaveBeenCalled();
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it.each(["query", "migrations"] as const)(
    "preserves %s failure while independently attempting both cleanup operations",
    async (stage) => {
      const original = new Error(`${stage} failed`);
      const pool = new Error("pool close failed");
      const stop = new Error("container stop failed");
      state[stage].mockRejectedValue(original);
      state.end.mockRejectedValue(pool);
      state.stop.mockRejectedValue(stop);
      const failure = await createDedicatedTestDatabase().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([original, pool, stop]);
      expect(state.end).toHaveBeenCalledOnce();
      expect(state.stop).toHaveBeenCalledOnce();
    },
  );

  it("returns the original migration error when cleanup succeeds", async () => {
    const failure = new Error("migration failed");
    state.migrations.mockRejectedValue(failure);
    await expect(createDedicatedTestDatabase()).rejects.toBe(failure);
    expect(state.end).toHaveBeenCalledOnce();
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("stops even when a returned fixture's pool close fails", async () => {
    const db = await createDedicatedTestDatabase();
    const failure = new Error("pool close failed");
    state.end.mockRejectedValue(failure);
    await expect(db.close()).rejects.toBe(failure);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("preserves both returned fixture cleanup failures", async () => {
    const db = await createDedicatedTestDatabase();
    const pool = new Error("pool close failed");
    const stop = new Error("container stop failed");
    state.end.mockRejectedValue(pool);
    state.stop.mockRejectedValue(stop);
    const failure = await db.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([pool, stop]);
  });
});

const ownedId = "a".repeat(64);
function startedHandle(id: unknown = ownedId) {
  return { getId: vi.fn(() => id), stop: vi.fn().mockResolvedValue(undefined) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("database ownership audit", () => {
  it("captures only the database, passing nested and later unrelated starts through", async () => {
    const database = new GenericContainer("database");
    const actual = startedHandle();
    const nested = startedHandle("b".repeat(64));
    const unrelated = startedHandle("c".repeat(64));
    state.start.mockImplementation(async (instance: { image: string }) => {
      if (instance === database) {
        await new GenericContainer("nested-reaper").start();
        return actual;
      }
      return instance.image === "nested-reaper" ? nested : unrelated;
    });
    const owned: OwnedDatabase[] = [];
    const restore = captureDatabaseStart(owned);
    try {
      expect(await database.start()).toBe(actual);
      expect(await new GenericContainer("other-database").start()).toBe(unrelated);
      expect(owned).toEqual([{ container: actual, id: ownedId }]);
      await cleanupProfileDatabase(undefined, owned);
      expect(actual.stop).toHaveBeenCalledOnce();
      expect(nested.stop).not.toHaveBeenCalled();
      expect(unrelated.stop).not.toHaveBeenCalled();
      expect(nested.getId).not.toHaveBeenCalled();
      expect(unrelated.getId).not.toHaveBeenCalled();
      expect(state.getById).toHaveBeenCalledExactlyOnceWith(ownedId);
    } finally {
      restore();
    }
  });

  it("retains the exact handle when its ID accessor throws, without an absence claim", async () => {
    const actual = startedHandle();
    const accessor = new Error("ID unavailable");
    actual.getId.mockImplementation(() => {
      throw accessor;
    });
    state.start.mockResolvedValue(actual);
    const owned: OwnedDatabase[] = [];
    const restore = captureDatabaseStart(owned);
    try {
      await expect(new GenericContainer("database").start()).rejects.toBe(accessor);
      expect(owned).toEqual([{ container: actual }]);
      await expect(cleanupProfileDatabase(undefined, owned)).rejects.toThrow(
        "Disposable profile cleanup failed",
      );
      expect(actual.stop).toHaveBeenCalledOnce();
      expect(actual.getId).toHaveBeenCalledOnce();
      expect(state.runtime).not.toHaveBeenCalled();
      expect(state.inspect).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it.each(["", "invalid", undefined, 160004])(
    "retains the exact handle for invalid ID %s without inspection",
    async (id) => {
      const actual = startedHandle();
      actual.getId.mockReturnValue(id);
      state.start.mockResolvedValue(actual);
      const owned: OwnedDatabase[] = [];
      const restore = captureDatabaseStart(owned);
      try {
        await expect(new GenericContainer("database").start()).rejects.toThrow();
        expect(owned).toEqual([{ container: actual }]);
        await expect(cleanupProfileDatabase(undefined, owned)).rejects.toThrow(
          "Disposable profile cleanup failed",
        );
        expect(actual.stop).toHaveBeenCalledOnce();
        expect(actual.getId).toHaveBeenCalledOnce();
        expect(state.runtime).not.toHaveBeenCalled();
        expect(state.inspect).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    },
  );

  it("captures the ID once and keeps inspection independent from pool-close failure", async () => {
    const actual = startedHandle();
    state.start.mockResolvedValue(actual);
    const owned: OwnedDatabase[] = [];
    const restore = captureDatabaseStart(owned);
    try {
      await new GenericContainer("database").start();
      const failure = new Error("pool close failed");
      const close = vi.fn().mockRejectedValue(failure);
      const result = await cleanupProfileDatabase({ close }, owned).catch(
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([failure]);
      expect(actual.getId).toHaveBeenCalledOnce();
      expect(state.getById).toHaveBeenCalledExactlyOnceWith(ownedId);
    } finally {
      restore();
    }
  });
});

afterAll(() => {
  expect(process.env["OC_TEST_POSTGIS_PROFILE"]).toBe(callerProfile);
});

it("leaves nested infrastructure unowned when the database start rejects", async () => {
  const database = new GenericContainer("database");
  const nested = startedHandle("b".repeat(64));
  const failure = new Error("database start failed");
  state.start.mockImplementation(async (instance: { image: string }) => {
    if (instance === database) {
      await new GenericContainer("nested-reaper").start();
      throw failure;
    }
    return nested;
  });
  const owned: OwnedDatabase[] = [];
  const restore = captureDatabaseStart(owned);
  try {
    await expect(database.start()).rejects.toBe(failure);
    expect(owned).toEqual([]);
    await cleanupProfileDatabase(undefined, owned);
    expect(nested.stop).not.toHaveBeenCalled();
    expect(nested.getId).not.toHaveBeenCalled();
    expect(state.runtime).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});

it("restores the interception if profile rejection occurs before any start", async () => {
  const start = GenericContainer.prototype.start;
  const owned: OwnedDatabase[] = [];
  const restore = captureDatabaseStart(owned);
  vi.stubEnv("OC_TEST_POSTGIS_PROFILE", "unsupported");
  try {
    await expect(createDedicatedTestDatabase()).rejects.toThrow(
      "Unsupported OC_TEST_POSTGIS_PROFILE",
    );
  } finally {
    restore();
  }
  expect(GenericContainer.prototype.start).toBe(start);
  expect(owned).toEqual([]);
  expect(state.start).not.toHaveBeenCalled();
});
