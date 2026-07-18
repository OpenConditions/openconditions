import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { FeedStatusStore } from "../feed-status.js";
import { buildDomainRegistry } from "../domains.js";
import { registerFeedStatusRoute } from "../publish-routes.js";

const app = Fastify();
const store = new FeedStatusStore();
store.recordSuccess("nl-ndw", "2026-07-01T00:00:00.000Z", 5, 100);

beforeAll(async () => {
  const registry = await buildDomainRegistry();
  registerFeedStatusRoute(app, store, registry);
  await app.ready();
});

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
    const ndw = body.feeds.find((f) => f.id === "nl-ndw");
    expect(ndw).toBeTruthy();
    expect(ndw?.enabled).toBe(true);
    expect(ndw?.hasCredentials).toBe(true);
    expect(ndw?.lastRowCount).toBe(5);
    // a keyed feed with no creds set is listed but flagged
    const keyed = body.feeds.find((f) => f.hasCredentials === false);
    expect(keyed && keyed.missingEnv.length > 0).toBe(true);
  });

  it("reports missingEnv per-key for a multi-var auth feed with only one var set", async () => {
    // hc-hr uses basic auth (HR_HC_USERNAME + HR_HC_PASSWORD). With only the
    // username set, missingEnv must list only the password — hasCredentials
    // re-deriving the whole auth block for each candidate key would flag both.
    const prevUser = process.env["HR_HC_USERNAME"];
    const prevPass = process.env["HR_HC_PASSWORD"];
    delete process.env["HR_HC_PASSWORD"];
    process.env["HR_HC_USERNAME"] = "some-user";
    try {
      const res = await app.inject({ method: "GET", url: "/feeds/status" });
      const body = res.json() as { feeds: { id: string; missingEnv: string[] }[] };
      const hcHr = body.feeds.find((f) => f.id === "hr-hc");
      expect(hcHr).toBeTruthy();
      expect(hcHr?.missingEnv).toEqual(["HR_HC_PASSWORD"]);
    } finally {
      if (prevUser === undefined) delete process.env["HR_HC_USERNAME"];
      else process.env["HR_HC_USERNAME"] = prevUser;
      if (prevPass === undefined) delete process.env["HR_HC_PASSWORD"];
      else process.env["HR_HC_PASSWORD"] = prevPass;
    }
  });
});
