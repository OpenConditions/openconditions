import {
  type Catalog,
  type CatalogFeed,
  type CredentialField,
  feedCredentialNames,
  isSettingsGroup,
} from "@openconditions/ingest-framework";

/**
 * What the credential artefacts are generated from: the polled feeds, the
 * shared groups, and the readers of a group of settings that are no feed
 * (the road-graph import reads `@overpass.url`), by group.
 */
export type CredentialCatalog = Pick<Catalog, "feeds" | "credentials"> & {
  settingReaders?: Readonly<Record<string, readonly string[]>>;
};

/** One credential env var and the field that documents it. */
interface CredentialVar {
  env: string;
  field: CredentialField | undefined;
  /** The shared group it belongs to; undefined for a feed's own field. */
  group?: string;
}

/** The shared group of a ref (`@group.field`) and its field name; undefined for a feed field. */
function sharedRef(ref: string): { group: string; field: string } | undefined {
  if (!ref.startsWith("@")) return undefined;
  const [group = "", field = ""] = ref.slice(1).split(".");
  return { group, field };
}

/** Every credential a feed reads, in declaration order, with the field that documents it. */
function feedVars(feed: CatalogFeed, catalog: CredentialCatalog): CredentialVar[] {
  return feedCredentialNames(feed).map(({ ref, env }) => {
    const shared = sharedRef(ref);
    if (shared) {
      return {
        env,
        field: catalog.credentials.groups[shared.group]?.[shared.field],
        group: shared.group,
      };
    }
    return { env, field: feed.credentials?.[ref] };
  });
}

/** The feed a credential belongs to: a catalogue child's parent. */
function ownerId(feed: CatalogFeed): string {
  return feed.parentSourceId ?? feed.id;
}

/** The keyed feeds with their credentials; the children of one parent, which share its names, once. */
function keyedFeeds(catalog: CredentialCatalog): { feed: CatalogFeed; vars: CredentialVar[] }[] {
  const out: { feed: CatalogFeed; vars: CredentialVar[] }[] = [];
  const seen = new Set<string>();
  for (const feed of catalog.feeds) {
    const vars = feedVars(feed, catalog);
    if (vars.length === 0 || seen.has(ownerId(feed))) continue;
    seen.add(ownerId(feed));
    out.push({ feed, vars });
  }
  return out;
}

/** A var's own lines: its default, when it has one, then `VAR=`. */
function varLines(v: CredentialVar): string[] {
  return [
    ...(v.field?.default === undefined ? [] : [`# Default: ${v.field.default}`]),
    `${v.env}=`,
  ];
}

/**
 * Whether a var is a setting, a field of a group of settings (see
 * `isSettingsGroup`): plain configuration with a default, not a secret.
 */
function isSetting(catalog: CredentialCatalog, v: CredentialVar): boolean {
  return v.group !== undefined && isSettingsGroup(catalog.credentials.groups[v.group] ?? {});
}

/** The comment lines of a field's setup guide. */
function guideLines(field: CredentialField | undefined): string[] {
  const setup = field?.setup;
  const lines: string[] = [];
  if (setup?.url) lines.push(`# ${setup.urlLabel ?? "Get credentials"}: ${setup.url}`);
  if (setup?.notes) lines.push(`# ${setup.notes}`);
  return lines;
}

/**
 * The `.env.example` credential section: one commented block per shared group
 * the feeds use, then one per keyed feed with the vars it adds.
 *
 * Each var is emitted once. `.env` parsers are last-occurrence-wins, so a
 * second blank `VAR=` line would silently null out a value an operator filled
 * in under an earlier block.
 */
export function envExampleFor(catalog: CredentialCatalog): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  const keyed = keyedFeeds(catalog);

  const groups = new Map<string, { users: string[]; vars: CredentialVar[] }>();
  for (const { feed, vars } of keyed) {
    for (const v of vars) {
      if (v.group === undefined) continue;
      const entry = groups.get(v.group) ?? { users: [], vars: [] };
      if (!entry.users.includes(ownerId(feed))) entry.users.push(ownerId(feed));
      if (!entry.vars.some((known) => known.env === v.env)) entry.vars.push(v);
      groups.set(v.group, entry);
    }
  }
  for (const [group, { users, vars }] of groups) {
    const readers = [...users, ...(catalog.settingReaders?.[group] ?? [])];
    const lines = [
      `# Shared: ${group} (${readers.join(", ")})`,
      ...guideLines(vars.find((v) => v.field?.setup)?.field),
    ];
    for (const v of vars) {
      seen.add(v.env);
      lines.push(...varLines(v));
    }
    blocks.push(lines.join("\n"));
  }

  for (const { feed, vars } of keyed) {
    const own = vars.filter((v) => !seen.has(v.env));
    if (own.length === 0) continue;
    const lines = [
      `# ${feed.name} (${ownerId(feed)})`,
      ...guideLines(own.find((v) => v.field?.setup)?.field),
    ];
    for (const v of own) {
      seen.add(v.env);
      lines.push(...varLines(v));
    }
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** A field the ingest service itself reads, not one a feed declares. */
interface ServiceField {
  title: string;
  description: string;
  /** A vault secret: mounted as a file, read through `<KEY>_FILE`, never defaulted. */
  secret?: true;
  /** The value OpenMapX renders when the operator sets nothing; absent = unset. */
  default?: string;
}

/**
 * The ingest service's own configuration, hand-written here and written into
 * `service.json` beside the fields generated from the catalogue. Under
 * OpenMapX a community service's `container.environment` reaches the
 * container verbatim (a `${VAR}` stays literal), so everything an operator
 * sets is one of these: a setting with its default, or a vault secret.
 * An empty default renders the variable empty, which every reader takes as
 * its built-in default.
 */
export const SERVICE_FIELDS: Readonly<Record<string, ServiceField>> = {
  DATABASE_URL: {
    title: "Database URL",
    description:
      "Required. PostgreSQL/PostGIS connection URL of the shared OpenMapX database, e.g. postgresql://postgres:<POSTGRES_PASSWORD>@postgis:5432/openmapx. The service refuses to start without it.",
    secret: true,
  },
  OPENCONDITIONS_OPERATOR_TOKEN: {
    title: "Operator token",
    description:
      "Bearer token granting the operator scope (restricted sources, no rate limit); at least 32 characters, or the service fails boot. Must equal OpenMapX's own OPENCONDITIONS_OPERATOR_TOKEN, which app-api and the data-manager send. Unset, OpenMapX reads in the public scope and serves none of the restricted sources, those whose licence or terms keep their records from public redistribution: Tankerkönig (DE), E-Control (AT) and OpenStreetMap fuel stations, OpenStreetMap, BNLS (FR) and Mobidrom Park+Ride (DE) car parks, and OpenStreetMap, Open Charge Map and NAP Slovenija charge points.",
    secret: true,
  },
  SEGMENT_REGIONS: {
    title: "Road graph regions",
    description:
      "Complete JSON array of {id,bbox,tz,pbfUrls?,highwayClasses?}. Used by import, binding coverage and speed profiles. Unset or [] means no configured graph coverage. See graph-binding documentation.",
    default: "",
  },
  SEGMENT_HIGHWAY_CLASSES: {
    title: "Road graph highway classes",
    description:
      "Comma-separated OSM highway values the road-graph import keeps. Empty: the built-in set.",
    default: "",
  },
  BIND_ENABLED: {
    title: "Bind records to the road graph",
    description: '"false" turns binding records to road-graph segments off. Empty: on.',
    default: "",
  },
  BIND_MAX_OFFSET_M: {
    title: "Binding max offset (m)",
    description:
      "How far a record's geometry may lie from a segment and still bind to it. Empty: the built-in default.",
    default: "",
  },
  BIND_CONCURRENCY: {
    title: "Binding concurrency",
    description: "Records bound in parallel. Empty: the built-in default.",
    default: "",
  },
  OPENLR_RESOLVER_URL: {
    title: "OpenLR resolver URL",
    description:
      "URL of the OpenLR map-match resolver service. Empty: observations that carry only OpenLR (no coordinates) are dropped rather than resolved.",
    default: "",
  },
  OPENCONDITIONS_FETCH_TIMEOUT_MS: {
    title: "Feed fetch timeout (ms)",
    description: "Timeout of every feed fetch. Empty: 60000.",
    default: "",
  },
  OPENCONDITIONS_EGRESS_ALLOWED_HOSTS: {
    title: "Egress allowed private hosts",
    description:
      "Comma-separated hostnames the egress guard lets the service fetch although they resolve to private addresses, e.g. overpass for a self-hosted Overpass on the compose network. Empty: none.",
    default: "",
  },
  OPENCONDITIONS_DOWNLOAD_MAX_BYTES: {
    title: "Artifact download cap (bytes)",
    description: "Largest artifact (PBF extract) a download streams. Empty: 8 GiB.",
    default: "",
  },
  OPENCONDITIONS_DOWNLOAD_TIMEOUT_MS: {
    title: "Artifact download timeout (ms)",
    description: "Overall timeout of an artifact download. Empty: 30 minutes.",
    default: "",
  },
  RATE_LIMIT_MAX: {
    title: "Rate limit: requests per window",
    description: "Requests one client may make per rate-limit window.",
    default: "120",
  },
  RATE_LIMIT_WINDOW_MS: {
    title: "Rate limit window (ms)",
    description: "Length of the rate-limit window.",
    default: "60000",
  },
  STREAM_MAX_CONNECTIONS: {
    title: "Live streams open at once",
    description: "Server-sent-event streams the service holds open at once.",
    default: "100",
  },
  TRUST_PROXY_CIDRS: {
    title: "Trusted proxy ranges",
    description:
      "Immediate reverse-proxy address ranges to trust for client IPs; only one proxy hop is accepted.",
    default: "loopback,linklocal,uniquelocal",
  },
  OPENCONDITIONS_RAW_MAX_BYTES: {
    title: "Raw archive cap (bytes)",
    description: "Cap on the raw payload archive's stored bytes; 0 = no cap. Empty: 10 GiB.",
    default: "",
  },
  OPENCONDITIONS_HISTORY_DAYS: {
    title: "Record history (days)",
    description:
      "How long a tombstoned record and its revisions stay for the history API. Empty: 90.",
    default: "",
  },
  OPENCONDITIONS_ON_DEMAND_DEADLINE_MS: {
    title: "On-demand read deadline (ms)",
    description:
      "How long a read waits for its on-demand fetches before it answers from storage. Empty: 3000.",
    default: "",
  },
  OPENCONDITIONS_FEEDS_REMOTE_URL: {
    title: "Remote feed bundle URL",
    description:
      'URL of a remote feed bundle ({ "files": { "<domain>/<region>": <region file>, "credentials": <credentials file> } }, e.g. a published atlas/<domain>.json) to pull feeds from: the way to run a custom catalogue here, whose feeds add to or override the baked-in feeds by id. Only used when remote-pull is enabled.',
  },
  OPENCONDITIONS_FEEDS_REMOTE_ENABLED: {
    title: "Enable remote feed-pull",
    description:
      'Set to "true" to opt the instance into remote-pull (default off). The bundle is checked like the baked catalogue and every URL is egress-guarded; a snapshot is kept on the service\'s volume so the instance survives the remote being down.',
  },
  OPENCONDITIONS_INSTANCE_ID: {
    title: "Instance id",
    description:
      "This instance's stable id, the namespace of every record it originates and its name to federation peers: lower-case letters, digits, dots and dashes, e.g. maps.example.org. Set it before federating, and to the same value as the contributions API's. Empty: local.",
    default: "",
  },
  OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS: {
    title: "Archive nights kept",
    description: "Nights of dated files the nightly archive keeps; 0 keeps every night. Empty: 30.",
    default: "",
  },
  ARCHIVE_CRON: {
    title: "Archive schedule",
    description: 'Cron of the nightly archive build (UTC); "off" disables it. Empty: 30 3 * * *.',
    default: "",
  },
  SEGMENT_PROFILE_CRON: {
    title: "Segment profile schedule",
    description:
      'Cron of the weekly segment speed-profile derivation (UTC); "off" disables it. Empty: 30 3 * * 1.',
    default: "",
  },
  SEGMENT_REBUILD_CRON: {
    title: "Segment rebuild schedule",
    description:
      'Cron of the weekly road-graph segment rebuild (UTC); "off" disables it. Empty: 0 4 * * 1.',
    default: "",
  },
  OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO: {
    title: "Shrink tripwire ratio",
    description:
      "An event feed's complete snapshot whose count does not exceed this share of its last published count is skipped as a likely partial parse, e.g. 0.1. Empty or 0: only a drop to zero is skipped.",
    default: "",
  },
  OPENCONDITIONS_MAX_FEED_BYTES: {
    title: "Feed response cap (bytes)",
    description: "Largest feed response, compressed or decompressed. Empty: 256 MiB.",
    default: "",
  },
  OPENCONDITIONS_MAX_REDIRECTS: {
    title: "Feed redirects",
    description: "Redirects a feed fetch follows. Empty: 5.",
    default: "",
  },
  OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL: {
    title: "Readings per poll",
    description: "Cap on the readings one poll may hold; a poll above it fails. Empty: 1000000.",
    default: "",
  },
  OPENCONDITIONS_OSM_MAXSPEED_FALLBACK: {
    title: "OSM maxspeed fallback",
    description:
      '"false" turns off the nightly fallback that fills a sensor without a speed baseline from OpenStreetMap maxspeed tags. Empty: on.',
    default: "",
  },
  OPENCONDITIONS_RAW_ZSTD_LEVEL: {
    title: "Raw archive compression level",
    description: "zstd level of the raw payload archive. Empty: 9.",
    default: "",
  },
  OPENCONDITIONS_RAW_HOT_HOURS: {
    title: "Raw archive: hours kept whole",
    description: "Hours every distinct raw payload is kept. Empty: 48.",
    default: "",
  },
  OPENCONDITIONS_RAW_THIN_DAYS_SITUATION: {
    title: "Raw archive: days thinned (situation feeds)",
    description: "Days situation feeds then keep one raw payload an hour. Empty: 14.",
    default: "",
  },
  OPENCONDITIONS_RAW_THIN_DAYS_OBSERVATION: {
    title: "Raw archive: days thinned (flow feeds)",
    description: "Days flow feeds then keep one raw payload an hour. Empty: 7.",
    default: "",
  },
  OPENCONDITIONS_ROLLUP_HOURLY_DAYS: {
    title: "Hourly rollups kept (days)",
    description: "Days hourly reading rollups are kept. Empty: 35.",
    default: "",
  },
  OPENCONDITIONS_ROLLUP_DAILY_DAYS: {
    title: "Daily rollups kept (days)",
    description: "Days daily reading rollups are kept. Empty: 400.",
    default: "",
  },
};

/**
 * The `service.json` configSchema.properties object (admin-panel fields): the
 * service's own fields ({@link SERVICE_FIELDS}), then a feed's credentials,
 * each a secret, and the instance settings (the fields of a group of
 * settings), each plain configuration with its `default`. OpenMapX resolves
 * every non-secret field into the container's environment (its default, else
 * the admin panel, else `SERVICE_<ID>_<KEY>` in its `.env`) and mounts every
 * secret as a file named by `<KEY>_FILE`; those are the only routes a
 * community service's environment has. Throws when a feed's credential takes
 * the name of a service field.
 */
export function configSchemaPropertiesFor(catalog: CredentialCatalog): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(SERVICE_FIELDS)) {
    props[key] = {
      type: "string",
      title: field.title,
      description: field.description,
      ...(field.default === undefined ? {} : { default: field.default }),
      "x-openmapx-secret": field.secret === true,
    };
  }
  for (const { feed, vars } of keyedFeeds(catalog)) {
    for (const v of vars) {
      const { env, field } = v;
      if (SERVICE_FIELDS[env]) {
        throw new Error(
          `${ownerId(feed)} reads ${env}, a field of the service itself: rename the credential`,
        );
      }
      if (props[env]) continue;
      const setting = isSetting(catalog, v);
      props[env] = {
        type: "string",
        title: field?.title ?? `${feed.name} — ${env}`,
        ...(field?.description ? { description: field.description } : {}),
        ...(setting ? { default: field?.default } : {}),
        "x-openmapx-secret": !setting,
        ...(field?.setup ? { "x-openmapx-setup": field.setup } : {}),
      };
    }
  }
  return props;
}

/**
 * `docs/feed-credentials.md`: one row per feed that needs a credential, shared
 * credentials included, then the settings the feeds read (a group of settings'
 * fields), each once, with its default, the name OpenMapX reads it under for
 * the service `serviceId`, and its readers.
 */
export function credentialsDocFor(catalog: CredentialCatalog, serviceId: string): string {
  const openmapxPrefix = `SERVICE_${serviceId.replaceAll("-", "_").toUpperCase()}_`;
  const header = [
    "# Feed credentials",
    "",
    "> Generated by `pnpm gen:credentials`. Do not edit by hand.",
    "",
    "Each variable may instead name a file holding the value: `<VAR>_FILE`. See",
    "[`feeds/README.md`](../feeds/README.md#credentials) for how the names are derived.",
    "",
    `Under OpenMapX each variable is a field of the \`${serviceId}\` service. A credential`,
    "is a secret set in the admin services panel, which OpenMapX mounts as a file named",
    "by `<VAR>_FILE`. A setting is set there too, or in OpenMapX's `.env` under the name",
    "the settings table gives. Settings kept in OpenMapX's `.env` are applied with",
    `\`pnpm openmapx services start ${serviceId}\` (which resets every setting saved only in`,
    "the admin form, so keep all of them in one place). Settings saved in the form are",
    "applied with **Save & Apply**. OpenMapX mounts no directory of the operator's, so",
    "`OPENCONDITIONS_FEEDS_DIR` is not a field there: a custom catalogue comes through",
    "the remote feed bundle (`OPENCONDITIONS_FEEDS_REMOTE_URL`, with",
    '`OPENCONDITIONS_FEEDS_REMOTE_ENABLED` set to "true"), whose snapshot is kept on the',
    "service's volume beside its raw and nightly archives.",
    "",
    "| Feed | Id | Env var(s) | Licence | How to get it |",
    "|---|---|---|---|---|",
  ];
  const rows: string[] = [];
  const settings = new Map<string, { v: CredentialVar; readers: string[] }>();
  for (const { feed, vars } of keyedFeeds(catalog)) {
    const credentials = vars.filter((v) => !isSetting(catalog, v));
    for (const v of vars.filter((s) => isSetting(catalog, s))) {
      const entry = settings.get(v.env) ?? { v, readers: [] };
      entry.readers.push(`\`${ownerId(feed)}\``);
      settings.set(v.env, entry);
    }
    if (credentials.length === 0) continue;
    const names = credentials.map((v) => `\`${v.env}\``).join(", ");
    const setup = credentials.find((v) => v.field?.setup)?.field?.setup;
    const how = setup?.url ? `[${setup.urlLabel ?? "portal"}](${setup.url})` : (setup?.notes ?? "");
    rows.push(`| ${feed.name} | \`${ownerId(feed)}\` | ${names} | ${feed.license} | ${how} |`);
  }
  const settingRows =
    settings.size === 0
      ? []
      : [
          "",
          "## Settings",
          "",
          "Not credentials: where the instance reaches a service. Each has a default.",
          "",
          "| Env var | Under OpenMapX | Default | Read by | What |",
          "|---|---|---|---|---|",
          ...[...settings].map(([env, { v, readers }]) => {
            const others = (catalog.settingReaders?.[v.group ?? ""] ?? []).map((r) => `\`${r}\``);
            return `| \`${env}\` | \`${openmapxPrefix}${env}\` | \`${v.field?.default ?? ""}\` | ${[...readers, ...others].join(", ")} | ${v.field?.description ?? v.field?.title ?? ""} |`;
          }),
        ];
  return `${[...header, ...rows, ...settingRows].join("\n")}\n`;
}
