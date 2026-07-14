/**
 * Deterministic encode benchmark: approach (A) private one-hot segment
 * (Prio3Histogram) versus (B) coarse public partition with only speed private
 * (Prio3Sum). Measures the two things CI can measure honestly — report byte size
 * and client-side encode CPU time. Battery / real-device cost is explicitly out
 * of scope (the physical gate owns it).
 */
import {
  encodeCoarsePartition,
  encodePrivateSegment,
  reportByteSize,
  type RegionSpec,
} from "./encoding.js";

export interface EncodeBenchmarkResult {
  approach: "A-private-one-hot" | "B-coarse-partition";
  /** Human label of the VDAF instance. */
  vdaf: string;
  /** Reports encoded to amortize the CPU-time sample. */
  iterations: number;
  /** Total wire bytes of one encoded report (public share + both input shares). */
  reportBytes: number;
  /** Mean wall-clock encode time per report, milliseconds. */
  meanEncodeMs: number;
}

async function timeEncode(
  iterations: number,
  encodeOnce: () => Promise<{ reportBytes: number }>
): Promise<{ reportBytes: number; meanEncodeMs: number }> {
  let reportBytes = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    reportBytes = (await encodeOnce()).reportBytes;
  }
  const meanEncodeMs = (performance.now() - start) / iterations;
  return { reportBytes, meanEncodeMs };
}

/** Benchmarks approach A over a region, and approach B for the same speed. */
export async function runEncodeBenchmark(
  region: RegionSpec,
  sampleSpeed: number,
  sampleSegment: number,
  iterations = 50
): Promise<EncodeBenchmarkResult[]> {
  const a = await timeEncode(iterations, async () => {
    const report = await encodePrivateSegment(region, {
      segmentIndex: sampleSegment,
      clampedSpeed: sampleSpeed,
    });
    return { reportBytes: reportByteSize(report) };
  });
  const b = await timeEncode(iterations, async () => {
    const report = await encodeCoarsePartition(sampleSpeed);
    return { reportBytes: reportByteSize(report) };
  });

  const cells = region.segmentCount * region.speedBucketCount;
  return [
    {
      approach: "A-private-one-hot",
      vdaf: `Prio3Histogram(length=${cells})`,
      iterations,
      reportBytes: a.reportBytes,
      meanEncodeMs: a.meanEncodeMs,
    },
    {
      approach: "B-coarse-partition",
      vdaf: "Prio3Sum(bits=8)",
      iterations,
      reportBytes: b.reportBytes,
      meanEncodeMs: b.meanEncodeMs,
    },
  ];
}
