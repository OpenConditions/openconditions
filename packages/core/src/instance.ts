import { isInstanceId } from "@openconditions/model";

/** The variable every service reads its instance id from. */
export const INSTANCE_ID_VARIABLE = "OPENCONDITIONS_INSTANCE_ID";

/**
 * Resolves this instance's stable id from the environment. The id is the
 * record-id namespace of everything this instance originates
 * (`oc:<class>:<instanceId>:<localId>`) and its name to federation peers, and
 * crowd votes are signed over record ids, so it can never change once
 * records exist. It is therefore required, with no default: a lower-case DNS
 * name such as `maps.example.org`. Services call this at startup, so a
 * missing or bad value stops the service before it touches the database.
 */
export function resolveInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env[INSTANCE_ID_VARIABLE]?.trim() ?? "";
  if (id === "") {
    throw new Error(
      `${INSTANCE_ID_VARIABLE} is required: set it to this instance's own DNS name (e.g. maps.example.org), the same value on every OpenConditions service of the instance`,
    );
  }
  if (!isInstanceId(id)) {
    throw new Error(
      `${INSTANCE_ID_VARIABLE} "${id}" is not a valid instance id: use a lower-case DNS name, labels of letters, digits and inner dashes joined by single dots, at most 253 characters (e.g. maps.example.org)`,
    );
  }
  return id;
}
