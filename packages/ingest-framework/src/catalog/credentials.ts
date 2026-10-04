import { readFileSync } from "node:fs";
import type { CatalogFeed, CredentialField, FeedDefinition } from "./types.js";

/** Where credentials are read from: `process.env` or a test's stand-in. */
export type Env = Record<string, string | undefined>;

/** A field of the feed (`api_key`) or a shared field (`@mobilithek.cert`). */
export type CredentialRef = string;

export interface FeedCredentialName {
  ref: CredentialRef;
  env: string;
  optional: boolean;
  default?: string;
  /** A field of a group of settings (see {@link isSettingsGroup}): a base URL, not a secret. */
  setting?: true;
}

/**
 * A `${ref}` placeholder in a request text. It matches anything between the
 * braces, so an undeclared `${HOME}` is still read as a ref: the lint reports
 * it and filling a template throws on it.
 */
export const CREDENTIAL_PLACEHOLDER = /\$\{([^}]*)\}/g;

function envSegment(s: string): string {
  return s.toUpperCase().replaceAll("-", "_");
}

/** A shared ref, `@group.field`: one dot, both sides named. */
const SHARED_REF = /^@([^.]+)\.([^.]+)$/;

/** The env var that holds a credential: `<OWNER>_<FIELD>`, or `<GROUP>_<FIELD>` for a shared ref.
 *  Throws on a shared ref that is not `@group.field`. */
export function credentialEnvName(ownerId: string, ref: CredentialRef): string {
  if (ref.startsWith("@")) {
    const match = SHARED_REF.exec(ref);
    if (!match) throw new Error(`${ref} is not a shared credential ref (@group.field)`);
    return `${envSegment(match[1] as string)}_${envSegment(match[2] as string)}`;
  }
  return `${envSegment(ownerId)}_${envSegment(ref)}`;
}

/**
 * Resolve a credential value, supporting the `*_FILE` convention used by
 * file-based secret delivery (Docker `secrets:` mounts at `/run/secrets/<KEY>`).
 * Prefers a non-empty env var; otherwise reads the file named by `<KEY>_FILE`.
 * An empty/whitespace env var falls through to the file, so a blank placeholder
 * never shadows a mounted secret. Returns `undefined` when neither yields a
 * non-empty value.
 */
export function resolveCredential(env: Env, name: string): string | undefined {
  const read = readCredential(env, name);
  // A missing or unreadable secret file is "not set": the feed is skipped.
  return "value" in read ? read.value : undefined;
}

type CredentialRead = { value: string } | { unset: true } | { failure: string };

/** The env var, else the file `<NAME>_FILE` names, or why that file yielded nothing. */
function readCredential(env: Env, name: string): CredentialRead {
  const direct = env[name]?.trim();
  if (direct) return { value: direct };
  const filePath = env[`${name}_FILE`]?.trim();
  if (!filePath) return { unset: true };
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    return { failure: `${name}_FILE (${filePath}) could not be read: ${code}` };
  }
  return contents ? { value: contents } : { failure: `${name}_FILE (${filePath}) is empty` };
}

/**
 * A service secret read like a credential, but strictly: undefined only when
 * neither `<NAME>` nor `<NAME>_FILE` is set. A `<NAME>_FILE` that is set but
 * unreadable or empty throws naming the path and the cause, so a secret the
 * operator did configure never silently counts as absent.
 */
export function strictCredential(env: Env, name: string): string | undefined {
  const read = readCredential(env, name);
  if ("failure" in read) throw new Error(read.failure);
  return "value" in read ? read.value : undefined;
}

/**
 * A secret the service cannot start without (`DATABASE_URL`), read like a
 * credential: the env var, else the file `<NAME>_FILE` names (how OpenMapX
 * mounts a vault secret). Throws naming both when neither is set, and naming
 * the file and the cause when `<NAME>_FILE` yields nothing.
 */
export function requireCredential(env: Env, name: string): string {
  const value = strictCredential(env, name);
  if (value === undefined) {
    throw new Error(`${name} is required: set it, or ${name}_FILE to a file holding it`);
  }
  return value;
}

function authRefs(auth: FeedDefinition["auth"]): { ref: CredentialRef; optional?: boolean }[] {
  if (!auth) return [];
  switch (auth.kind) {
    case "none":
      return [];
    case "query-key":
    case "header-key":
    case "bearer":
      return [{ ref: auth.credential }];
    case "basic":
      return [{ ref: auth.user }, { ref: auth.password }];
    case "oauth2-client-credentials":
      return [{ ref: auth.clientId }, { ref: auth.clientSecret }];
    case "mtls":
      return [
        { ref: auth.cert },
        { ref: auth.key },
        ...(auth.ca ? [{ ref: auth.ca, optional: true }] : []),
      ];
  }
}

function placeholders(text: string | undefined): CredentialRef[] {
  return text ? [...text.matchAll(CREDENTIAL_PLACEHOLDER)].map((m) => m[1] as string) : [];
}

/** Every credential ref a feed definition reads, once each: from `auth`, from
 *  `${ref}` placeholders in its endpoints and from endpoint `expand`. A ref is
 *  optional only when every use of it is. */
export function credentialRefs(
  feed: Pick<FeedDefinition, "auth" | "endpoints">,
): { ref: CredentialRef; optional?: boolean }[] {
  const found = new Map<CredentialRef, { optional?: boolean }>();
  const add = (ref: CredentialRef, optional?: boolean) => {
    const seen = found.get(ref);
    if (!seen) found.set(ref, { optional });
    else if (optional !== true) seen.optional = undefined;
  };

  for (const a of authRefs(feed.auth)) add(a.ref, a.optional);
  for (const endpoint of Object.values(feed.endpoints)) {
    const texts = [
      endpoint.url,
      ...(endpoint.urls ?? []),
      endpoint.body,
      ...Object.values(endpoint.headers ?? {}),
    ];
    for (const text of texts) for (const ref of placeholders(text)) add(ref);
    if (endpoint.expand) add(endpoint.expand);
  }
  return [...found].map(([ref, { optional }]) => ({ ref, optional }));
}

/**
 * Whether a shared group holds instance settings rather than an account: it
 * has fields and every one has a default (where the instance reaches
 * Overpass). Such a group may serve a single feed, and its values are plain
 * configuration, not secrets. An empty group is not one.
 */
export function isSettingsGroup(fields: Readonly<Record<string, CredentialField>>): boolean {
  const all = Object.values(fields);
  return all.length > 0 && all.every((field) => field.default !== undefined);
}

/**
 * A shared field's value for a reader that is no feed (the road-graph import):
 * its env var or `_FILE` variant, else its default. Undefined when neither is
 * set or the catalogue declares no such field.
 */
export function sharedCredentialValue(
  groups: Readonly<Record<string, Readonly<Record<string, CredentialField>>>>,
  ref: CredentialRef,
  env: Env = process.env,
): string | undefined {
  const match = SHARED_REF.exec(ref);
  if (!match) throw new Error(`${ref} is not a shared credential ref (@group.field)`);
  const field = groups[match[1] as string]?.[match[2] as string];
  if (!field) return undefined;
  return resolveCredential(env, credentialEnvName("", ref)) ?? field.default;
}

/** Every credential a feed reads (see {@link credentialRefs}) with its env name.
 *  A catalogue child uses its parent's names. */
export function feedCredentialNames(feed: CatalogFeed): FeedCredentialName[] {
  const ownerId = feed.parentSourceId ?? feed.id;
  return credentialRefs(feed).map(({ ref, optional }) => {
    const field = ref.startsWith("@") ? feed.sharedFields?.[ref] : feed.credentials?.[ref];
    const out: FeedCredentialName = {
      ref,
      env: credentialEnvName(ownerId, ref),
      optional: optional === true || field?.optional === true,
    };
    if (field?.default !== undefined) out.default = field.default;
    if (feed.settingRefs?.includes(ref)) out.setting = true;
    return out;
  });
}
