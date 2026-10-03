import { isInstanceId } from "@openconditions/model";

/**
 * Resolves this instance's stable id from the environment. Federation makes a
 * real, unique instance id operationally required; `"local"` keeps a
 * single-instance deployment zero-config. The id is the record-id namespace
 * of everything this instance originates (`oc:<class>:<instanceId>:<localId>`),
 * so it must never contain ":" — a hostname works. Services call this at
 * startup, so a bad value stops the service instead of the first write.
 */
export function resolveInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["OPENCONDITIONS_INSTANCE_ID"]?.trim();
  const id = raw ? raw : "local";
  if (!isInstanceId(id)) {
    throw new Error(
      `OPENCONDITIONS_INSTANCE_ID "${id}" is not a valid instance id: use lower-case letters, digits, dots and dashes, starting and ending with a letter or digit (e.g. maps.example.org)`,
    );
  }
  return id;
}
