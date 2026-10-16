import { BinaryDecoder, LocationReference, LocationType } from "openlr-js";

/** A single Location Reference Point extracted from an OpenLR binary. */
export interface LrpPoint {
  /** Sequence position (1-based). */
  sequenceNumber: number;
  /** Longitude in decimal degrees (WGS84). */
  longitude: number;
  /** Latitude in decimal degrees (WGS84). */
  latitude: number;
  /** Functional Road Class (0 = highest, 7 = lowest). */
  frc: number;
  /** Form of Way (0 = undefined, 1 = motorway, 3 = single carriageway, …). */
  fow: number;
  /** Lowest FRC to next point along the shortest path. */
  lfrcnp: number | null;
  /** Bearing in degrees (0–360, clockwise from north). */
  bearing: number;
  /** Distance to next LRP in metres (0 on the last LRP). */
  distanceToNext: number;
  /** True on the terminal LRP. */
  isLast: boolean;
}

/** Decoded representation of an OpenLR line location reference. */
export interface OpenLrLocation {
  type: "line";
  /** Ordered list of location reference points (at least two). */
  points: LrpPoint[];
  /**
   * Positive offset in metres from the first LRP, estimated against the first
   * LRP's distance to the second.
   */
  positiveOffset: number;
  /**
   * Negative offset in metres before the last LRP, estimated against the
   * second-last LRP's distance to the last.
   */
  negativeOffset: number;
}

const decoder = new BinaryDecoder();

/**
 * Decode a base64-encoded OpenLR binary string into a structured line location.
 *
 * Only LINE_LOCATION type is supported — other types raise an error. The
 * function is stateless and may be called concurrently.
 */
export function decodeOpenLrBinary(base64: string): OpenLrLocation {
  const buf = Buffer.from(base64, "base64");
  const ref = LocationReference.fromIdAndBuffer("openlr", buf);
  const raw = decoder.decodeData(ref);

  if (raw === null || !raw.isValid()) {
    const code = raw?.getReturnCode() ?? "null";
    throw new Error(`OpenLR decode failed (return code ${code})`);
  }

  if (raw.getLocationType() !== LocationType.LINE_LOCATION) {
    throw new Error(`Unsupported OpenLR location type: ${LocationType[raw.getLocationType()]}`);
  }

  const rawPoints = raw.getLocationReferencePoints();
  const offsets = raw.getOffsets();

  if (!rawPoints || rawPoints.length < 2) {
    throw new Error("OpenLR line location must have at least two LRPs");
  }

  const points: LrpPoint[] = rawPoints.map((p, i) => {
    const frc = p.getFRC();
    const fow = p.getFOW();
    if (frc == null) {
      throw new Error(`OpenLR LRP ${i + 1}: FRC is missing — binary data may be corrupt`);
    }
    if (fow == null) {
      throw new Error(`OpenLR LRP ${i + 1}: FOW is missing — binary data may be corrupt`);
    }
    return {
      sequenceNumber: i + 1,
      longitude: p.getLongitudeDeg(),
      latitude: p.getLatitudeDeg(),
      frc,
      fow,
      lfrcnp: p.getLfrc(),
      bearing: p.getBearing(),
      distanceToNext: p.getDistanceToNext(),
      isLast: p.isLastLRP(),
    };
  });

  // Binary v3 stores each offset as a share of its LRP length: the first LRP's
  // distance to the second for the positive offset, and the second-last LRP's
  // distance to the last for the negative offset (whitepaper v1.5, 7.5.2).
  const headLength = points.at(0)?.distanceToNext ?? 0;
  const tailLength = points.at(-2)?.distanceToNext ?? 0;
  const positiveOffset = offsets ? offsets.getPositiveOffset(headLength) : 0;
  const negativeOffset = offsets ? offsets.getNegativeOffset(tailLength) : 0;

  return { type: "line", points, positiveOffset, negativeOffset };
}
