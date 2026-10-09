import { isRecord } from "./records.js";

/**
 * The features of an ArcGIS GeoJSON answer. A query the service refused is an
 * `{error}` document at HTTP 200, which fails the parse so the last good
 * publication stands; so does an answer that holds no feature list.
 */
export function arcgisFeatures(body: Buffer, publisher: string): unknown[] {
  const root: unknown = JSON.parse(body.toString("utf8"));
  if (isRecord(root) && isRecord(root["error"])) {
    const error = root["error"];
    const detail = [
      error["code"],
      error["message"],
      ...(Array.isArray(error["details"]) ? error["details"] : []),
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    throw new Error(`${publisher} answered an error${detail === "" ? "" : `: ${detail}`}`);
  }
  const features = isRecord(root) ? root["features"] : undefined;
  if (!Array.isArray(features)) throw new Error(`${publisher} answered no feature collection`);
  return features;
}
