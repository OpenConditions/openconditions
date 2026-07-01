import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { FeedStatusStore } from "../feed-status.js";
import { registerFeedStatusRoute } from "../publish-routes.js";

const app = Fastify();
const store = new FeedStatusStore();
store.recordSuccess("ndw", "2026-07-01T00:00:00.000Z", 5, 100);
registerFeedStatusRoute(app, store);

afterAll(() => app.close());

describe("GET /feeds/status", () => {
  it("lists registered feeds with enabled/credential flags and run status", async () => {
    const res = await app.inject({ method: "GET", url: "/feeds/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      feeds: {
        id: string;
        enabled: boolean;
        hasCredentials: boolean;
        missingEnv: string[];
        lastRowCount?: number;
      }[];
    };
    const ndw = body.feeds.find((f) => f.id === "ndw");
    expect(ndw).toBeTruthy();
    expect(ndw?.enabled).toBe(true);
    expect(ndw?.hasCredentials).toBe(true);
    expect(ndw?.lastRowCount).toBe(5);
    // a keyed feed with no creds set is listed but flagged
    const keyed = body.feeds.find((f) => f.hasCredentials === false);
    expect(keyed && keyed.missingEnv.length > 0).toBe(true);
  });
});
