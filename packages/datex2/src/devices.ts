import { type DatexPublication, datexPublications } from "./publication.js";
import { type DatexDecodeOptions, skipped } from "./skips.js";
import { localAttribute, localChild, localChildren, localChildText, pointOf } from "./values.js";
import { isXmlObject, type XmlObject } from "./xml.js";

/**
 * DATEX II v3 device publications, decoded to plain records. DGT publishes its
 * traffic cameras this way: the road and kilometre point sit in its Spanish
 * location extensions, and the still image URL in a `deviceUrl` extension
 * element on the device. A device other than a camera is left out; one that
 * names no id is counted as `malformed` under the options' feed, and a
 * direction outside DGT's enumeration as `unknown_value`.
 */

export interface DatexCameraDevice {
  id: string;
  version?: string;
  updatedAt?: string;
  /** The publication creator's country, ISO 3166-1 alpha-2 in capitals. */
  country?: string;
  /** `[lon, lat]`. */
  point?: [number, number];
  roadName?: string;
  /** The destination the road leads to in the direction the camera faces. */
  roadDestination?: string;
  kilometrePoint?: number;
  /** DGT's Spanish location extension: the autonomous community, province and municipality. */
  autonomousCommunity?: string;
  province?: string;
  municipality?: string;
  /**
   * Which carriageway direction the camera faces (DGT `tpegDirectionRoad`);
   * `unknown` and a value outside the enumeration are omitted.
   */
  directionRoad?: "positive" | "negative" | "both";
  imageUrl?: string;
}

/**
 * DGT's `TpegDirectionRoadEnum`. Its schema documents `positive` as "the
 * decreasing direction of the kilometer" and `negative` as the increasing
 * one, but DGT's own data has it the other way round, as TPEG does: on the
 * A-62, which runs from Burgos (kilometre 0) south-west, the cameras facing
 * BURGOS, towards decreasing kilometres, are `negative`. The values are read
 * as the data uses them.
 */
const DIRECTION_ROAD: Readonly<Record<string, DatexCameraDevice["directionRoad"] | null>> = {
  positive: "positive",
  negative: "negative",
  both: "both",
  unknown: null,
};

function isDevicePublication(p: DatexPublication): boolean {
  return p.type === "DevicePublication" || p.type === "";
}

/** The first descendant element with this local name, depth first. */
function descendant(node: unknown, name: string): XmlObject | undefined {
  if (!isXmlObject(node)) return undefined;
  const direct = localChild(node, name);
  if (direct) return direct;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const found = descendant(item, name);
      if (found) return found;
    }
  }
  return undefined;
}

/** Text of the first descendant with this local name; leaf elements are not objects, so look one level up. */
function descendantText(node: unknown, name: string): string | undefined {
  if (!isXmlObject(node)) return undefined;
  const own = localChildText(node, name);
  if (own !== undefined) return own;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const found = descendantText(item, name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function device(
  node: XmlObject,
  country: string | undefined,
  options: DatexDecodeOptions,
): DatexCameraDevice | undefined {
  if (localChildText(node, "typeOfDevice") !== "camera") return undefined;
  const id = localAttribute(node, "id");
  if (id === undefined || id === "") {
    skipped(options, "malformed");
    return undefined;
  }

  const location = localChild(node, "pointLocation");
  const point = pointOf(location);
  const km = descendantText(location, "kilometerPoint");
  const kilometrePoint = km === undefined || !Number.isFinite(Number(km)) ? undefined : Number(km);
  const direction = descendantText(location, "tpegDirectionRoad");
  const directionRoad =
    direction !== undefined && Object.hasOwn(DIRECTION_ROAD, direction)
      ? DIRECTION_ROAD[direction]
      : undefined;
  if (direction !== undefined && directionRoad === undefined) skipped(options, "unknown_value");
  const version = localAttribute(node, "version");
  const updatedAt = localChildText(node, "lastUpdateOfDeviceInformation");
  const roadName = descendantText(descendant(location, "roadInformation"), "roadName");
  const roadDestination = descendantText(
    descendant(location, "roadInformation"),
    "roadDestination",
  );
  const autonomousCommunity = descendantText(location, "autonomousCommunity");
  const province = descendantText(location, "province");
  const municipality = descendantText(location, "municipality");
  const imageUrl = localChildText(node, "deviceUrl");

  return {
    id,
    ...(version !== undefined && { version }),
    ...(updatedAt !== undefined && { updatedAt }),
    ...(country !== undefined && { country }),
    ...(point !== undefined && { point }),
    ...(roadName !== undefined && { roadName }),
    ...(roadDestination !== undefined && { roadDestination }),
    ...(kilometrePoint !== undefined && { kilometrePoint }),
    ...(autonomousCommunity !== undefined && { autonomousCommunity }),
    ...(province !== undefined && { province }),
    ...(municipality !== undefined && { municipality }),
    ...(directionRoad && { directionRoad }),
    ...(imageUrl !== undefined && { imageUrl }),
  };
}

/** The publication creator's country, when it is an ISO 3166-1 alpha-2 code. */
function creatorCountry(publication: DatexPublication): string | undefined {
  const country = localChildText(localChild(publication.body, "publicationCreator"), "country");
  return country !== undefined && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : undefined;
}

/** Every camera device in the document's device publications. */
export function parseDatexCameraDevices(
  doc: XmlObject,
  options: DatexDecodeOptions = {},
): DatexCameraDevice[] {
  return datexPublications(doc)
    .filter(isDevicePublication)
    .flatMap((p) => {
      const country = creatorCountry(p);
      return localChildren(p.body, "device").map((d) => device(d, country, options));
    })
    .filter((d): d is DatexCameraDevice => d !== undefined);
}
