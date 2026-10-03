import {
  type Catalog,
  type CatalogFeed,
  type CredentialField,
  feedCredentialNames,
} from "@openconditions/ingest-framework";

/** What the credential artefacts are generated from: the polled feeds and the shared groups. */
export type CredentialCatalog = Pick<Catalog, "feeds" | "credentials">;

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
    const lines = [
      `# Shared: ${group} (${users.join(", ")})`,
      ...guideLines(vars.find((v) => v.field?.setup)?.field),
    ];
    for (const v of vars) {
      seen.add(v.env);
      lines.push(`${v.env}=`);
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
      lines.push(`${v.env}=`);
    }
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Non-secret operational settings (not per-feed credentials). Layered feed
 * delivery is configured by these three env vars; they render as plain config
 * fields in the admin panel (no vault, no `*_FILE` path).
 */
const SERVICE_SETTINGS: Record<string, { title: string; description: string }> = {
  OPENCONDITIONS_FEEDS_DIR: {
    title: "Mounted feed catalogue directory",
    description:
      "Directory laid out like the baked catalogue (<domain>/<region>.jsonc region files, optional credentials.jsonc) whose feeds add to or override the baked-in feeds by id, with no rebuild. Unset = no overrides.",
  },
  OPENCONDITIONS_FEEDS_REMOTE_URL: {
    title: "Remote feed bundle URL",
    description:
      'URL of a remote feed bundle ({ "files": { "<domain>/<region>": <region file>, "credentials": <credentials file> } }, e.g. a published atlas/<domain>.json) to pull feeds from. Only used when remote-pull is enabled.',
  },
  OPENCONDITIONS_FEEDS_REMOTE_ENABLED: {
    title: "Enable remote feed-pull",
    description:
      'Set to "true" to opt the instance into remote-pull (default off). The bundle is checked like the baked catalogue and every URL is egress-guarded; a snapshot is kept so the instance survives the remote being down.',
  },
};

/** The `service.json` configSchema.properties object (admin-panel fields). */
export function configSchemaPropertiesFor(catalog: CredentialCatalog): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, { title, description }] of Object.entries(SERVICE_SETTINGS)) {
    props[key] = { type: "string", title, description, "x-openmapx-secret": false };
  }
  for (const { feed, vars } of keyedFeeds(catalog)) {
    for (const { env, field } of vars) {
      if (props[env]) continue;
      props[env] = {
        type: "string",
        title: field?.title ?? `${feed.name} — ${env}`,
        ...(field?.description ? { description: field.description } : {}),
        "x-openmapx-secret": true,
        ...(field?.setup ? { "x-openmapx-setup": field.setup } : {}),
      };
    }
  }
  return props;
}

/** The `docs/feed-credentials.md` table: one row per keyed feed, shared vars included. */
export function credentialsDocFor(catalog: CredentialCatalog): string {
  const header = [
    "# Feed credentials",
    "",
    "> Generated by `pnpm gen:credentials`. Do not edit by hand.",
    "",
    "Each variable may instead name a file holding the value: `<VAR>_FILE`. See",
    "[`feeds/README.md`](../feeds/README.md#credentials) for how the names are derived.",
    "",
    "| Feed | Id | Env var(s) | Licence | How to get it |",
    "|---|---|---|---|---|",
  ];
  const rows = keyedFeeds(catalog).map(({ feed, vars }) => {
    const names = vars.map((v) => `\`${v.env}\``).join(", ");
    const setup = vars.find((v) => v.field?.setup)?.field?.setup;
    const how = setup?.url ? `[${setup.urlLabel ?? "portal"}](${setup.url})` : (setup?.notes ?? "");
    return `| ${feed.name} | \`${ownerId(feed)}\` | ${names} | ${feed.license} | ${how} |`;
  });
  return `${[...header, ...rows].join("\n")}\n`;
}
