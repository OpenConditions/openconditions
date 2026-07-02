import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadFeeds = vi.fn();

vi.mock("@openconditions/ingest-framework", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openconditions/ingest-framework")>();
  return { ...actual, loadFeeds };
});

describe("buildDomainRegistry", () => {
  const ENV = process.env;
  beforeEach(() => {
    loadFeeds.mockReset();
    process.env = { ...ENV };
  });
  afterEach(() => {
    process.env = ENV;
  });

  it("passes the mount dir + remote toggle from env, and returns the loaded feeds on roads", async () => {
    process.env["OPENCONDITIONS_FEEDS_DIR"] = "/mnt/feeds";
    process.env["OPENCONDITIONS_FEEDS_REMOTE_URL"] = "https://atlas.example.org/roads.json5";
    process.env["OPENCONDITIONS_FEEDS_REMOTE_ENABLED"] = "true";
    const loaded = [{ id: "override", name: "Override" }];
    loadFeeds.mockResolvedValue(loaded);

    const { buildDomainRegistry } = await import("../domains.js");
    const registry = await buildDomainRegistry({ bakedInDir: "/baked" });

    expect(registry["roads"]?.feeds).toBe(loaded);
    const opts = loadFeeds.mock.calls[0]?.[0];
    expect(opts).toMatchObject({
      domain: "roads",
      bakedInDir: "/baked",
      mountDir: "/mnt/feeds",
      remote: {
        url: "https://atlas.example.org/roads.json5",
        enabled: true,
      },
    });
    expect(typeof opts.remote.snapshotPath).toBe("string");
  });

  it("defaults remote-pull OFF when the enable flag is unset", async () => {
    delete process.env["OPENCONDITIONS_FEEDS_REMOTE_ENABLED"];
    loadFeeds.mockResolvedValue([]);
    const { buildDomainRegistry } = await import("../domains.js");
    await buildDomainRegistry({ bakedInDir: "/baked" });
    expect(loadFeeds.mock.calls[0]?.[0].remote.enabled).toBe(false);
  });
});
