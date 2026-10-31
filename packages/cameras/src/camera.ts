import type { ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import {
  type DirectionRef,
  type ExternalId,
  type IMAGE_CATEGORIES,
  type LIFECYCLES,
  type LinearRef,
  type LocalizedText,
  observationId,
  type RoadRef,
} from "@openconditions/model";
import type { CAMERA_STATUSES } from "@openconditions/model-roads";
import {
  type CamerasFeed,
  cameraFeatureId,
  clean,
  ENCODED_SEPARATOR,
  freshness,
  pointLocation,
  provenance,
  UNLOCATED,
  urlOf,
  utcInstant,
} from "./records.js";

/** The model's camera types. */
export const CAMERA_TYPES = ["traffic", "landscape", "city", "weather", "beach", "other"] as const;
export const STREAM_TYPES = ["hls", "rtsp", "mjpeg", "webrtc", "mp4"] as const;
export const MOUNTINGS = [
  "gantry",
  "pole",
  "bridge",
  "vehicle",
  "wall",
  "ceiling",
  "building",
  "doorbell",
  "unknown",
] as const;
/** What a camera's image licence allows: republish the image, or only link to it. */
export const IMAGE_REDISTRIBUTIONS = ["allowed", "link_only", "unknown"] as const;

export type CameraType = (typeof CAMERA_TYPES)[number];
export type CameraStatus = (typeof CAMERA_STATUSES)[number];
export type StreamType = (typeof STREAM_TYPES)[number];
export type Mounting = (typeof MOUNTINGS)[number];
export type ImageRedistribution = (typeof IMAGE_REDISTRIBUTIONS)[number];

/** One view of a camera: a fixed direction, or a preset of a movable camera. */
export interface ViewInput {
  /** The publisher's view, preset or image id; `0` for a camera with one view. */
  key: string;
  name?: LocalizedText[];
  /** Where the camera looks, in degrees from north; only for a true camera bearing. */
  bearingDeg?: number;
  /** A road's travel direction or a compass word the publisher gives the view. */
  direction?: DirectionRef;
  road?: RoadRef;
}

/** The administrative areas a publisher places a camera in; `country` is ISO 3166-1 alpha-2. */
export interface AdminInput {
  country: string;
  /** An ISO 3166-2 code or the publisher's own name of the region. */
  subdivision?: string;
  municipality?: string;
}

/** A photo of the camera's site, as opposed to its live image. */
export interface SiteImageInput {
  url: string;
  category: (typeof IMAGE_CATEGORIES)[number];
  thumbnail?: string;
}

export interface CameraInput {
  /** The publisher's own id of the camera. */
  cameraId: string;
  /** `[lon, lat]`. */
  point: readonly [number, number];
  /** `derived` where the point was computed (a way's centre, a line's vertex mean). */
  geometryOrigin?: "source" | "derived";
  names: LocalizedText[];
  type: CameraType;
  description?: LocalizedText[];
  road?: RoadRef;
  /** The camera's own facing along its road, where the publisher gives one for the whole camera. */
  direction?: DirectionRef;
  /** The camera's position along its road in the publisher's own linear referencing. */
  linear?: LinearRef;
  admin?: AdminInput;
  /** Where the camera is, in the publisher's words. */
  areaDescription?: LocalizedText[];
  elevationM?: number;
  /** Codes of the publisher's location systems (a road link, a road-register id). */
  external?: { system: string; code: string }[];
  images?: SiteImageInput[];
  operator?: LocalizedText[];
  /** The system that publishes the camera, where the feed relays several. */
  provider?: string;
  /**
   * Who issued `cameraId`: the feed (default), or `<feedId>/<upstream>` for a
   * feed that relays several systems, so two of them may still link.
   */
  providerAuthority?: string;
  /** False when the camera carries no `provider` id: its source's ids are external ids already. */
  providerId?: false;
  /** Ids beside the provider id that linking matches on (`osm:node`). */
  externalIds?: ExternalId[];
  /** The publisher's page of the camera. */
  detailUrl?: string;
  playerEmbedUrl?: string;
  /** How often the publisher renews the image, in seconds. */
  refreshSec?: number;
  ptz?: boolean;
  mounting?: Mounting;
  imageRedistribution: ImageRedistribution;
  lifecycle?: (typeof LIFECYCLES)[number];
  /** At least one; a camera given none has the one view `0`. */
  views: ViewInput[];
  /** The publisher the feed took the camera from, credited with it. */
  upstream?: string;
}

/**
 * What a feed's image licence allows: the feed's own word where its
 * `cameras` block gives one (one publisher's platform may serve systems
 * whose terms differ), else what the format reads its publisher's terms as.
 */
export function imageRedistributionOf(
  feed: CamerasFeed,
  publisherTerms: ImageRedistribution,
): ImageRedistribution {
  return feed.cameras?.imageRedistribution ?? publisherTerms;
}

/** What the drafts take from their parse: the fetch time, and the output that counts what they drop. */
export interface DraftContext {
  fetchedAt: string;
  out: Pick<ParseOutput, "rejected">;
}

/** A view key as a component key takes it: `#` separates a record from its component, so it is `_`. */
export const viewKey = (key: string): string => key.replace(/#/g, "_");

const texts = (list: LocalizedText[] | undefined): LocalizedText[] | undefined => {
  const kept = (list ?? []).flatMap((t) => {
    const text = clean(t.text);
    return text === undefined ? [] : [{ ...t, text }];
  });
  return kept.length === 0 ? undefined : kept;
};

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/**
 * What every view carries of its camera: the publisher's page and its image
 * terms. A canonical camera lists each member's views under the survivor, so
 * a view must bring its own publisher's link and terms with it.
 */
interface ViewCamera {
  detailUrl: string | undefined;
  imageRedistribution: ImageRedistribution;
}

function viewComponent(view: ViewInput, camera: ViewCamera): Record<string, unknown> {
  const bearing =
    view.bearingDeg !== undefined && Number.isFinite(view.bearingDeg)
      ? ((view.bearingDeg % 360) + 360) % 360
      : undefined;
  return {
    key: viewKey(view.key),
    kind: "camera_view",
    ...optional("name", texts(view.name)),
    details: {
      kind: "camera_view",
      v: 1,
      ...optional("bearingDeg", bearing),
      ...optional("direction", view.direction),
      ...optional("road", view.road),
      ...optional("detailUrl", camera.detailUrl),
      imageRedistribution: camera.imageRedistribution,
    },
  };
}

/** The admin areas the model can hold: a country of two capital letters, with the names given. */
function adminOf(input: AdminInput | undefined): Record<string, string> | undefined {
  const country = clean(input?.country)?.toUpperCase();
  if (input === undefined || country === undefined || !/^[A-Z]{2}$/.test(country)) return undefined;
  return {
    country,
    ...optional("subdivision", clean(input.subdivision)),
    ...optional("municipality", clean(input.municipality)),
  };
}

/**
 * The site images with an http(s) URL, each once; a thumbnail that is no URL
 * is left off. A feed that declares `imageHosts` names every host its images
 * may be fetched from, as it does for its stills (`imageReading`): an image
 * or thumbnail elsewhere is dropped and counted as rejected.
 */
function imagesOf(
  feed: CamerasFeed,
  ctx: DraftContext,
  list: SiteImageInput[] | undefined,
): Record<string, string>[] | undefined {
  const hosts = feed.cameras?.imageHosts ?? [];
  const admitted = (value: string | undefined): string | undefined => {
    const url = urlOf(value);
    if (url === undefined || hosts.length === 0 || matchesImageHost(url, hosts)) return url;
    ctx.out.rejected = (ctx.out.rejected ?? 0) + 1;
    return undefined;
  };
  const seen = new Set<string>();
  const kept = (list ?? []).flatMap((image) => {
    const url = admitted(image.url);
    if (url === undefined || seen.has(url)) return [];
    seen.add(url);
    return [{ url, category: image.category, ...optional("thumbnail", admitted(image.thumbnail)) }];
  });
  return kept.length === 0 ? undefined : kept;
}

/** The location fields of a camera beside its point and road. */
function placeOf(input: CameraInput): Record<string, unknown> {
  const external = (input.external ?? []).flatMap((e) => {
    const system = clean(e.system);
    const code = clean(e.code);
    return system === undefined || code === undefined ? [] : [{ system, code }];
  });
  const linear =
    input.linear !== undefined &&
    clean(input.linear.ref) !== undefined &&
    Number.isFinite(input.linear.from)
      ? input.linear
      : undefined;
  const elevationM =
    input.elevationM !== undefined && Number.isFinite(input.elevationM)
      ? input.elevationM
      : undefined;
  return {
    ...optional("direction", input.direction),
    ...optional("linear", linear),
    ...optional("admin", adminOf(input.admin)),
    ...optional("areaDescription", texts(input.areaDescription)),
    ...optional("elevationM", elevationM),
    ...(external.length === 0 ? {} : { external }),
  };
}

/**
 * A `camera` feature with its views as `camera_view` components. It carries
 * its provider id unless the input says otherwise, so two cameras of one
 * source never link; a camera without a stated lifecycle is operational.
 */
export function cameraDraft(feed: CamerasFeed, ctx: DraftContext, input: CameraInput): RecordDraft {
  const views = input.views.length === 0 ? [{ key: "0" }] : input.views;
  const detailUrl = urlOf(input.detailUrl);
  const shared = { detailUrl, imageRedistribution: input.imageRedistribution };
  // Component keys are unique within a feature: the first view of a key stands.
  const byKey = new Map<string, Record<string, unknown>>();
  for (const view of views) {
    const component = viewComponent(view, shared);
    const key = component["key"] as string;
    if (!byKey.has(key)) byKey.set(key, component);
  }
  const components = [...byKey.values()];
  const externalIds = [
    ...(input.providerId === false
      ? []
      : [
          {
            scheme: "provider",
            id: input.cameraId,
            authority: input.providerAuthority ?? feed.id,
          },
        ]),
    ...(input.externalIds ?? []).map((e) => ({ ...e })),
  ];
  const operator = texts(input.operator);
  const refreshSec =
    input.refreshSec !== undefined && Number.isFinite(input.refreshSec) && input.refreshSec > 0
      ? input.refreshSec
      : undefined;
  return {
    id: cameraFeatureId(feed, input.cameraId),
    class: "feature",
    kind: "camera",
    type: input.type,
    temporality: "static",
    lifecycle: input.lifecycle ?? "operational",
    location: {
      ...pointLocation(input.point, input.geometryOrigin),
      ...(input.road === undefined ? {} : { roads: [input.road] }),
      ...placeOf(input),
    },
    provenance: provenance(feed, input.cameraId, clean(input.upstream)),
    freshness: freshness(feed, ctx.fetchedAt),
    ...(externalIds.length === 0 ? {} : { externalIds }),
    ...optional("name", texts(input.names)),
    ...optional("description", texts(input.description)),
    ...(operator === undefined ? {} : { operator: { role: "operator", name: operator } }),
    ...optional("images", imagesOf(feed, ctx, input.images)),
    components,
    details: {
      kind: "camera",
      v: 1,
      ...optional("refreshSec", refreshSec),
      ...optional("provider", clean(input.provider)),
      ...optional("detailUrl", detailUrl),
      ...optional("playerEmbedUrl", urlOf(input.playerEmbedUrl)),
      ...optional("ptz", input.ptz),
      ...optional("mounting", input.mounting),
      imageRedistribution: input.imageRedistribution,
    },
  };
}

/**
 * Whether `url` is an http(s) URL on one of `hosts`: an exact host, a
 * subdomain of a `*.` wildcard (not the domain itself), or a host whose
 * path starts with the entry's path prefix and carries no encoded separator
 * below it. Host names compare without case. A URL with credentials or on a
 * port other than its scheme's default never matches: an entry names a
 * host's web server, not every service on it.
 *
 * OpenMapX's image proxy admits a still by the same rule
 * (`packages/integration-framework/src/media-hosts.ts`, `matchesMediaHost`);
 * the two repositories share no code, so a change there is copied here, or a
 * still this keeps is one the proxy refuses.
 */
export function matchesImageHost(url: string, hosts: readonly string[]): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username !== "" || u.password !== "") return false;
  // The URL parser drops a scheme's default port, so any port left is another.
  if (u.port !== "") return false;
  const host = u.hostname.toLowerCase();
  return hosts.some((entry) => {
    const slash = entry.indexOf("/");
    const entryHost = (slash < 0 ? entry : entry.slice(0, slash)).toLowerCase();
    const path = slash < 0 ? undefined : entry.slice(slash);
    const hostMatches = entryHost.startsWith("*.")
      ? host.endsWith(entryHost.slice(1))
      : host === entryHost;
    if (!hostMatches) return false;
    if (path === undefined) return true;
    return u.pathname.startsWith(path) && !ENCODED_SEPARATOR.test(u.pathname);
  });
}

export interface ImageReadingInput {
  cameraId: string;
  viewKey: string;
  status: CameraStatus;
  /** The publisher's own words on the camera's state. */
  statusText?: readonly { lang: string; text: string }[];
  imageUrl?: string;
  thumbnailUrl?: string;
  streamUrl?: string;
  streamType?: StreamType;
  /** When the publisher took the image, a UTC instant. */
  imageAt?: string;
  /** The camera's `[lon, lat]`; unlocated without it. */
  point?: readonly [number, number];
  /** The publisher the feed took the camera from, credited with the reading. */
  upstream?: string;
}

/** Protocols a stream may load over; the browser plays it, nothing proxies it. */
const STREAM_PROTOCOLS = ["http:", "https:", "rtsp:", "rtsps:"];

/**
 * A `camera.image` reading of one view, as of the publisher's image time
 * (held to the fetch), else the fetch. It states no validity: an image
 * reading is written when it changes and holds while its feed polls.
 *
 * A feed that declares `imageHosts` names every host its stills may be
 * fetched from, and the image proxy admits only those: a still or thumbnail
 * elsewhere is dropped and counted as rejected. A feed that declares none
 * keeps its URLs, which a consumer links rather than proxies. A still that is
 * no http(s) URL is dropped and counted the same way. The reading itself is
 * written, so neither is a skipped record, and an address is no enumerated
 * value to count as unknown.
 */
export function imageReading(
  feed: CamerasFeed,
  ctx: DraftContext,
  input: ImageReadingInput,
): RecordDraft {
  const hosts = feed.cameras?.imageHosts ?? [];
  const still = (value: string | undefined): string | undefined => {
    if (clean(value) === undefined) return undefined;
    const url = urlOf(value);
    if (url !== undefined && (hosts.length === 0 || matchesImageHost(url, hosts))) return url;
    ctx.out.rejected = (ctx.out.rejected ?? 0) + 1;
    return undefined;
  };
  const imageUrl = still(input.imageUrl);
  const thumbnailUrl = still(input.thumbnailUrl);
  const streamUrl = urlOf(input.streamUrl, STREAM_PROTOCOLS);
  const fetched = Date.parse(ctx.fetchedAt);
  const stated = input.imageAt === undefined ? Number.NaN : Date.parse(input.imageAt);
  // An image cannot be newer than the fetch that read of it: a later time is the fetch's.
  const held = Number.isFinite(stated) ? Math.min(stated, fetched) : undefined;
  const imageAt = held === undefined ? undefined : utcInstant(new Date(held));
  const at = held ?? fetched;
  const draft = {
    class: "observation",
    kind: "observation",
    property: "camera.image",
    temporality: "live",
    location: input.point === undefined ? { ...UNLOCATED } : pointLocation(input.point),
    provenance: provenance(feed, input.cameraId, clean(input.upstream)),
    freshness: freshness(feed, ctx.fetchedAt),
    subject: {
      kind: "feature",
      featureId: cameraFeatureId(feed, input.cameraId),
      componentKey: viewKey(input.viewKey),
    },
    result: {
      type: "structured",
      schema: "camera_image",
      v: 1,
      value: {
        v: 1,
        status: input.status,
        ...(input.statusText === undefined || input.statusText.length === 0
          ? {}
          : { statusText: input.statusText }),
        ...optional("imageUrl", imageUrl),
        ...optional("imageAt", imageAt),
        ...optional("thumbnailUrl", thumbnailUrl),
        ...optional("streamUrl", streamUrl),
        ...(streamUrl === undefined ? {} : optional("streamType", input.streamType)),
      },
    },
    phenomenonTime: { instant: utcInstant(new Date(at)) },
    aggregation: "instantaneous",
  };
  return { id: observationId(feed.id, draft as never), ...draft };
}
