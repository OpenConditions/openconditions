/**
 * Freeze an OSM spine extract for one binding-corpus case.
 *
 * Usage: tsx scripts/bind-corpus-spine.ts <west> <south> <east> <north> > spine.json
 *
 * Queries Overpass for the same highway classes the road import keeps and
 * emits directed `f`/`b` segments exactly as `segment-build.ts` produces
 * them, so a case replays offline against the shape the database would hold.
 */
import { parseOverpassWays, segmentsForWay } from "../src/index.js";
import type { SpineSegment } from "../src/bind/types.js";
import { polylineLengthM } from "../src/bind/geo.js";

const [w, s, e, n] = process.argv.slice(2, 6).map(Number);
if ([w, s, e, n].some((v) => !Number.isFinite(v))) {
  console.error("usage: bind-corpus-spine <west> <south> <east> <north>");
  process.exit(2);
}
// Repeated here rather than imported: this package must not depend on the
// ingest service, which owns the list and its `SEGMENT_HIGHWAY_CLASSES`
// override in `services/ingest/src/pipeline/highway-classes.ts`. A test there
// asserts these stay equal. A corpus case captured with a non-default override
// would not replay against a default-configured spine, so this stays on the
// default.
const classes = "motorway|motorway_link|trunk|trunk_link|primary|primary_link";
const query = `[out:json][timeout:60];way["highway"~"^(${classes})$"](${s},${w},${n},${e});out geom;`;
const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  body: `data=${encodeURIComponent(query)}`,
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "openconditions-bind-corpus",
  },
});
if (!res.ok) {
  console.error(`overpass ${res.status}`);
  process.exit(1);
}
const ways = parseOverpassWays(await res.text());
const segments: SpineSegment[] = [];
for (const way of ways) {
  for (const dir of segmentsForWay(way)) {
    const coords = dir === "f" ? way.coords : [...way.coords].reverse();
    segments.push({
      segmentId: `${way.wayId}:${dir}`,
      wayId: way.wayId,
      dir,
      highway: way.highway,
      ref: way.ref ?? null,
      coords,
      lengthM: polylineLengthM(coords),
    });
  }
}
process.stdout.write(JSON.stringify({ segments }));
