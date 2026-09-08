/**
 * Print the resolver's decision for one event: chosen path, aggregate fit and
 * the per-sample candidate table that explains why a carriageway won or why
 * the direction stayed undecided.
 *
 * Usage: tsx scripts/bind-inspect.ts <case-id> | tsx scripts/bind-inspect.ts <event.json> <spine.json>
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bindEvent } from "../src/bind/bind-event.js";
import type { BindInput, SpineSubgraph } from "../src/bind/types.js";

const args = process.argv.slice(2);
const corpusDir = join(import.meta.dirname, "..", "src", "bind", "__tests__", "corpus");
const [eventPath, spinePath] =
  args.length === 1
    ? [join(corpusDir, args[0]!, "event.json"), join(corpusDir, args[0]!, "spine.json")]
    : [args[0]!, args[1]!];
if (!eventPath || !spinePath || !existsSync(eventPath) || !existsSync(spinePath)) {
  console.error("usage: bind-inspect <case-id> | <event.json> <spine.json>");
  process.exit(2);
}
const input = JSON.parse(readFileSync(eventPath, "utf8")) as BindInput;
const spine = JSON.parse(readFileSync(spinePath, "utf8")) as SpineSubgraph;
const r = bindEvent(input, spine);

console.log(
  `event ${input.id} type=${input.type} refs=${input.refs.join(",")} geometry=${input.geometry.type}`
);
console.log(
  `status=${r.status} confidence=${r.confidence?.toFixed(3)} directionMode=${r.directionMode} candidates=${r.candidateCount} reason=${r.reason ?? "-"}`
);
console.log(
  `coverage=${r.debug.coverage?.toFixed(2)} meanOffsetM=${r.debug.meanOffsetM?.toFixed(1)} ambiguity=${r.debug.ambiguity?.toFixed(2)}`
);
console.log("\nchosen path:");
for (const s of r.segments)
  console.log(
    `  ${s.segmentId.padEnd(14)} ${s.startFraction.toFixed(2)} → ${s.endFraction.toFixed(2)}`
  );
console.log("\nsamples (top 3 candidates each):");
r.debug.samples.forEach((s, i) => {
  console.log(`  #${i} ${s.point[0].toFixed(5)},${s.point[1].toFixed(5)}`);
  for (const c of s.candidates.slice(0, 3)) {
    console.log(
      `     ${c.segment.segmentId.padEnd(14)} ${c.segment.highway.padEnd(14)} ref=${(c.segment.ref ?? "-").padEnd(8)} off=${c.offsetM.toFixed(1).padStart(5)}m Δb=${c.bearingDelta == null ? "  -" : c.bearingDelta.toFixed(0).padStart(3)} ref=${c.refScore} score=${c.score.toFixed(3)}`
    );
  }
});
