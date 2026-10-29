import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchState, fetchEndpoint } from "../fetch.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const secret = "fixture-declared-token-51d2";
const query = "fixture-query-98c1";
const message = `transport refused credential ${secret}`;

afterEach(() => vi.restoreAllMocks());

describe.each(["urls", "items"] as const)("%s fan-out error logging", (mode) => {
  it.each(["Error", "string", "object", "null prototype", "throwing conversion"])(
    "scrubs a thrown %s while preserving successful neighbours and partial coverage",
    async (kind) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const feed = catalogFeed({
        id: "fanout-redaction",
        credentials: { token: { title: "Token" } },
        auth: { kind: "header-key", header: "X-Api-Key", credential: "token" },
        endpoints: {
          main: {
            cadenceSec: 300,
            fanout: "tolerant",
            ...(mode === "urls"
              ? { urls: ["https://api.test/${token}/bad?trace=" + query, "https://api.test/ok"] }
              : {
                  url: "https://api.test/${token}/{item}?trace=" + query,
                  each: { role: "ids", records: "items", field: "id" },
                }),
          },
        },
      });
      const headers: (string | null)[] = [];
      const result = await fetchEndpoint(
        feed,
        "main",
        async (input, init) => {
          headers.push(new Headers(init?.headers).get("X-Api-Key"));
          if (new URL(String(input)).pathname.endsWith("/bad")) {
            if (kind === "string") throw message;
            if (kind === "object") throw { privateDetail: secret, toString: () => message };
            if (kind === "null prototype")
              throw Object.assign(Object.create(null), { privateDetail: secret });
            if (kind === "throwing conversion")
              throw {
                [Symbol.toPrimitive]() {
                  throw new Error(secret);
                },
              };
            const error = new Error(message, { cause: new Error(`private cause ${secret}`) });
            error.stack = `private stack ${secret}`;
            throw error;
          }
          return new Response("healthy neighbour");
        },
        {
          state: createFetchState(),
          env: { FANOUT_REDACTION_TOKEN: secret },
          ...(mode === "items"
            ? { eachSource: [Buffer.from('{"items":[{"id":"bad"},{"id":"ok"}]}')] }
            : {}),
        },
      );
      expect(result.status).toBe("partial");
      if (result.status !== "partial") throw new Error("expected partial acquisition");
      expect(result.partitions).toEqual({ succeeded: 1, failed: 1, total: 2 });
      expect(result.buffers.map((buffer) => buffer.toString())).toEqual(["healthy neighbour"]);
      expect(headers).toEqual([secret, secret]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls.flat().every((value) => typeof value === "string")).toBe(true);
      const diagnostic = warn.mock.calls.flat().join(" ");
      expect(diagnostic).toContain("api.test/");
      expect(diagnostic).toContain(
        kind === "null prototype" || kind === "throwing conversion"
          ? "fetch failed"
          : "transport refused credential",
      );
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain(query);
      expect(diagnostic).not.toContain("private stack");
      expect(diagnostic).not.toContain("private cause");
    },
  );
});
