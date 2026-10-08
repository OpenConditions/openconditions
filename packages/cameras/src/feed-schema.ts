import {
  type CatalogFeed,
  feedBaseShape,
  fieldRef,
  layoutBlockSchema,
  mapped,
} from "@openconditions/ingest-framework";
import { COMPASS_POINTS } from "@openconditions/model";
import { z } from "zod";
import { CAMERA_TYPES, type CameraStatus, IMAGE_REDISTRIBUTIONS, STREAM_TYPES } from "./camera.js";
import { ENCODED_SEPARATOR } from "./records.js";

const cameraType = z.enum(CAMERA_TYPES);

/** The camera statuses a publisher's flag may state. */
const FLAG_STATUSES = ["online", "offline", "unknown"] as const satisfies readonly CameraStatus[];

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST = `${LABEL}(?:\\.${LABEL})+`;
const PATH_SEGMENT = "[A-Za-z0-9._~%-]+";

/**
 * One host a feed's stills are fetched from: an exact host
 * (`weathercam.digitraffic.fi`), every subdomain of a domain
 * (`*.thb.gov.tw`), or a host and a path prefix ending in `/`
 * (`s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/`). Lower case, no scheme,
 * no port. `imageHostIssue` holds the rules a pattern cannot say.
 */
export const IMAGE_HOST_ENTRY = new RegExp(
  `^(?:\\*\\.${HOST}|${HOST}(?:/(?:${PATH_SEGMENT}/)+)?)$`,
);

/*
 * The rules below are the image proxy's: OpenMapX admits a still only from a
 * host its source declares, and refuses (and drops from the source) an entry
 * its `parseMediaHostEntry` in
 * `packages/integration-framework/src/media-hosts.ts` would refuse. The two
 * repositories share no code, so the lists are copies: a change to one is
 * made to the other.
 */

/**
 * Domains under which anyone can rent a subdomain or a path (cloud storage,
 * CDNs, app hosting). A wildcard over one, or one of their hosts without a
 * path, would admit images any of their customers serve; only an exact host
 * with a path prefix (an S3 regional endpoint's bucket) may name them.
 */
const MULTI_TENANT_DOMAINS = [
  "amazonaws.com",
  "cloudfront.net",
  "googleusercontent.com",
  "storage.googleapis.com",
  "blob.core.windows.net",
  "azurewebsites.net",
  "appspot.com",
  "herokuapp.com",
  "github.io",
  "r2.dev",
  "workers.dev",
  "pages.dev",
  "netlify.app",
  "vercel.app",
];
/** Second-level public suffixes under a country code (`co.uk`, `gov.tw`): a wildcard over one spans unrelated registrants. */
const COUNTRY_SECOND_LEVEL = /^(?:co|com|net|org|gov|ac|edu)\.[a-z]{2}$/;
/** A last label a URL parser reads as an IPv4 address (`127.1`, `cam.0x7f`); no public suffix is numeric. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
const isMultiTenant = (host: string) =>
  MULTI_TENANT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * Why an image host entry the pattern accepts is still refused, or
 * undefined: an IP literal or a `localhost` name; a wildcard over a country's
 * public suffix or a shared hosting domain; a shared hosting host without a
 * path prefix; a path with a dot segment or an encoded separator.
 */
export function imageHostIssue(entry: string): string | undefined {
  const wildcard = entry.startsWith("*.");
  const rest = wildcard ? entry.slice(2) : entry;
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? undefined : rest.slice(slash);
  const last = host.slice(host.lastIndexOf(".") + 1);
  if (NUMERIC_LABEL.test(last) || last === "localhost") {
    return "an image host is a public DNS name, never an IP address or localhost";
  }
  if (wildcard && (COUNTRY_SECOND_LEVEL.test(host) || isMultiTenant(host))) {
    return "no wildcard over a public suffix (*.co.uk) or a shared hosting domain (*.amazonaws.com)";
  }
  if (!wildcard && path === undefined && isMultiTenant(host)) {
    return "a host on a shared hosting domain needs a path prefix (host/bucket/)";
  }
  if (path !== undefined) {
    const segments = path.slice(1, -1).split("/");
    if (ENCODED_SEPARATOR.test(path) || segments.some((s) => s === "." || s === "..")) {
      return "a path prefix has no dot segment or encoded separator";
    }
  }
  return undefined;
}

const imageHost = z
  .string()
  .regex(IMAGE_HOST_ENTRY, "a lower-case host, *.domain, or host/path/ prefix")
  .superRefine((entry, ctx) => {
    const issue = imageHostIssue(entry);
    if (issue !== undefined) ctx.addIssue({ code: "custom", message: issue });
  });

/**
 * How a layout feed's records become cameras. Records sharing a camera id
 * are one camera, each record one of its views; the camera's own fields come
 * from the record of its first view key, so the publisher's row order changes
 * nothing. The camera is named by exactly one of `id` and `groupBy`. Every
 * value is read through a `FieldRef`; value maps hold the closed
 * vocabularies, so the catalogue's JSON Schema lists them.
 */
export const camerasMappingSchema = z.strictObject({
  /** The camera id, one per camera; several fields make a composite id, joined with `:`. */
  id: z.union([fieldRef, z.array(fieldRef).min(2)]).optional(),
  /**
   * For a source with one record per view: the field all of a camera's
   * records share, which is the camera id (a site number, or the part of a
   * view id before its suffix).
   */
  groupBy: fieldRef.optional(),
  /** The view's key within its camera; `0` by default. */
  viewKey: fieldRef.optional(),
  name: fieldRef.optional(),
  /** The language of the source's texts (BCP 47). */
  lang: z.string().min(2),
  type: z.union([
    cameraType,
    z.strictObject({
      field: fieldRef,
      map: z.record(z.string(), cameraType),
      /** The type of a camera the map does not name; `other` without it. */
      default: cameraType.optional(),
    }),
  ]),
  description: fieldRef.optional(),
  /** The road the camera stands on, by its number. */
  road: fieldRef.optional(),
  viewName: fieldRef.optional(),
  /** A compass word the publisher gives the view: where it looks, or the road's travel direction. */
  direction: mapped(COMPASS_POINTS).optional(),
  /** Where the view looks, in degrees from north: only a true camera bearing. */
  bearing: fieldRef.optional(),
  imageUrl: fieldRef.optional(),
  thumbnailUrl: fieldRef.optional(),
  streamUrl: fieldRef.optional(),
  streamType: z.enum(STREAM_TYPES).optional(),
  /**
   * The publisher's flag of whether the view delivers images; `unknown` for
   * a value it does not map. A flag says online or offline, never stale:
   * only an image time older than the camera's refresh says that.
   */
  status: mapped(FLAG_STATUSES).optional(),
  /** How often the image is renewed: seconds, or a field in seconds or minutes. */
  refreshSec: z
    .union([z.number().positive(), z.strictObject({ field: fieldRef, unit: z.enum(["s", "min"]) })])
    .optional(),
  /** When the image was taken: an ISO time with its offset, or epoch seconds or milliseconds. */
  imageAt: z
    .strictObject({ field: fieldRef, format: z.enum(["iso", "epoch-s", "epoch-ms"]) })
    .optional(),
  /** The publisher's page of the camera. */
  detailUrl: fieldRef.optional(),
  /**
   * What the images' licence allows. Unlike the rest of the mapping, every
   * format reads it: a layout feed must state it, and a format with its own
   * parser takes it over its publisher's terms where the feed gives it.
   */
  imageRedistribution: z.enum(IMAGE_REDISTRIBUTIONS),
});

export type CamerasMapping = z.infer<typeof camerasMappingSchema>;

/** The mapping's fields, which only the layout formats read. */
export const CAMERAS_MAPPING_FIELDS = Object.keys(camerasMappingSchema.shape);

/**
 * A camera feed's own block: the hosts its stills are fetched from, and for
 * the generic layouts the mapping, whose fields the domain's lint requires
 * there and refuses elsewhere (the feed shape cannot require a field for
 * some formats only). `imageRedistribution` is read by every format: a
 * format with its own parser reads its publisher's image terms, and a feed
 * whose system's terms differ says so here.
 */
export const camerasBlockSchema = z.strictObject({
  /**
   * Every host the feed's still images are fetched from: the image proxy
   * admits exactly these, and a still on any other host is dropped. A feed
   * whose images are not proxied declares none.
   */
  imageHosts: z.array(imageHost).min(1).optional(),
  ...camerasMappingSchema.partial().shape,
});

export type CamerasBlock = z.infer<typeof camerasBlockSchema>;

/**
 * The mapping a `cameras` block writes, checked whole: what a layout feed is
 * read through. Its issues are what the block's own schema cannot say: a
 * missing field, the camera named twice or not at all, and a still read
 * without the hosts the image proxy may fetch it from.
 */
export function readMapping(
  block: CamerasBlock,
): { mapping: CamerasMapping; issues: [] } | { mapping?: undefined; issues: string[] } {
  const { imageHosts, ...fields } = block;
  const parsed = camerasMappingSchema.safeParse(fields);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `cameras mapping: ${issue.path.join(".")} is required`);
  if (fields.id !== undefined && fields.groupBy !== undefined) {
    issues.push("cameras mapping: id and groupBy both name the camera; write one");
  } else if (fields.id === undefined && fields.groupBy === undefined) {
    issues.push("cameras mapping: id or groupBy is required");
  }
  for (const key of ["imageUrl", "thumbnailUrl"] as const) {
    if (fields[key] !== undefined && imageHosts === undefined) {
      issues.push(`cameras mapping: ${key} needs the feed's imageHosts`);
    }
  }
  if (!parsed.success || issues.length > 0) return { issues };
  return { mapping: parsed.data, issues: [] };
}

/**
 * The fields a camera feed adds to the base feed: for the generic layouts
 * (`geojson`, `json`, `csv`), how the payload is cut into records; and the
 * `cameras` block.
 */
const camerasFeedExtension = {
  layout: layoutBlockSchema.optional(),
  cameras: camerasBlockSchema.optional(),
} as const;

export type CamerasFeedExtension = z.infer<z.ZodObject<typeof camerasFeedExtension>>;

/**
 * Raw per-field shape of a camera feed: the base shape plus the camera
 * fields. The catalogue builds `.strict()` region-file schemas from it.
 */
export const camerasFeedShape = { ...feedBaseShape, ...camerasFeedExtension } as const;

/** A loaded camera feed: the catalogue feed plus the camera fields. */
export type CamerasCatalogFeed = CatalogFeed & CamerasFeedExtension;
