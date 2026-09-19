import { jcs } from "../kernel/identity.js";
import type { Registry } from "./build.js";
import type { RevisionClass } from "./define.js";

type Rec = Readonly<Record<string, unknown>>;

/** The change kinds of a record's first revision and of its tombstoning revision. */
export const CREATED = "created";
export const TOMBSTONED = "tombstoned";

const canonical = (value: unknown) => jcs({ value });

/**
 * The `change_kinds` of a new revision: `created` without a previous
 * revision, `tombstoned` when the new revision is the tombstone, else every
 * registered change kind of the record's class whose watched part differs, in
 * registry order. Revisions are written on content-hash changes, so a result
 * is never empty for real input; the kernel change kinds watch every content
 * field.
 */
export function computeChangeKinds(
  registry: Registry,
  previous: Rec | undefined,
  next: Rec,
): string[] {
  if (previous === undefined) return [CREATED];
  if (next["tombstone"] !== undefined && previous["tombstone"] === undefined) return [TOMBSTONED];
  const cls = next["class"] as RevisionClass;
  return registry
    .changeKinds()
    .filter((c) => c.classes.includes(cls))
    .filter((c) => canonical(c.select(previous)) !== canonical(c.select(next)))
    .map((c) => c.code);
}
