import { observationsByBbox } from "@openconditions/core";
import type { IntegrationContext } from "./types.js";

// Attribution for this integration is wired in the monorepo via the manifest dataSources.

function parseBbox(raw: string | undefined): [number, number, number, number] | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return null;
  const [west, south, east, north] = parts as [number, number, number, number];
  return [west, south, east, north];
}

function bboxKey(bbox: [number, number, number, number]): string {
  return bbox.map((n) => n.toFixed(4)).join(",");
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/observations", async (req, reply) => {
    const domain = req.query["domain"] ?? "roads";
    const bbox = parseBbox(req.query["bbox"]);

    if (!bbox) {
      reply.status(400).send({ error: "bbox required: west,south,east,north" });
      return reply;
    }

    const types = (req.query["types"] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const minSeverity = req.query["minSeverity"] || undefined;

    const cacheKey = `conditions:query:${domain}:${bboxKey(bbox)}:${types.join("+")}:${minSeverity ?? ""}`;

    const fc = await ctx.cache.withCache(cacheKey, 90, () =>
      observationsByBbox(ctx.db, {
        domain,
        bbox,
        types: types.length > 0 ? types : undefined,
        minSeverity,
      }),
    );

    reply.header("Cache-Control", "public, max-age=90, s-maxage=90");
    reply.send(fc);
    return reply;
  });
}
