/**
 * Road reference normalization. Feeds and OSM spell the same road many ways
 * ("A 46", "A46", "a-46"), and both sides can carry several refs in one field,
 * so refs are compared as normalized sets rather than as strings.
 */

/** Uppercase, strip whitespace/hyphens, split on `;`, `,` and `/`. */
export function normalizeRefs(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    for (const part of v.split(/[;,/]/)) {
      const n = part.toUpperCase().replace(/[\s-]+/g, "");
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** 1 = a stated match, 0.5 = either side has no ref, 0 = a stated mismatch. */
export function refScore(eventRefs: string[], segmentRef: string | null): 1 | 0.5 | 0 {
  if (eventRefs.length === 0) return 0.5;
  const seg = normalizeRefs([segmentRef]);
  if (seg.length === 0) return 0.5;
  return seg.some((s) => eventRefs.includes(s)) ? 1 : 0;
}
