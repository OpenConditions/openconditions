import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeOpenLrBinary } from "../decode.js";
import { encodeOpenLrBinary, encodeOpenlrLine, type OpenLrLrpInput } from "../encode.js";

/**
 * The encoder's output read by a second, independent implementation: the
 * Python `openlr` library the openlr-resolver runs, pinned with its hash in
 * `python/requirements.txt`. Each line is encoded here, then decoded both by
 * `decodeOpenLrBinary` and by the library, which must read the same LRPs;
 * and the library must write the same bytes for the same LRPs.
 *
 * The interpreter is `OPENLR_PYTHON`, else `python3`, run isolated (`-I`).
 * Without the library the test is skipped, unless `OPENLR_CROSSCHECK` is
 * `required`, as CI sets it, where it fails instead.
 */

const PYTHON = process.env["OPENLR_PYTHON"] ?? "python3";
const SCRIPT = fileURLToPath(new URL("../../python/crosscheck.py", import.meta.url));
const REQUIRED = process.env["OPENLR_CROSSCHECK"] === "required";

const probe = spawnSync(PYTHON, ["-I", "-c", "import openlr"], { encoding: "utf8" });
const unavailable =
  probe.status === 0
    ? undefined
    : `${PYTHON} cannot import openlr (pip install --require-hashes -r packages/openlr/python/requirements.txt)`;

interface PythonLrp {
  longitude: number;
  latitude: number;
  frc: number;
  fow: number;
  bearing: number;
  lfrcnp: number;
  distanceToNext: number;
}

interface PythonLocation {
  type: string;
  points?: PythonLrp[];
  positiveOffset?: number;
  negativeOffset?: number;
}

function python(request: {
  decode?: string[];
  encode?: { points: OpenLrLrpInput[]; positiveOffset: number; negativeOffset: number }[];
}): { decoded: PythonLocation[]; encoded: string[] } {
  const run = spawnSync(PYTHON, ["-I", SCRIPT], {
    input: JSON.stringify(request),
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`crosscheck.py failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** Java's `Math.round`, which the library rounds bearings and DNPs with. */
const jRound = (n: number) => Math.floor(n + 0.5);

/** Lines of every shape the encoder meets: short and long, every heading, both hemispheres. */
const line = (name: string, frc: number, fow: number, ...flat: number[]) => ({
  name,
  frc,
  fow,
  coords: flat.flatMap((v, i) => (i % 2 === 0 ? [[v, flat[i + 1]!] as [number, number]] : [])),
});

const LINES = [
  line("a short motorway stretch", 0, 1, 4.895, 52.37, 4.9, 52.371, 4.905, 52.372),
  line("a corner, east then south", 3, 3, 4.9, 52.37, 4.902, 52.37, 4.902, 52.368),
  line("a westward road, southern", 2, 2, -46.63, -23.55, -46.64, -23.552, -46.66, -23.551),
  line("a northward slip road", 4, 6, -122.42, 37.77, -122.4201, 37.772),
  line("a 20 km line, split by the 15 km cap", 1, 1, 4.0, 52.0, 4.3, 52.0),
  line("a winding 40 km road", 5, 3, 10.0, 60.0, 10.2, 60.1, 10.1, 60.25, 10.4, 60.3),
];

describe.skipIf(unavailable !== undefined && !REQUIRED)(
  "the Python openlr library reads the encoder's output",
  () => {
    it("is available", () => {
      expect(unavailable).toBeUndefined();
    });

    it.for(LINES)("reads $name as decodeOpenLrBinary does", ({ coords, frc, fow }) => {
      const binary = encodeOpenlrLine({ coords, frc, fow });
      const ours = decodeOpenLrBinary(binary);
      const [theirs] = python({ decode: [binary] }).decoded;
      expect(theirs!.type).toBe("line");
      expect(theirs!.points).toHaveLength(ours.points.length);
      theirs!.points!.forEach((p, i) => {
        const o = ours.points[i]!;
        expect(p.longitude).toBeCloseTo(o.longitude, 7);
        expect(p.latitude).toBeCloseTo(o.latitude, 7);
        expect([p.frc, p.fow, p.distanceToNext]).toEqual([o.frc, o.fow, o.distanceToNext]);
        // The library reads a bearing sector as its midpoint, rounded.
        expect(p.bearing).toBe(jRound(o.bearing));
        // The last LRP has no LFRCNP; both read the lowest class.
        expect(p.lfrcnp).toBe(o.lfrcnp ?? 7);
      });
      expect([theirs!.positiveOffset, theirs!.negativeOffset]).toEqual([0, 0]);
      // Both ends land where the line does, within what the binary keeps:
      // the first LRP in 24 bits (360 / 2^24 degrees a step), to half a step
      // plus the quarter step the reference encoder's rounding through a
      // 32-bit float can add below 90°; each later one in 1e-5° relative to
      // the one before, which the reference takes unrounded, so half a unit
      // more per LRP. openlr-js does both as TomTom's encoder does, which is
      // what keeps its bytes identical to the reference vectors.
      const step = 360 / 2 ** 24;
      const within = (i: number) => 0.75 * step + 0.5e-5 * i + 1e-9;
      const first = theirs!.points![0]!;
      const n = theirs!.points!.length - 1;
      const last = theirs!.points![n]!;
      expect(Math.abs(first.longitude - coords[0]![0])).toBeLessThan(within(0));
      expect(Math.abs(first.latitude - coords[0]![1])).toBeLessThan(within(0));
      expect(Math.abs(last.longitude - coords.at(-1)![0])).toBeLessThan(within(n));
      expect(Math.abs(last.latitude - coords.at(-1)![1])).toBeLessThan(within(n));
    });

    it.for(LINES)("writes $name's LRPs to the same bytes", ({ coords, frc, fow }) => {
      const binary = encodeOpenlrLine({ coords, frc, fow });
      const { points } = decodeOpenLrBinary(binary);
      const lrps = points.map(({ sequenceNumber: _, isLast: __, ...p }) => p);
      const [theirs] = python({
        encode: [{ points: lrps, positiveOffset: 0, negativeOffset: 0 }],
      }).encoded;
      expect(encodeOpenLrBinary({ points: lrps })).toBe(theirs);
    });

    it("writes the whitepaper's line with its positive offset to the same bytes", () => {
      // Whitepaper v1.5 rev 2, 13.1.3: Tables 72 to 74, a 150 m positive
      // offset on a first LRP length of 561 m.
      const lrp = (
        [longitude, latitude, frc, fow, bearing, distanceToNext]: [
          number,
          number,
          number,
          number,
          number,
          number,
        ],
        lfrcnp: number | null,
      ): OpenLrLrpInput => ({ longitude, latitude, frc, fow, bearing, distanceToNext, lfrcnp });
      const points = [
        lrp([6.12683, 49.60851, 3, 2, 135, 561], 3),
        lrp([6.12838, 49.60398, 3, 3, 227, 274], 5),
        lrp([6.12817, 49.60305, 5, 3, 290, 0], null),
      ];
      const ours = encodeOpenLrBinary({ points, positiveOffset: 150 });
      const [theirs] = python({
        encode: [{ points, positiveOffset: 150 / 561, negativeOffset: 0 }],
      }).encoded;
      expect(ours).toBe("CwRbWyNG9RpsCQCb/jsbtAT/6/+jK1lE");
      expect(theirs).toBe(ours);
    });
  },
);
