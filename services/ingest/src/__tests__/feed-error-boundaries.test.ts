import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import type { RunDeps } from "../pipeline/run.js";
import { runSource } from "../pipeline/run.js";
import { upsertSourceStatus } from "../pipeline/source-status.js";
import { runFeedOnce } from "../scheduler.js";
import { repoFeed, testFeed } from "./helpers/catalog.js";

vi.mock("../pipeline/source-status.js", async (original) => ({
  ...(await original<typeof import("../pipeline/source-status.js")>()),
  openPollAttempt: vi.fn(async () => 1),
  upsertSourceStatus: vi.fn(async () => {}),
}));

const secret = "fixture-subscription-7f02";
const otherQueryValue = "fixture-unlisted-query-value";
const feed = testFeed({
  id: "credential-boundary",
  credentials: { subscription: { title: "Subscription" } },
  endpoints: {
    main: {
      url: "https://example.test/${subscription}/feed?subscription=${subscription}",
      cadenceSec: 300,
    },
  },
});
const env = { CREDENTIAL_BOUNDARY_SUBSCRIPTION: secret };
const message = `upstream failed https://example.test/${secret}/feed?token=${otherQueryValue}; credential ${secret}`;
const failure = () => {
  const error = new Error(message, { cause: new Error(`cause ${secret}`) });
  error.stack = `private stack ${secret}`;
  return error;
};
const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
  sql: {} as never,
  now: () => "2026-10-28T00:00:00.000Z",
  env,
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  fetch: async () => {
    throw failure();
  },
  ...over,
});

afterEach(() => vi.restoreAllMocks());

function expectSafe(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).toContain("upstream failed");
  expect(text).toContain("example.test/");
  expect(text).not.toContain(secret);
  expect(text).not.toContain(otherQueryValue);
  expect(text).not.toContain("private stack");
}

describe("feed error disclosure boundaries", () => {
  it.each(["buffered", "streamed", "parse"])(
    "scrubs %s poll failures before logs, results and durable status",
    async (kind) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(upsertSourceStatus).mockClear();
      const selected =
        kind === "streamed" ? { ...feed, format: repoFeed("nl-ndw-flow").format } : feed;
      const options = deps(
        kind === "parse"
          ? {
              fetch: async () => new Response("<payload/>"),
              parseProcess: {
                minBytes: 0,
                running: false,
                parse: async () => {
                  throw failure();
                },
                close: async () => {},
              },
            }
          : {},
      );
      const result = await runSource(selected, options);
      expect(result.count).toBe(0);
      expectSafe(result.error);
      expectSafe(log.mock.calls);
      expectSafe(vi.mocked(upsertSourceStatus).mock.calls.at(-1)?.[2].error);
      expect(log.mock.calls.flat().every((arg) => typeof arg === "string")).toBe(true);
    },
  );

  it("scrubs an escaped poll failure before closing its attempt and scheduler reporting", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(upsertSourceStatus).mockClear();
    const store = new FeedStatusStore();
    await runFeedOnce(
      feed,
      deps({
        fetch: async () => new Response("<payload/>"),
        parseGate: {
          run: async () => {
            throw failure();
          },
        },
      }),
      store,
    );
    expectSafe(vi.mocked(upsertSourceStatus).mock.calls.at(-1)?.[2].error);
    expectSafe(log.mock.calls);
    expectSafe(store.get(feed.id)?.lastError);
  });

  it("scrubs a failed attempt-close diagnostic without replacing the original failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(upsertSourceStatus).mockRejectedValueOnce(failure());
    const store = new FeedStatusStore();
    await runFeedOnce(
      feed,
      deps({
        fetch: async () => new Response("<payload/>"),
        parseGate: {
          run: async () => {
            throw failure();
          },
        },
      }),
      store,
    );
    expect(
      log.mock.calls.some((call) => String(call[0]).includes("could not close poll attempt")),
    ).toBe(true);
    expectSafe(log.mock.calls);
    expectSafe(store.get(feed.id)?.lastError);
  });

  it("retains query-token scrubbing when a transport repeats an undeclared token", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(upsertSourceStatus).mockClear();
    const result = await runSource(
      feed,
      deps({
        fetch: async () => {
          throw new Error(
            `upstream failed https://example.test/feed?token=${otherQueryValue} response token ${otherQueryValue}`,
          );
        },
      }),
    );
    expectSafe(result.error);
    expectSafe(log.mock.calls);
    expectSafe(vi.mocked(upsertSourceStatus).mock.calls.at(-1)?.[2].error);
  });

  it.each(["returned", "thrown", "non-error"])(
    "scrubs %s failures before scheduler logs and public status",
    async (kind) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const store = new FeedStatusStore();
      await runFeedOnce(feed, deps(), store, {
        runSource: async () => {
          if (kind === "thrown") throw failure();
          if (kind === "non-error") throw message;
          return { count: 0, durationMs: 1, error: message };
        },
      });
      expectSafe(log.mock.calls);
      expectSafe(store.get(feed.id)?.lastError);
      expect(store.get(feed.id)?.lastSuccessAt).toBeUndefined();
    },
  );
});
