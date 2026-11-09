import { createHash } from "node:crypto";
import { emptyParseOutput } from "@openconditions/ingest-framework";
import { capReferences } from "@openconditions/model-hazards";
import { type HazardsFeed, situationId } from "../records.js";
import { capOutput } from "./accounting.js";
import { capDrafts } from "./situations.js";
import type { CapAlert } from "./types.js";

/** SMN byte variants are internal assertion identities, never CAP reference targets. */
export function smnOutput(
  alerts: readonly CapAlert[],
  bodies: readonly Buffer[],
  feed: HazardsFeed,
  fetchedAt: string,
) {
  const variants = new Map<string, CapAlert>();
  alerts.forEach((a, i) => {
    const body = bodies[i];
    if (!body) throw new Error("SMN: missing variant bytes");
    variants.set(createHash("sha256").update(body).digest("hex"), a);
  });
  const key = (a: { sender: string; identifier: string; sent: string }) =>
    JSON.stringify([a.sender, a.identifier, a.sent]);
  const tuples = new Map<string, string[]>();
  for (const [id, a] of variants) tuples.set(key(a), [...(tuples.get(key(a)) ?? []), id]);
  const replaced = new Set<string>();
  const withheld = new Set<string>();
  const targets = new Map<string, string[]>();
  const diagnostics: NonNullable<ReturnType<typeof emptyParseOutput>["smn"]>["diagnostics"] = [];
  for (const [id, a] of variants) {
    if (a.status !== "Actual" || !["Update", "Cancel"].includes(a.msgType)) continue;
    const refs = capReferences(a.references ?? "");
    const matches = refs.map((r) => tuples.get(key(r)) ?? []);
    const ambiguous = matches.some((m) => m.length > 1 || m.includes(id));
    const missing = matches.some((m) => m.length === 0) || refs.length === 0;
    if (ambiguous || missing)
      diagnostics.push({
        variant: id,
        reason: ambiguous ? "ambiguous-lifecycle" : "missing-predecessor",
        references: refs,
      });
    // An ambiguous multi-target action grants no partial replacement authority.
    if (ambiguous) {
      withheld.add(id);
      for (const ids of matches) for (const target of ids) withheld.add(target);
      continue;
    }
    if (a.msgType === "Cancel" && missing) {
      withheld.add(id);
      // Known targets of a partly unresolved cancel also have uncertain validity.
      for (const ids of matches) for (const target of ids) withheld.add(target);
      continue;
    }
    const resolved = matches.flat();
    targets.set(id, resolved);
  }
  // A reference cycle cannot establish replacement authority.
  for (const id of targets.keys()) {
    const pending = [...(targets.get(id) ?? [])];
    const seen = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === id) {
        withheld.add(id);
        diagnostics.push({ variant: id, reason: "cyclic-lifecycle", references: [] });
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(targets.get(next) ?? []));
    }
  }
  // Uncertainty propagates across resolved lifecycle dependencies in either direction.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, ids] of targets) {
      if (!withheld.has(id) && !ids.some((target) => withheld.has(target))) continue;
      for (const target of [id, ...ids]) {
        if (!withheld.has(target)) {
          withheld.add(target);
          changed = true;
        }
      }
    }
  }
  for (const [id, ids] of targets)
    if (!withheld.has(id)) for (const target of ids) replaced.add(target);
  const out = emptyParseOutput();
  let terminal = 0;
  let expired = 0;
  let withheldCount = 0;
  const suppress = new Set<string>();
  for (const [id, a] of variants) {
    const probe = capOutput([a], feed, { fetchedAt, reportSkips: false, rejectMalformed: true });
    const ends = a.info ?? [];
    const isExpired =
      ends.length > 0 && ends.every((i) => Date.parse(i.expires ?? "") <= Date.parse(fetchedAt));
    if (isExpired) {
      expired++;
      terminal++;
      suppress.add(id);
      continue;
    }
    if (withheld.has(id)) {
      withheldCount++;
      suppress.add(id);
      continue;
    }
    if (replaced.has(id) || a.msgType === "Cancel" || isExpired || probe.records?.terminal === 1) {
      terminal++;
      suppress.add(id);
      continue;
    }
    const drafts = capDrafts(a, feed, {
      fetchedAt,
      localId: id,
      referenceIds: targets.get(id) ?? [],
    });
    out.situations.push(...drafts.drafts);
  }
  out.records = {
    inputCount: alerts.length,
    uniqueCount: variants.size,
    duplicates: alerts.length - variants.size,
    accepted: out.situations.length,
    terminal,
    unlocatable: 0,
    unlocatableSituations: [],
    unlocatableRecords: [],
    situationRecords: Object.fromEntries(out.situations.map((s) => [String(s["id"]), 1])),
  };
  out.smn = {
    partial: true,
    accepted: out.situations.length,
    terminal,
    retained: variants.size,
    expired,
    withheld: withheldCount,
    diagnostics,
    suppress: [
      ...new Set(
        [...suppress]
          .map((id) => situationId(feed, id))
          .concat([...variants.values()].map((a) => situationId(feed, a.identifier))),
      ),
    ],
  };
  return out;
}
