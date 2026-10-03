import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autobahnIndexResolver } from "../autobahn.js";
import { roadChildren } from "../child-schema.js";
import vendored from "../snapshots/autobahn-index.json" with { type: "json" };

const INDEX = path.resolve(
  import.meta.dirname,
  "../../__tests__/fixtures/autobahn/road-index.json",
);

/** The catalogue parent, naming the road index the resolver reads. */
const PARENT = {
  endpoints: { main: { url: "https://verkehr.autobahn.de/o/autobahn/", cadenceSec: 300 } },
};

function jsonResponder(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
    })) as unknown as typeof fetch;
}

describe("autobahnIndexResolver", () => {
  const index = JSON.parse(readFileSync(INDEX, "utf8"));

  it("emits warning + closure + roadworks children per unique road (A60/'A60 ' collapse)", async () => {
    const children = await autobahnIndexResolver.resolve(PARENT, jsonResponder(index));
    expect(children).toHaveLength(15); // 5 roads x 3 services
    const urls = children.map((c) => c.endpoints["main"]?.url);
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A1/services/warning");
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A1/services/closure");
    expect(urls).toContain("https://verkehr.autobahn.de/o/autobahn/A1/services/roadworks");
    expect(urls.some((u) => u?.includes("A60%20") || u?.includes("A60 "))).toBe(false);
    for (const child of children) {
      expect(child.license).toBe("DL-DE-BY-2.0");
      expect(child.selectionState).toBe("approved");
    }
    expect(new Set(children.map((c) => c.qualifier)).size).toBe(children.length);
    expect(children.map((c) => c.qualifier)).toContain("a1-warning");
  });

  it("names a child by road and service only, leaving region, operator and product to its parent", async () => {
    const [child] = await autobahnIndexResolver.resolve(PARENT, jsonResponder(index));
    expect(child).not.toHaveProperty("operator");
    expect(child).not.toHaveProperty("product");
    expect(child!.qualifier).toMatch(/^a\d+-(warning|closure|roadworks)$/);
  });

  it("polls roadworks three times slower than the incident services", async () => {
    const children = await autobahnIndexResolver.resolve(PARENT, jsonResponder(index));
    const bySuffix = (suffix: string) =>
      children.filter((c) => c.endpoints["main"]?.url?.endsWith(`/services/${suffix}`));

    expect(bySuffix("roadworks")).not.toHaveLength(0);
    for (const c of bySuffix("roadworks")) expect(c.endpoints["main"]?.cadenceSec).toBe(900);
    for (const c of [...bySuffix("warning"), ...bySuffix("closure")]) {
      expect(c.endpoints["main"]?.cadenceSec).toBe(300);
    }
  });

  it("reads the index its parent names and puts each road's services under it", async () => {
    const requested: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(JSON.stringify(index));
    }) as typeof fetch;
    const mirror = {
      endpoints: { main: { url: "https://mirror.example.test/ab/", cadenceSec: 300 } },
    };
    const children = await autobahnIndexResolver.resolve(mirror, fetchFn);
    expect(requested).toEqual(["https://mirror.example.test/ab/"]);
    expect(children.map((c) => c.endpoints["main"]?.url)).toContain(
      "https://mirror.example.test/ab/A1/services/warning",
    );
    expect(
      children.every((c) =>
        c.endpoints["main"]?.url?.startsWith("https://mirror.example.test/ab/"),
      ),
    ).toBe(true);
  });

  it("puts the services under the index whether or not its URL ends in a slash", async () => {
    const bare = {
      endpoints: { main: { url: "https://mirror.example.test/ab", cadenceSec: 300 } },
    };
    const children = await autobahnIndexResolver.resolve(bare, jsonResponder(index));
    expect(children.map((c) => c.endpoints["main"]?.url)).toContain(
      "https://mirror.example.test/ab/A1/services/warning",
    );
  });

  it("round-trips its children through the snapshot unchanged", async () => {
    const live = await autobahnIndexResolver.resolve(PARENT, jsonResponder(index));
    expect(roadChildren(JSON.parse(JSON.stringify(live)))).toEqual(live);
    expect(autobahnIndexResolver.snapshot).toEqual(vendored);
    expect(autobahnIndexResolver.snapshot.length).toBeGreaterThan(0);
  });

  it("throws when the index responds non-ok", async () => {
    await expect(autobahnIndexResolver.resolve(PARENT, jsonResponder("", 503))).rejects.toThrow(
      /503/,
    );
  });

  it("returns no children when the index has no roads array", async () => {
    expect(await autobahnIndexResolver.resolve(PARENT, jsonResponder({}))).toEqual([]);
  });

  it("returns no children when roads is present but not an array", async () => {
    expect(await autobahnIndexResolver.resolve(PARENT, jsonResponder({ roads: "x" }))).toEqual([]);
  });
});
