/**
 * VDAF measurement encoding for the two candidate probe schemes.
 *
 * The spike's INPUT is an already-bucketed `(segmentIndex, window, clampedSpeed)`
 * tuple — it never touches coordinates, map-matching, or a raw trajectory.
 *
 * Approach A (private one-hot segment): a single Prio3Histogram over the
 * `segmentCount × speedBucketCount` joint cells of one coarse public region and
 * window. A measurement selects EXACTLY ONE `(segment, speedBucket)` cell, so the
 * histogram's native one-hot validity proof bounds a malicious client to one
 * segment and to the fixed-point speed range `[0, 200]` (a speed outside the
 * range, or a second segment, is an out-of-range / multi-hot cell the FLP proof
 * rejects at the aggregators). Per-coordinate bounds alone would be insufficient;
 * the one-hot proof is what makes this safe.
 *
 * Approach B (coarse public partition): the region/segment is PUBLIC, so only the
 * clamped speed is private — a Prio3Sum over `[0, 2^bits)`. Far smaller reports,
 * but the segment is disclosed in the clear.
 */
import { Prio3Histogram, Prio3Sum } from "@divviup/prio3";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

/** Fixed-point speed bound (km/h). A probe speed must be clamped into this range. */
export const SPEED_MIN = 0;
export const SPEED_MAX = 200;

/** Prio3Sum bit width for approach B: 8 bits bounds the summed speed to [0, 256). */
export const SUM_SPEED_BITS = 8;

/** A coarse public region+window over which approach A hides the exact segment. */
export interface RegionSpec {
  /** Opaque coarse region id; PUBLIC metadata (never a coordinate). */
  regionId: string;
  /** Coarse time window id; PUBLIC metadata. */
  window: string;
  /** Number of fine segments inside the region. */
  segmentCount: number;
  /** Number of equal-width speed buckets spanning [SPEED_MIN, SPEED_MAX]. */
  speedBucketCount: number;
}

/** An already-bucketed probe measurement (no coordinates, no trajectory). */
export interface ProbeMeasurement {
  /** Fine segment index within the region, in [0, segmentCount). */
  segmentIndex: number;
  /** Clamped speed in [SPEED_MIN, SPEED_MAX] km/h. */
  clampedSpeed: number;
}

/** An encoded VDAF report: the wire bytes an honest client would upload. */
export interface EncodedReport {
  /** 16-byte report id / VDAF nonce; the batch anti-replay key. */
  nonce: Buffer;
  /** Encoded public share (joint-randomness parts). */
  publicShare: Buffer;
  /** Encoded input shares, one per aggregator (Leader, Helper). */
  inputShares: Buffer[];
}

/** Recommended Prio3Histogram chunk length: ~sqrt(length), at least 1. */
export function histogramChunkLength(length: number): number {
  return Math.max(1, Math.floor(Math.sqrt(length)));
}

/** The number of joint one-hot cells approach A encodes over. */
export function cellCount(region: RegionSpec): number {
  return region.segmentCount * region.speedBucketCount;
}

/**
 * Maps a clamped speed to its bucket index in [0, speedBucketCount).
 * Throws if the speed is outside [SPEED_MIN, SPEED_MAX] — the client-side half
 * of the range bound (the aggregator FLP proof is the half a malicious client
 * cannot bypass).
 */
export function speedToBucket(clampedSpeed: number, speedBucketCount: number): number {
  if (!Number.isFinite(clampedSpeed) || clampedSpeed < SPEED_MIN || clampedSpeed > SPEED_MAX) {
    throw new RangeError(
      `clampedSpeed ${clampedSpeed} is outside the fixed-point bound [${SPEED_MIN}, ${SPEED_MAX}]`
    );
  }
  const width = (SPEED_MAX - SPEED_MIN) / speedBucketCount;
  const bucket = Math.floor((clampedSpeed - SPEED_MIN) / width);
  // clampedSpeed === SPEED_MAX lands exactly on speedBucketCount; fold it back.
  return Math.min(bucket, speedBucketCount - 1);
}

/** The joint one-hot cell index for a measurement, or throws if out of range. */
export function measurementCell(region: RegionSpec, m: ProbeMeasurement): number {
  if (
    !Number.isInteger(m.segmentIndex) ||
    m.segmentIndex < 0 ||
    m.segmentIndex >= region.segmentCount
  ) {
    throw new RangeError(`segmentIndex ${m.segmentIndex} is outside [0, ${region.segmentCount})`);
  }
  const speedBucket = speedToBucket(m.clampedSpeed, region.speedBucketCount);
  return m.segmentIndex * region.speedBucketCount + speedBucket;
}

/** The Prio3Histogram instance for approach A over a region's joint cells. */
export function histogramForRegion(region: RegionSpec): Prio3Histogram {
  const length = cellCount(region);
  return new Prio3Histogram({
    shares: 2,
    length,
    chunkLength: histogramChunkLength(length),
  });
}

/** The Prio3Sum instance for approach B (private clamped speed). */
export function sumForSpeed(): Prio3Sum {
  return new Prio3Sum({ shares: 2, bits: SUM_SPEED_BITS });
}

async function shardEncoded(
  vdaf: Prio3Histogram | Prio3Sum,
  measurement: number,
  nonce: Buffer
): Promise<EncodedReport> {
  const rand = Buffer.from(randomBytes(vdaf.randSize));
  const { publicShare, inputShares } = await vdaf.shard(measurement, nonce, rand);
  return {
    nonce,
    publicShare: vdaf.encodePublicShare(publicShare),
    inputShares: inputShares.map((s) => vdaf.encodeInputShare(s)),
  };
}

/**
 * Approach A: encode a PRIVATE one-hot `(segment, speedBucket)` cell over a
 * coarse public region+window. Rejects an out-of-range segment or speed before
 * encoding; a client that bypasses this and forges shares is caught by the
 * aggregators' one-hot validity proof (see aggregation.ts).
 */
export async function encodePrivateSegment(
  region: RegionSpec,
  measurement: ProbeMeasurement,
  nonce: Buffer = Buffer.from(randomBytes(16))
): Promise<EncodedReport> {
  const cell = measurementCell(region, measurement);
  return shardEncoded(histogramForRegion(region), cell, nonce);
}

/**
 * Approach B: encode a coarse public partition — the segment/region is
 * disclosed and only the clamped speed is private (Prio3Sum). Rejects a speed
 * outside the fixed-point bound before encoding.
 */
export async function encodeCoarsePartition(
  clampedSpeed: number,
  nonce: Buffer = Buffer.from(randomBytes(16))
): Promise<EncodedReport> {
  if (!Number.isFinite(clampedSpeed) || clampedSpeed < SPEED_MIN || clampedSpeed > SPEED_MAX) {
    throw new RangeError(
      `clampedSpeed ${clampedSpeed} is outside the fixed-point bound [${SPEED_MIN}, ${SPEED_MAX}]`
    );
  }
  return shardEncoded(sumForSpeed(), Math.round(clampedSpeed), nonce);
}

/** Total wire size of an encoded report (public share + every input share). */
export function reportByteSize(report: EncodedReport): number {
  return report.publicShare.length + report.inputShares.reduce((n, s) => n + s.length, 0);
}
