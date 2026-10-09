import { type CapReference, capReferences } from "@openconditions/model-hazards";
import type { CapAlert } from "./types.js";

/** The message types that replace the messages they reference: an acknowledgement or an error report replaces nothing. */
const SUPERSEDING = new Set(["Update", "Cancel"]);

/** A CAP token as the message writes it, without surrounding whitespace; empty when absent. */
export const capToken = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const referencesOf = (alert: CapAlert): CapReference[] =>
  typeof alert.references === "string" ? capReferences(alert.references) : [];

/** References, earliest sent first; a reference whose time does not read goes last. */
function bySent(references: readonly CapReference[]): CapReference[] {
  const at = (r: CapReference) => {
    const t = Date.parse(r.sent);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...references].sort((a, b) => at(a) - at(b));
}

/**
 * The messages of one parse that are still in force. A parse sees every
 * message the feed holds now (a complete snapshot, or every message a walk
 * holds), so a message another message of it updates or cancels is
 * superseded and dropped, whatever order the payloads came in.
 *
 * `groupOf` names the warning a message belongs to: the root of its
 * reference chain within the parse, whose earliest reference names the
 * warning it continues, else the root itself. The stored predecessor is
 * never read: a parse is pure, and the earliest reference a message carries
 * is the warning's first message as the publisher knows it.
 */
export function currentMessages(alerts: readonly CapAlert[]): {
  current: CapAlert[];
  superseded: number;
  groupOf: (identifier: string) => string;
} {
  const byId = new Map<string, CapAlert>();
  for (const alert of alerts) if (!byId.has(alert.identifier)) byId.set(alert.identifier, alert);

  const replaced = new Set<string>();
  for (const alert of alerts) {
    if (!SUPERSEDING.has(capToken(alert.msgType))) continue;
    for (const r of referencesOf(alert)) {
      if (r.identifier !== alert.identifier && byId.has(r.identifier)) replaced.add(r.identifier);
    }
  }
  const current = alerts.filter((a) => !replaced.has(a.identifier));

  const groups = new Map<string, string>();
  const groupOf = (identifier: string): string => {
    const known = groups.get(identifier);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    let at = identifier;
    for (;;) {
      seen.add(at);
      const alert = byId.get(at);
      if (alert === undefined) break;
      const earlier = bySent(referencesOf(alert)).find(
        (r) => byId.has(r.identifier) && !seen.has(r.identifier),
      );
      if (earlier === undefined) break;
      at = earlier.identifier;
    }
    const root = byId.get(at);
    const group =
      (root === undefined ? undefined : bySent(referencesOf(root))[0]?.identifier) ?? at;
    groups.set(identifier, group);
    return group;
  };

  return { current, superseded: alerts.length - current.length, groupOf };
}
