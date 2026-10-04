import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCatalog = vi.fn();

vi.mock("@openconditions/ingest-framework", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openconditions/ingest-framework")>();
  return { ...actual, loadCatalog };
});

const { INGEST_DOMAINS, loadIngestCatalog } = await import("../domains.js");

describe("loadIngestCatalog layers", () => {
  beforeEach(() => {
    loadCatalog.mockReset();
    loadCatalog.mockResolvedValue({
      feeds: [],
      sources: [],
      discovered: [],
      disabled: [],
      credentials: {},
    });
  });

  it("takes the mount, the remote and its snapshot from the env", async () => {
    await loadIngestCatalog({
      OPENCONDITIONS_FEEDS_DIR: "/mnt/feeds",
      OPENCONDITIONS_FEEDS_REMOTE_URL: "https://atlas.example.org/feeds.json",
      OPENCONDITIONS_FEEDS_REMOTE_ENABLED: "true",
      OPENCONDITIONS_STATE_DIR: "/state",
    });
    const [domains, layers] = loadCatalog.mock.calls[0]!;
    expect(domains).toBe(INGEST_DOMAINS);
    expect(layers).toMatchObject({
      mount: "/mnt/feeds",
      remote: {
        url: "https://atlas.example.org/feeds.json",
        snapshotPath: "/state/feeds/remote-snapshot.json",
      },
    });
    expect(layers.baked).toMatch(/feeds$/);
  });

  it("leaves the remote off unless enabled, and the snapshot under /data by default", async () => {
    await loadIngestCatalog({
      OPENCONDITIONS_FEEDS_REMOTE_URL: "https://atlas.example.org/f.json",
    });
    expect(loadCatalog.mock.calls[0]![1]).not.toHaveProperty("remote");
    expect(loadCatalog.mock.calls[0]![1]).not.toHaveProperty("mount");

    await loadIngestCatalog({
      OPENCONDITIONS_FEEDS_REMOTE_URL: "https://atlas.example.org/f.json",
      OPENCONDITIONS_FEEDS_REMOTE_ENABLED: "true",
    });
    expect(loadCatalog.mock.calls[1]![1].remote.snapshotPath).toBe(
      "/data/feeds/remote-snapshot.json",
    );
  });

  it("warns when the remote is enabled without a URL, and loads without it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadIngestCatalog({ OPENCONDITIONS_FEEDS_REMOTE_ENABLED: "true" });
      expect(loadCatalog.mock.calls[0]![1]).not.toHaveProperty("remote");
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /OPENCONDITIONS_FEEDS_REMOTE_ENABLED.*OPENCONDITIONS_FEEDS_REMOTE_URL/,
        ),
      );
      warn.mockClear();
      await loadIngestCatalog({});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
