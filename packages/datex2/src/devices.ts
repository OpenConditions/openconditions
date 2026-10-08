import { type DatexPublication, datexPublications } from "./publication.js";
import { localAttribute, localChild, localChildren, localChildText, pointOf } from "./values.js";
import { isXmlObject, type XmlObject } from "./xml.js";

/**
 * DATEX II v3 device publications, decoded to plain records. DGT publishes its
 * traffic cameras this way: the road and kilometre point sit in its Spanish
 * location extensions, and the still image URL in a `deviceUrl` extension
 * element on the device.
 */

export interface DatexCameraDevice {
  id: string;
  version?: string;
  updatedAt?: string;
  /** `[lon, lat]`. */
  point?: [number, number];
  roadName?: string;
  roadDestination?: string;
  kilometrePoint?: number;
  province?: string;
  /** Which carriageway direction the camera faces; any other published value is omitted. */
  directionRoad?: "positive" | "negative" | "both";
  imageUrl?: string;
}

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

function device(node: XmlObject): DatexCameraDevice | undefined {
  const id = localAttribute(node, "id");
  if (id === undefined || id === "") return undefined;
  if (localChildText(node, "typeOfDevice") !== "camera") return undefined;

  const location = localChild(node, "pointLocation");
  const point = pointOf(location);
  const km = descendantText(location, "kilometerPoint");
  const kilometrePoint = km === undefined || !Number.isFinite(Number(km)) ? undefined : Number(km);
  const direction = descendantText(location, "tpegDirectionRoad");
  const version = localAttribute(node, "version");
  const updatedAt = localChildText(node, "lastUpdateOfDeviceInformation");
  const roadName = descendantText(descendant(location, "roadInformation"), "roadName");
  const roadDestination = descendantText(
    descendant(location, "roadInformation"),
    "roadDestination",
  );
  const province = descendantText(location, "province");
  const imageUrl = localChildText(node, "deviceUrl");

  return {
    id,
    ...(version !== undefined && { version }),
    ...(updatedAt !== undefined && { updatedAt }),
    ...(point !== undefined && { point }),
    ...(roadName !== undefined && { roadName }),
    ...(roadDestination !== undefined && { roadDestination }),
    ...(kilometrePoint !== undefined && { kilometrePoint }),
    ...(province !== undefined && { province }),
    ...((direction === "positive" || direction === "negative" || direction === "both") && {
      directionRoad: direction,
    }),
    ...(imageUrl !== undefined && { imageUrl }),
  };
}

/** Every camera device in the document's device publications. */
export function parseDatexCameraDevices(doc: XmlObject): DatexCameraDevice[] {
  return datexPublications(doc)
    .filter(isDevicePublication)
    .flatMap((p) => localChildren(p.body, "device"))
    .map(device)
    .filter((d): d is DatexCameraDevice => d !== undefined);
}
