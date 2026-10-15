import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { loadIngestCatalog } from "../domains.js";
import { FeedStatusStore } from "../feed-status.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { bindSituation, registry, situationDraft, writeSituations } from "./helpers/situations.js";

let db: TestDatabase;
let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;

const NOW = "2026-09-06T10:00:00.000Z";
const AT = "at=2026-09-06T10:00:00Z";
type Rec = Record<string, unknown>;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  app = Fastify();
  registerApiRoutes(app, sql, { registry });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.record_binding, conditions.record_segment,
    conditions.binding_queue, conditions.source_status CASCADE`;
});

/** A point situation `local` of `source` at `[lon, lat]`; `over` replaces top-level fields. */
function at(
  local: string,
  lon: number,
  lat: number,
  over: Rec = {},
  source = "de-autobahn-events",
): Rec {
  const draft = situationDraft(local, over, source);
  return {
    ...draft,
    location: {
      ...(draft["location"] as Rec),
      geometry: { type: "Point", coordinates: [lon, lat] },
      extent: "point",
    },
  };
}

async function get(url: string) {
  const res = await app.inject({ method: "GET", url });
  return { res, body: res.json() as Rec };
}

const ids = (body: Rec) => (body["records"] as Rec[]).map((r) => r["id"]);

describe("GET /situations", () => {
  it("walks every live situation once, page by page", async () => {
    await writeSituations(
      sql,
      "de-autobahn-events",
      Array.from({ length: 7 }, (_, i) => at(`s${i}`, 6.8 + i / 100, 51.2)),
    );
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const { res, body }: { res: { statusCode: number }; body: Rec } = await get(
        `/situations?${AT}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.statusCode).toBe(200);
      seen.push(...ids(body));
      cursor = body["next"] as string | null;
    } while (cursor !== null);
    expect(seen).toEqual(
      Array.from({ length: 7 }, (_, i) => `oc:situation:de-autobahn-events:s${i}`),
    );
  });

  it("never returns a record twice nor skips one that exists throughout a walk under writes", async () => {
    await writeSituations(
      sql,
      "de-autobahn-events",
      Array.from({ length: 6 }, (_, i) => at(`k${i}`, 6.8, 51.2)),
    );
    const first = await get(`/situations?${AT}&limit=2`);
    // Between pages: one situation withdrawn, one changed, two new ones.
    await writeSituations(
      sql,
      "de-autobahn-events",
      [
        ...[0, 1, 3, 4, 5].map((i) => at(`k${i}`, 6.8, 51.2)),
        at("k2b", 6.8, 51.2),
        at("k9", 6.8, 51.2, { headline: [{ lang: "de", text: "geändert" }] }),
      ],
      "2026-09-06T10:01:00.000Z",
    );
    const seen = [...ids(first.body)];
    let cursor = first.body["next"] as string | null;
    while (cursor !== null) {
      const { body } = await get(`/situations?${AT}&limit=2&cursor=${encodeURIComponent(cursor)}`);
      seen.push(...ids(body));
      cursor = body["next"] as string | null;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const i of [0, 1, 3, 4, 5])
      expect(seen).toContain(`oc:situation:de-autobahn-events:k${i}`);
  });

  it("filters by box, kind, excluded kind, source, severity and the instant situations are current at", async () => {
    await writeSituations(sql, "de-autobahn-events", [
      at("near", 6.81, 51.2),
      at("far", 13.4, 52.5),
      at("minor", 6.81, 51.2, { severity: { label: "minor", source: "derived" } }),
      at("ended", 6.81, 51.2, {
        validity: { status: "active", start: "2026-09-05T00:00:00Z", end: "2026-09-06T09:00:00Z" },
      }),
      at("later", 6.81, 51.2, {
        validity: { status: "active", start: "2026-09-20T00:00:00Z" },
      }),
    ]);
    await writeSituations(sql, "nl-ndw-events", [at("dutch", 6.81, 51.2, {}, "nl-ndw-events")]);
    const list = async (query: string) => ids((await get(`/situations?${AT}&${query}`)).body);
    expect(await list("bbox=6.7,51.1,6.9,51.3")).not.toContain(
      "oc:situation:de-autobahn-events:far",
    );
    expect(await list("source=nl-ndw-events")).toEqual(["oc:situation:nl-ndw-events:dutch"]);
    expect(await list("minSeverity=major")).not.toContain("oc:situation:de-autobahn-events:minor");
    expect(await list("kind=incident")).toEqual([]);
    expect(await list("excludeKind=incident,closure")).toEqual([]);
    expect(await list("excludeKind=incident")).toContain("oc:situation:nl-ndw-events:dutch");
    expect(await list("limit=50")).not.toContain("oc:situation:de-autobahn-events:ended");
    expect(await list("horizonDays=3")).not.toContain("oc:situation:de-autobahn-events:later");
    expect(await list("horizonDays=30")).toContain("oc:situation:de-autobahn-events:later");
  });

  it("lists a situation in a box one of its effects reaches with its own place", async () => {
    const far = at("far", 13.4, 52.5, {
      effects: [
        {
          id: "far/closure",
          kind: "closure",
          v: 1,
          scope: "road",
          applicability: { kind: "all" },
          compliance: "mandatory",
          normalization: "complete",
          location: {
            geometry: { type: "Point", coordinates: [6.81, 51.2] },
            extent: "point",
            geometryOrigin: "source",
          },
        },
      ],
    });
    await writeSituations(sql, "de-autobahn-events", [far]);
    expect(ids((await get(`/situations?${AT}&bbox=6.7,51.1,6.9,51.3`)).body)).toEqual([
      "oc:situation:de-autobahn-events:far",
    ]);
  });

  it("withholds share-alike records and names the licences served", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("open", 6.81, 51.2)]);
    const shareAlike = at("sa", 6.81, 51.2, {}, "de-sa");
    await writeSituations(sql, "de-sa", [
      {
        ...shareAlike,
        provenance: {
          ...(shareAlike["provenance"] as Rec),
          attribution: { provider: "SA", license: "CC-BY-SA-4.0" },
        },
      },
    ]);
    const { res, body } = await get(`/situations?${AT}`);
    expect(ids(body)).toEqual(["oc:situation:de-autobahn-events:open"]);
    expect(res.headers["x-data-license"]).toBe("DL-DE-BY-2.0");
  });

  it("folds one phenomenon from two sources into one on request, keeping both attributions", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("a", 6.81, 51.2)]);
    await writeSituations(sql, "de-other", [at("b", 6.8102, 51.2001, {}, "de-other")]);
    expect(ids((await get(`/situations?${AT}`)).body)).toHaveLength(2);
    const { body } = await get(`/situations?${AT}&dedupe=1`);
    const [merged] = body["records"] as Rec[];
    expect(body["records"]).toHaveLength(1);
    expect((merged!["provenance"] as Rec)["mergedSources"]).toEqual([
      expect.objectContaining({ source: "de-other", link: "same_phenomenon" }),
    ]);
  });

  it("keeps opposite directions separate when dedupe is requested", async () => {
    const a = at("a", 6.81, 51.2);
    const b = at("b", 6.8102, 51.2001, {}, "de-other");
    (a["location"] as Rec)["direction"] = { value: "positive", basis: "road_reference" };
    (b["location"] as Rec)["direction"] = { value: "negative", basis: "road_reference" };
    await writeSituations(sql, "de-autobahn-events", [a]);
    await writeSituations(sql, "de-other", [b]);
    expect(ids((await get(`/situations?${AT}&dedupe=1`)).body)).toEqual([a["id"], b["id"]]);
  });

  it("retains different speed restrictions in every deduplicated projection", async () => {
    const a = at("a", 6.81, 51.2);
    const b = at("b", 6.8102, 51.2001, {}, "de-other");
    for (const [draft, value] of [
      [a, 30],
      [b, 80],
    ] as const) {
      (draft["effects"] as Rec[]).push({
        id: `${draft["id"]}/speed`,
        kind: "speed_limit",
        v: 1,
        applicability: { kind: "all" },
        compliance: "mandatory",
        normalization: "complete",
        limit: { value, unit: "km/h" },
      });
    }
    await writeSituations(sql, "de-autobahn-events", [a]);
    await writeSituations(sql, "de-other", [b]);
    expect(ids((await get(`/situations?${AT}&dedupe=1`)).body)).toEqual([a["id"], b["id"]]);
    for (const path of ["/situations.geojson", "/situations.jsonld"]) {
      const { res, body } = await get(`${path}?${AT}&dedupe=1`);
      expect(res.statusCode).toBe(200);
      expect((body["features"] as Rec[]).map((r) => r["id"])).toEqual([a["id"], b["id"]]);
    }
    for (const path of ["/traff.xml", "/datex2/situations.xml"]) {
      const response = await app.inject(`${path}?${AT}&dedupe=1`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`id="${a["id"]}"`);
      expect(response.body).toContain(`id="${b["id"]}"`);
    }
  });

  it("retains distinct validity windows in a deduplicated historical query", async () => {
    await writeSituations(sql, "de-autobahn-events", [
      at("a", 6.81, 51.2, {
        validity: { status: "active", start: "2026-09-05T08:00:00Z", end: "2026-09-05T12:00:00Z" },
      }),
    ]);
    await writeSituations(sql, "de-other", [
      at(
        "b",
        6.8102,
        51.2001,
        {
          validity: {
            status: "active",
            start: "2026-09-06T08:00:00Z",
            end: "2026-09-06T12:00:00Z",
          },
        },
        "de-other",
      ),
    ]);
    const { res, body } = await get(
      `/situations?from=2026-09-05T00:00:00Z&to=2026-09-07T00:00:00Z&dedupe=1`,
    );
    expect(res.statusCode).toBe(200);
    expect(ids(body)).toEqual(["oc:situation:de-autobahn-events:a", "oc:situation:de-other:b"]);
  });

  it("does not fold distinct extents after response simplification erased their difference", async () => {
    const a = at("a", 6.81, 51.2);
    const b = at("b", 6.81, 51.2, {}, "de-other");
    for (const [draft, bend] of [
      [a, 51.2001],
      [b, 51.1999],
    ] as const) {
      Object.assign(draft["location"] as Rec, {
        extent: "linear",
        geometry: {
          type: "LineString",
          coordinates: [
            [6.8, 51.2],
            [6.81, bend],
            [6.82, 51.2],
          ],
        },
      });
    }
    await writeSituations(sql, "de-autobahn-events", [a]);
    await writeSituations(sql, "de-other", [b]);
    const { res, body } = await get(`/situations?${AT}&simplify=0.001&dedupe=1`);
    expect(res.statusCode).toBe(200);
    expect(ids(body)).toEqual([a["id"], b["id"]]);
    expect((body["records"] as Rec[]).map((r) => (r["location"] as Rec)["geometry"])).toEqual([
      {
        type: "LineString",
        coordinates: [
          [6.8, 51.2],
          [6.82, 51.2],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [6.8, 51.2],
          [6.82, 51.2],
        ],
      },
    ]);
    for (const path of ["/traff.xml", "/datex2/situations.xml"]) {
      const response = await app.inject(`${path}?${AT}&simplify=0.001&dedupe=1`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`id="${a["id"]}"`);
      expect(response.body).toContain(`id="${b["id"]}"`);
    }
  });

  it("refuses a malformed query", async () => {
    for (const query of ["limit=0", "limit=5001", "bbox=1,2,3", "minSeverity=low", "nope=1"]) {
      expect((await get(`/situations?${query}`)).res.statusCode, query).toBe(400);
    }
  });
});

describe("GET /situations.geojson and .jsonld", () => {
  it("wraps each record as a feature with its effects' states, and pages like the JSON", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("g1", 6.81, 51.2), at("g2", 6.82, 51.2)]);
    const { res, body } = await get(`/situations.geojson?${AT}&limit=1`);
    expect(res.headers["content-type"]).toContain("application/geo+json");
    expect(body).toMatchObject({
      type: "FeatureCollection",
      next: "oc:situation:de-autobahn-events:g1",
    });
    const [feature] = body["features"] as Rec[];
    expect(feature).toMatchObject({
      type: "Feature",
      id: "oc:situation:de-autobahn-events:g1",
      geometry: { type: "Point", coordinates: [6.81, 51.2] },
    });
    expect((feature!["properties"] as Rec)["effectStates"]).toEqual({
      "g1/closure": { state: "active", nextTransitionAt: null },
    });
    const ld = await get(`/situations.jsonld?${AT}&limit=1`);
    expect(ld.body["@context"]).toBeDefined();
    expect((ld.body["features"] as Rec[])[0]).toMatchObject({
      "@type": "schema:SpecialAnnouncement",
    });
  });
});

describe("GET /traff.xml and /datex2/situations.xml", () => {
  it("emit public tellable situations, with TraFF complete and DATEX paged", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("t1", 6.81, 51.2), at("t2", 6.82, 51.2)]);
    const shareAlike = at("sa", 6.81, 51.2, {}, "de-sa");
    await writeSituations(sql, "de-sa", [
      {
        ...shareAlike,
        provenance: {
          ...(shareAlike["provenance"] as Rec),
          attribution: { provider: "SA", license: "CC-BY-SA-4.0" },
        },
      },
    ]);
    const traff = await app.inject({ method: "GET", url: `/traff.xml?${AT}` });
    expect(traff.statusCode).toBe(200);
    expect(traff.headers["content-type"]).toContain("application/xml");
    expect(traff.body).toContain('id="oc:situation:de-autobahn-events:t1"');
    expect(traff.body).toContain('type="RESTRICTION_CLOSED"');
    expect(traff.body).toContain('id="oc:situation:de-autobahn-events:t2"');
    expect(traff.body).not.toContain("de-sa");
    expect(traff.headers["link"]).toBeUndefined();
    const datexPage = await app.inject(`/datex2/situations.xml?${AT}&limit=1`);
    expect(datexPage.headers["link"]).toContain('rel="next"');
    const datex = await app.inject({ method: "GET", url: `/datex2/situations.xml?${AT}` });
    expect(datex.body).toContain('id="oc:situation:de-autobahn-events:t2"');
    expect(datex.body).toContain("roadClosed");
    expect(datex.body).not.toContain("de-sa");
    expect(datex.headers["link"]).toBeUndefined();
    expect(datex.headers["x-data-license"]).toBe("DL-DE-BY-2.0");
  });
});

describe("GET /stream", () => {
  it("sends the live situations, then what changed and what went", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("s1", 6.81, 51.2), at("s2", 6.82, 51.2)]);
    const streaming = Fastify();
    registerApiRoutes(streaming, sql, { registry, streamPollMs: 50 });
    const address = await streaming.listen({ port: 0, host: "127.0.0.1" });
    const abort = new AbortController();
    try {
      const res = await fetch(`${address}/stream?kind=closure&bbox=6.7,51.1,6.9,51.3`, {
        signal: abort.signal,
      });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body!.getReader();
      let text = "";
      const until = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${needle}`);
          text += new TextDecoder().decode(value);
        }
      };
      await until("id: oc:situation:de-autobahn-events:s2\nevent: situation\n");
      expect(text).toContain("id: oc:situation:de-autobahn-events:s1\nevent: situation\n");
      await writeSituations(
        sql,
        "de-autobahn-events",
        [at("s1", 6.81, 51.2)],
        "2026-09-06T10:05:00.000Z",
      );
      await until('event: remove\ndata: {"id":"oc:situation:de-autobahn-events:s2"}');
    } finally {
      abort.abort();
      await streaming.close();
    }
  });

  it.each(["connected", "reconnected"] as const)(
    "reconciles cancellation, bbox exit, rights withdrawal and expiry when %s",
    async (mode) => {
      const initial = ["cancel", "exit", "rights", "expire", "stay"].map((id) =>
        at(id, 6.81, 51.2),
      );
      await writeSituations(sql, "de-autobahn-events", initial);
      const streaming = Fastify();
      registerApiRoutes(streaming, sql, { registry, streamPollMs: 50 });
      const address = await streaming.listen({ host: "127.0.0.1", port: 0 });
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), 15_000);
      const view = new Map<string, Rec>();
      const events: string[] = [];
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let buffered = "";
      const open = async (lastEventId?: string) => {
        const response = await fetch(`${address}/stream?bbox=6.7,51.1,6.9,51.3`, {
          signal: abort.signal,
          ...(lastEventId ? { headers: { "Last-Event-ID": lastEventId } } : {}),
        });
        expect(response.status).toBe(200);
        reader = response.body!.getReader();
        buffered = "";
        // Consumer contract: a successful new connection starts a replacement
        // view. SSE record IDs are identities, not durable replay positions.
        view.clear();
      };
      const until = async (ready: () => boolean) => {
        const decoder = new TextDecoder();
        while (!ready()) {
          const chunk = await reader!.read();
          if (chunk.done) throw new Error("stream ended before reconciliation");
          buffered += decoder.decode(chunk.value, { stream: true });
          const frames = buffered.split("\n\n");
          buffered = frames.pop() ?? "";
          for (const frame of frames) {
            const event = /^event: (.*)$/m.exec(frame)?.[1];
            const json = /^data: (.*)$/m.exec(frame)?.[1];
            if (!json || !event) continue;
            events.push(event);
            const record = JSON.parse(json) as Rec;
            if (event === "remove") view.delete(String(record["id"]));
            else if (event === "situation") view.set(String(record["id"]), record);
          }
        }
      };
      try {
        await open();
        await until(() => view.size === 5);
        if (mode === "reconnected") await reader!.cancel();
        const provenance = initial[2]!["provenance"] as Rec;
        await writeSituations(sql, "de-autobahn-events", [
          at("cancel", 6.81, 51.2, { validity: { status: "cancelled" } }),
          at("exit", 13, 52),
          at("rights", 6.81, 51.2, {
            provenance: {
              ...provenance,
              attribution: { provider: "Autobahn GmbH", license: "NOASSERTION" },
            },
          }),
          at("expire", 6.81, 51.2, {
            freshness: { fetchedAt: NOW, expiresAt: new Date(Date.now() - 1000).toISOString() },
          }),
          at("stay", 6.81, 51.2),
          at("new", 6.81, 51.2),
        ]);
        events.length = 0;
        if (mode === "reconnected") await open("oc:situation:de-autobahn-events:stay");
        const expected = ["new", "stay"].map((id) => `oc:situation:de-autobahn-events:${id}`);
        await until(() => view.size === 2 && expected.every((id) => view.has(id)));
        expect([...view.keys()].sort()).toEqual(expected);
        if (mode === "connected") expect(events.filter((e) => e === "remove")).toHaveLength(4);
        else expect(events).toEqual(["situation", "situation"]);
      } finally {
        clearTimeout(deadline);
        abort.abort();
        await streaming.close();
      }
    },
  );

  it("reconnects to an empty replacement without inventing offline removals", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("gone-offline", 6.81, 51.2)]);
    const streaming = Fastify();
    registerApiRoutes(streaming, sql, { registry, streamPollMs: 50 });
    const address = await streaming.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 15_000);
    const firstFrame = async (lastEventId?: string) => {
      const response = await fetch(`${address}/stream`, {
        signal: abort.signal,
        ...(lastEventId ? { headers: { "Last-Event-ID": lastEventId } } : {}),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (!text.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("stream closed before a frame");
          text += decoder.decode(chunk.value, { stream: true });
        }
        return text.split("\n\n")[0];
      } finally {
        await reader.cancel();
      }
    };
    try {
      expect(await firstFrame()).toContain('"id":"oc:situation:de-autobahn-events:gone-offline"');
      await writeSituations(sql, "de-autobahn-events", []);
      expect(await firstFrame("oc:situation:de-autobahn-events:gone-offline")).toBe(": ping");
    } finally {
      clearTimeout(deadline);
      abort.abort();
      await streaming.close();
    }
  });

  it("refuses a connection beyond its cap, and takes one again once a client leaves", async () => {
    const streaming = Fastify();
    registerApiRoutes(streaming, sql, { registry, streamPollMs: 50, streamMaxConnections: 1 });
    const address = await streaming.listen({ port: 0, host: "127.0.0.1" });
    const first = new AbortController();
    try {
      const open = await fetch(`${address}/stream`, { signal: first.signal });
      expect(open.status).toBe(200);
      const refused = await fetch(`${address}/stream`);
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("30");
      first.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const again = new AbortController();
      expect((await fetch(`${address}/stream`, { signal: again.signal })).status).toBe(200);
      again.abort();
    } finally {
      first.abort();
      await streaming.close();
    }
  });

  it("ends a connected client's stream when the server closes, rather than waiting on it", async () => {
    const streaming = Fastify();
    registerApiRoutes(streaming, sql, { registry, streamPollMs: 50 });
    const address = await streaming.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    const started = Date.now();
    await streaming.close();
    expect(Date.now() - started).toBeLessThan(1000);
    // The server ends the response: the body finishes or breaks off.
    const ended = (async () => {
      try {
        for (;;) if ((await reader.read()).done) return "ended";
      } catch {
        return "ended";
      }
    })();
    await expect(ended).resolves.toBe("ended");
  });

  it("refuses a malformed query before opening the stream", async () => {
    expect((await get("/stream?class=feature")).res.statusCode).toBe(400);
    expect((await get("/stream?cursor=x")).res.statusCode).toBe(400);
  });
});

describe("GET /situations/{id}", () => {
  it("serves one situation with its binding, tombstoned or not, and 404 for an unknown one", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("one", 6.81, 51.2)]);
    await bindSituation(sql, "oc:situation:de-autobahn-events:one", {
      status: "exact",
      confidence: 0.9,
      generation: "g",
      resolverVersion: "2.0.0",
    });
    const url = `/situations/${encodeURIComponent("oc:situation:de-autobahn-events:one")}`;
    const { body } = await get(url);
    expect(body).toMatchObject({
      record: { id: "oc:situation:de-autobahn-events:one" },
      binding: { status: "exact", confidence: 0.9, directionMode: "single" },
      effectBindings: {},
    });
    // An effect with a place of its own is bound on its own: shown per effect.
    await bindSituation(sql, "oc:situation:de-autobahn-events:one", {
      effectId: "one/closure",
      status: "likely",
      confidence: 0.6,
      generation: "g",
      resolverVersion: "2.0.0",
    });
    expect((await get(url)).body).toMatchObject({
      binding: { status: "exact" },
      effectBindings: { "one/closure": { status: "likely", confidence: 0.6 } },
    });
    await writeSituations(sql, "de-autobahn-events", [], "2026-09-06T11:00:00.000Z");
    expect((await get(url)).body).toMatchObject({
      record: { tombstone: { reason: "withdrawn" } },
    });
    expect(
      (await get("/situations/oc%3Asituation%3Ade-autobahn-events%3Anone")).res.statusCode,
    ).toBe(404);
  });
});

describe("GET /situations/{id} past its expiry", () => {
  it("answers 404 once the situation's expiry has passed, as the listing does", async () => {
    await writeSituations(sql, "de-autobahn-events", [
      at("lapsed", 6.81, 51.2, {
        freshness: { fetchedAt: "2026-09-06T09:00:00.000Z", expiresAt: "2026-09-06T11:00:00.000Z" },
      }),
    ]);
    const url = `/situations/${encodeURIComponent("oc:situation:de-autobahn-events:lapsed")}`;
    expect((await get(`${url}?${AT}`)).res.statusCode).toBe(200);
    expect(ids((await get(`/situations?${AT}`)).body)).toContain(
      "oc:situation:de-autobahn-events:lapsed",
    );
    expect((await get(`${url}?at=2026-09-06T12:00:00Z`)).res.statusCode).toBe(404);
    expect(ids((await get("/situations?at=2026-09-06T12:00:00Z")).body)).toEqual([]);
    // Without `at`, the instant is now: long after it expired.
    expect((await get(url)).res.statusCode).toBe(404);
  });
});

describe("GET /history/{class}/{id}", () => {
  it("lists a situation's revisions oldest first with what changed", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("h", 6.81, 51.2)]);
    await writeSituations(sql, "de-autobahn-events", [], "2026-09-06T11:00:00.000Z");
    const { res, body } = await get(
      `/history/situation/${encodeURIComponent("oc:situation:de-autobahn-events:h")}`,
    );
    expect((body["revisions"] as Rec[]).map((r) => [r["revision"], r["changeKinds"]])).toEqual([
      [1, ["created"]],
      [2, ["tombstoned"]],
    ]);
    expect(res.headers["x-data-license"]).toBe("DL-DE-BY-2.0");
    expect((await get("/history/situation/unknown")).res.statusCode).toBe(404);
    expect((await get("/history/event/x")).res.statusCode).toBe(400);
  });
});

describe("registry and coverage routes", () => {
  it("serves the taxonomy and the JSON Schemas of the running registry", async () => {
    const taxonomy = (await get("/taxonomy")).body;
    expect((taxonomy["kinds"] as Rec[]).some((k) => k["code"] === "closure")).toBe(true);
    const index = (await get("/schemas/index.json")).body as unknown as { file: string }[];
    const closure = index.find((entry) => entry.file.startsWith("situation/closure@"));
    expect(closure).toBeDefined();
    expect((await get(`/schemas/${closure!.file}`)).res.statusCode).toBe(200);
    expect((await get("/schemas/situation/nothing@1.json")).res.statusCode).toBe(404);
  });

  it("counts live situations per country, kind and access mode with their sources", async () => {
    await writeSituations(sql, "de-autobahn-events", [at("c1", 6.81, 51.2), at("c2", 6.82, 51.2)]);
    await sql`INSERT INTO conditions.source_status (source, last_success_at, freshness_window_sec)
      VALUES ('de-autobahn-events', ${NOW}, 900)`;
    const { body } = await get("/coverage");
    expect(body["coverage"]).toEqual([
      {
        country: "DE",
        subdivision: null,
        class: "situation",
        kind: "closure",
        accessMode: "bulk",
        records: 2,
        sources: ["de-autobahn-events"],
        lastSuccessAt: NOW,
        freshUntil: null,
      },
    ]);
  });

  it("serves the OpenAPI document", async () => {
    expect((await get("/openapi.json")).body).toMatchObject({ openapi: "3.1.0" });
  });
});

describe("GET /feeds/status", () => {
  it("disabled feeds show in the status endpoint", async () => {
    const catalog = await loadIngestCatalog({
      OPENCONDITIONS_FEEDS_DIR: fileURLToPath(
        new URL("./fixtures/catalog-disabled", import.meta.url),
      ),
    });
    const status = Fastify();
    registerPublishRoutes(status, sql, new FeedStatusStore(), catalog);
    await status.ready();
    try {
      const res = await status.inject({ method: "GET", url: "/feeds/status" });
      expect(res.statusCode).toBe(200);
      const feeds = (res.json() as { feeds: Rec[] }).feeds;
      expect(feeds.find((f) => f["id"] === "lu-fixture-events")).toMatchObject({
        domain: "roads",
        state: "disabled",
        disabledReason: "fixture: upstream retired the endpoint",
      });
      expect(feeds.find((f) => f["id"] === "nl-ndw-events")).not.toHaveProperty("state");
    } finally {
      await status.close();
    }
  });
});
