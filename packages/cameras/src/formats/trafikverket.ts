import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import {
  type CameraStatus,
  type CameraType,
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, numberOf, positionSkip, textOf } from "../records.js";

/** Trafikverket names and describes its cameras in Swedish. */
const LANG = "sv";

/** A WKT point, `POINT (lon lat)`, as the object API writes `Geometry.WGS84`. */
const WKT_POINT = /^POINT\s*\(\s*(\S+)\s+(\S+)\s*\)$/i;

/** The `Status` that says a camera's images are available, the only one seen in a real answer. */
const AVAILABLE = "videoOrImagesAvailable";

/**
 * A camera's status: an inactive camera is offline; one whose status says
 * its images are available is online; anything else is unknown.
 * Trafikverket documents no `Status` values, so no other value is read as
 * offline.
 */
function statusOf(camera: Record<string, unknown>): CameraStatus {
  if (camera["Active"] === false) return "offline";
  if (textOf(camera["Status"]) === AVAILABLE) return "online";
  return "unknown";
}

/**
 * The camera type a `Type` gives: a traffic flow camera (`Trafikflödeskamera`,
 * the type of the real answer the fixture holds) watches traffic. No other
 * type is documented, so another is counted and the camera kept as a traffic
 * camera, the service being Trafikverket's road traffic information.
 */
const TYPES: Readonly<Record<string, CameraType>> = { Trafikflödeskamera: "traffic" };

/**
 * The ISO 3166-2:SE code of each county by its county number (`länskod`),
 * which `CountyNo` gives.
 */
const COUNTIES: Readonly<Record<number, string>> = {
  1: "SE-AB",
  3: "SE-C",
  4: "SE-D",
  5: "SE-E",
  6: "SE-F",
  7: "SE-G",
  8: "SE-H",
  9: "SE-I",
  10: "SE-K",
  12: "SE-M",
  13: "SE-N",
  14: "SE-O",
  17: "SE-S",
  18: "SE-T",
  19: "SE-U",
  20: "SE-W",
  21: "SE-X",
  22: "SE-Y",
  23: "SE-Z",
  24: "SE-AC",
  25: "SE-BD",
};

/**
 * The county of a camera's `CountyNo`, a number or a list of them: the one
 * county where it names one, else none. A number that is no county is an
 * unknown value.
 */
function countyOf(feed: CamerasCatalogFeed, value: unknown): string | undefined {
  const numbers = (Array.isArray(value) ? value : [value]).flatMap((n) => {
    const number = numberOf(n);
    return number === undefined ? [] : [number];
  });
  const codes = new Set(
    numbers.flatMap((n) => {
      const code = COUNTIES[n];
      if (code === undefined) recordSkipped(feed.id, "unknown_value");
      return code === undefined ? [] : [code];
    }),
  );
  return codes.size === 1 ? [...codes][0] : undefined;
}

/** The `Camera` objects of an object-API answer; an error answer fails the parse. */
function camerasOf(body: Buffer): unknown[] {
  const doc = jsonOf(body, "the object API answer");
  const response = isRecord(doc) ? doc["RESPONSE"] : undefined;
  const results = isRecord(response) ? response["RESULT"] : undefined;
  if (!Array.isArray(results)) throw new Error("the object API answer carries no RESULT");
  return results.flatMap((result) => {
    if (!isRecord(result)) return [];
    const error = result["ERROR"];
    if (isRecord(error)) {
      throw new Error(
        `the object API answered an error: ${textOf(error["SOURCE"]) ?? "?"}: ${textOf(error["MESSAGE"]) ?? "?"}`,
      );
    }
    return Array.isArray(result["Camera"]) ? result["Camera"] : [];
  });
}

/**
 * Trafikverket's cameras from its object API (`Camera`, namespace
 * `road.infrastructure`, schema 1.1): a camera per record with its one
 * view. A numeric `Direction` is where the camera looks, in degrees;
 * `PhotoTime` is when its photo was taken. The full-size photo is the
 * still where the camera has one, else the plain photo; the thumbnail is
 * the thumbnail, and the location sketch a site image. `CountyNo` places the
 * camera in its county, and `Location` describes where it is. A deleted
 * camera is left out. A camera without an id or
 * whose position is not a WKT point is skipped as malformed, one without a
 * position as having no geometry.
 */
export function parseTrafikverketCameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const body of payloads["main"] ?? []) {
    for (const record of camerasOf(body)) {
      const camera = isRecord(record) ? record : {};
      if (camera["Deleted"] === true) continue;
      const cameraId = textOf(camera["Id"]);
      const geometry = isRecord(camera["Geometry"]) ? camera["Geometry"] : {};
      const wgs84 = textOf(geometry["WGS84"]);
      const wkt = WKT_POINT.exec(wgs84 ?? "");
      const point = wkt === null ? undefined : lonLat(wkt[1], wkt[2]);
      if (cameraId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (point === undefined) {
        const reason =
          wgs84 === undefined
            ? "no_geometry"
            : wkt === null
              ? "malformed"
              : positionSkip(wkt[1], wkt[2]);
        recordSkipped(feed.id, reason);
        continue;
      }
      const name = textOf(camera["Name"]);
      const description = textOf(camera["Description"]);
      const location = textOf(camera["Location"]);
      const type = textOf(camera["Type"]);
      if (type !== undefined && TYPES[type] === undefined) recordSkipped(feed.id, "unknown_value");
      const status = textOf(camera["Status"]);
      if (status !== undefined && status !== AVAILABLE) recordSkipped(feed.id, "unknown_value");
      const subdivision = countyOf(feed, camera["CountyNo"]);
      const sketch =
        camera["HasSketchImage"] === false ? undefined : textOf(camera["PhotoUrlSketch"]);
      const bearingDeg = numberOf(camera["Direction"]);
      const fullSize =
        camera["HasFullSizePhoto"] === true ? textOf(camera["PhotoUrlFullsize"]) : undefined;
      const still = fullSize ?? textOf(camera["PhotoUrl"]);
      const thumbnail = textOf(camera["PhotoUrlThumbnail"]);
      const photoTime = textOf(camera["PhotoTime"]);
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: name === undefined ? [] : [{ lang: LANG, text: name }],
          ...(description === undefined
            ? {}
            : { description: [{ lang: LANG, text: description }] }),
          // The location often repeats the description word for word.
          ...(location === undefined || location === description
            ? {}
            : { areaDescription: [{ lang: LANG, text: location }] }),
          admin: { country: "SE", ...(subdivision === undefined ? {} : { subdivision }) },
          ...(sketch === undefined ? {} : { images: [{ url: sketch, category: "other" }] }),
          type: TYPES[type ?? ""] ?? "traffic",
          imageRedistribution: imageRedistributionOf(feed, "allowed"),
          views: [{ key: "0", ...(bearingDeg === undefined ? {} : { bearingDeg }) }],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: "0",
          status: statusOf(camera),
          point,
          ...(still === undefined ? {} : { imageUrl: still }),
          ...(thumbnail === undefined ? {} : { thumbnailUrl: thumbnail }),
          ...(photoTime === undefined ? {} : { imageAt: photoTime }),
        }),
      );
    }
  }
  return out;
}
