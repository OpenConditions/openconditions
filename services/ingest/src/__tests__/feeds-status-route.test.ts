import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import type { BindingMetricsReader } from "../pipeline/binding-metrics.js";
import type { SourceStatusReader } from "../pipeline/source-status.js";
import { registerFeedStatusRoute } from "../publish-routes.js";
import { REPO_CATALOG } from "./helpers/catalog.js";

const app = Fastify();
const store = new FeedStatusStore();
store.recordSuccess("nl-ndw-events", "2026-07-01T00:00:00.000Z", 5, 100);

// Binding metrics are covered against a real database in binding-metrics.test.ts;
// stubbing them keeps this suite a pure registry/credentials test.
let readBindingMetrics: BindingMetricsReader = async () => new Map();
const readSourceStatus: SourceStatusReader = async () =>
  new Map([
    [
      "nl-ndw-events",
      {
        source: "nl-ndw-events",
        lastAttemptAt: "2026-09-11T10:00:00.000Z",
        lastNetworkSuccessAt: "2026-09-11T09:59:00.000Z",
        freshnessDeadline: "2026-09-11T10:14:00.000Z",
        lastPublicationAt: "2026-09-11T09:59:00.000Z",
        publicationRevision: 7,
        lastOutcome: "changed",
        activeEvents: 3,
        lastInserted: 1,
        lastUpdated: 2,
        lastDeleted: 4,
        lastRejected: 0,
        lastDurationMs: 90,
        consecutiveFailures: 0,
      },
    ],
  ]);

beforeAll(async () => {
  registerFeedStatusRoute(
    app,
    store,
    REPO_CATALOG,
    () => readBindingMetrics(),
    readSourceStatus,
    async () => ({ generation: "graph-7", status: "ready", regions: ["DE"] }),
  );
  await app.ready();
});

afterAll(() => app.close());

describe("GET /feeds/status", () => {
  it("lists registered feeds with credential flags and run status", async () => {
    const res = await app.inject({ method: "GET", url: "/feeds/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      schemaVersion: string;
      collectedAt: string;
      graph: { generation: string; status: string; regions: string[] };
      feeds: {
        id: string;
        hasCredentials: boolean;
        missingEnv: string[];
        lastRowCount?: number;
      }[];
    };
    expect(body.schemaVersion).toBe("2.0");
    expect(Date.parse(body.collectedAt)).not.toBeNaN();
    expect(body.graph).toEqual({ generation: "graph-7", status: "ready", regions: ["DE"] });
    const ndw = body.feeds.find((f) => f.id === "nl-ndw-events");
    expect(ndw).toBeTruthy();
    expect(ndw?.hasCredentials).toBe(true);
    expect(ndw?.lastRowCount).toBe(3);
    expect(ndw).toMatchObject({
      lastOutcome: "changed",
      activeEvents: 3,
      publicationRevision: 7,
      lastSuccessAt: "2026-09-11T09:59:00.000Z",
    });
    // a keyed feed with no creds set is listed but flagged, naming the env var
    const prev = process.env["US_OH_OHGO_API_KEY"];
    delete process.env["US_OH_OHGO_API_KEY"];
    try {
      const again = (await app.inject({ method: "GET", url: "/feeds/status" })).json() as {
        feeds: { id: string; hasCredentials: boolean; missingEnv: string[] }[];
      };
      expect(again.feeds.find((f) => f.id === "us-oh-ohgo-flow")).toMatchObject({
        hasCredentials: false,
        missingEnv: ["US_OH_OHGO_API_KEY"],
      });
    } finally {
      if (prev !== undefined) process.env["US_OH_OHGO_API_KEY"] = prev;
    }
  });

  it("reports missingEnv per-key for a multi-var auth feed with only one var set", async () => {
    // hr-hc-events uses basic auth (HR_HC_USER + HR_HC_PASSWORD, a shared
    // group). With only the user set, missingEnv must list only the password.
    const prevUser = process.env["HR_HC_USER"];
    const prevPass = process.env["HR_HC_PASSWORD"];
    delete process.env["HR_HC_PASSWORD"];
    process.env["HR_HC_USER"] = "some-user";
    try {
      const res = await app.inject({ method: "GET", url: "/feeds/status" });
      const body = res.json() as { feeds: { id: string; missingEnv: string[] }[] };
      const hcHr = body.feeds.find((f) => f.id === "hr-hc-events");
      expect(hcHr).toBeTruthy();
      expect(hcHr?.missingEnv).toEqual(["HR_HC_PASSWORD"]);
    } finally {
      if (prevUser === undefined) delete process.env["HR_HC_USER"];
      else process.env["HR_HC_USER"] = prevUser;
      if (prevPass === undefined) delete process.env["HR_HC_PASSWORD"];
      else process.env["HR_HC_PASSWORD"] = prevPass;
    }
  });

  it("still lists feeds when the binding metrics query fails", async () => {
    const previous = readBindingMetrics;
    readBindingMetrics = async () => {
      throw new Error("relation does not exist");
    };
    try {
      const res = await app.inject({ method: "GET", url: "/feeds/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { feeds: Record<string, unknown>[] };
      expect(body.feeds.length).toBeGreaterThan(0);
      expect(body.feeds.some((f) => "binding" in f)).toBe(false);
    } finally {
      readBindingMetrics = previous;
    }
  });
});
