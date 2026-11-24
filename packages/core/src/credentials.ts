import { readFileSync } from "node:fs";

/** Where a service reads its credentials: `process.env` or a test's stand-in. */
export type CredentialEnv = Record<string, string | undefined>;

/** What reading a credential found: its value, nothing set, or why its file yielded nothing. */
export type CredentialRead = { value: string } | { unset: true } | { failure: string };

/**
 * A credential as the services read every secret: the variable `<NAME>`,
 * else the file `<NAME>_FILE` names (how OpenMapX mounts a vault secret),
 * both trimmed. An empty variable falls through to the file, so a blank
 * placeholder never shadows a mounted secret.
 */
export function readCredential(env: CredentialEnv, name: string): CredentialRead {
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
export function strictCredential(env: CredentialEnv, name: string): string | undefined {
  const read = readCredential(env, name);
  if ("failure" in read) throw new Error(read.failure);
  return "value" in read ? read.value : undefined;
}
