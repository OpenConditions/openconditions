import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { cameraDraft } from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Québec camera object");
  return value as Record<string, unknown>;
}

/** The WFS inventory licenses metadata and link values, not linked player content. */
export function parseQuebecCameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const bodies = payloads["main"] ?? [];
  if (bodies.length !== 1) throw new Error("Québec cameras require one complete EPSG:4326 export");
  const collection = object(JSON.parse(bodies[0]!.toString("utf8")));
  const rows = collection["features"];
  if (
    collection["type"] !== "FeatureCollection" ||
    !Array.isArray(rows) ||
    rows.length === 0 ||
    collection["numberMatched"] !== rows.length
  )
    throw new Error("Incomplete Québec camera inventory");
  const out = emptyParseOutput();
  const seen = new Set<string>();
  for (const row of rows) {
    const feature = object(row);
    const p = object(feature["properties"]);
    const text = (key: string) =>
      typeof p[key] === "string" && p[key].trim() !== "" ? p[key].trim() : undefined;
    const id = text("IDEcamera");
    if (id === undefined || !/^\d+$/.test(id) || seen.has(id))
      throw new Error("Missing or duplicate Québec camera identity");
    seen.add(id);
    const geometry = object(feature["geometry"]);
    const point = geometry["coordinates"];
    if (
      feature["type"] !== "Feature" ||
      geometry["type"] !== "Point" ||
      !Array.isArray(point) ||
      point.length !== 2 ||
      !point.every((n) => typeof n === "number" && Number.isFinite(n)) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) > 90
    )
      throw new Error("Invalid Québec camera Point");
    const description = [
      ["fr", "DescriptionLocalisationFr"],
      ["en", "DescriptionLocalisationEn"],
    ].flatMap(([lang, key]) => {
      const value = text(key!);
      return value === undefined ? [] : [{ lang: lang!, text: value }];
    });
    const road = text("NumeroRoute");
    out.features.push(
      cameraDraft(
        feed,
        { fetchedAt: ctx.fetchedAt, out },
        {
          cameraId: id,
          point: [point[0], point[1]],
          names: description,
          description,
          type: "traffic",
          ...(road === undefined ? {} : { road: { ref: road } }),
          admin: { country: "CA", subdivision: "CA-QC" },
          detailUrl: text("URL_FLUX_DONNEE"),
          imageRedistribution: "unknown",
          views: [],
        },
      ),
    );
  }
  return out;
}
