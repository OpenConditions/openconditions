import { pinnedFiles, pinnedOrUnavailable } from "@openconditions/conformance";
import { OPENLR_REFERENCE } from "@openconditions/conformance/standards/openlr";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeOpenLrBinary, type LrpPoint } from "../decode.js";
import { encodeOpenLrBinary, type OpenLrLrpInput } from "../encode.js";

/**
 * The decoder and the encoder's physical layer held to TomTom's reference
 * implementation (pinned in `OPENLR_REFERENCE`). Every vector, LRP and offset
 * below is read by name from the pinned Java sources rather than restated,
 * so the test checks against upstream's own values. Coordinates are compared
 * as the reference compares them, rounded to five decimals.
 *
 * Point locations are a permitted difference: the decoder reads line
 * locations only, which is all the resolver can place, and refuses a point
 * along a line or a POI with access point by naming its type.
 */

let unavailable: string | undefined;
const sources = new Map<string, string>();

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(OPENLR_REFERENCE);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  for (const file of await pinnedFiles(OPENLR_REFERENCE)) {
    sources.set(file.fileName, file.contents.replace(/\/\*[\s\S]*?\*\//g, ""));
  }
}, 120_000);

const source = (file: string) => {
  const text = sources.get(file);
  if (text === undefined) throw new Error(`no ${file}`);
  return text;
};

/** A Java `byte[]` constant of a pinned source, as base64. */
function vector(file: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:new byte\\[\\]\\s*)?\\{([^}]*)\\}`).exec(
    source(file),
  );
  if (match === null) throw new Error(`${file} has no byte array ${name}`);
  const bytes = match[1]!.split(",").map((b) => Number(b.trim()));
  return Buffer.from(Int8Array.from(bytes).buffer).toString("base64");
}

/** A Java `int` constant of a pinned source. */
function constant(file: string, name: string): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*(-?\\d+)\\s*;`).exec(source(file));
  if (match === null) throw new Error(`${file} has no constant ${name}`);
  return Number(match[1]);
}

const FOW: Readonly<Record<string, number>> = {
  UNDEFINED: 0,
  MOTORWAY: 1,
  MULTIPLE_CARRIAGEWAY: 2,
  SINGLE_CARRIAGEWAY: 3,
  ROUNDABOUT: 4,
  TRAFFIC_SQUARE: 5,
  SLIPROAD: 6,
  OTHER: 7,
};

const frcOf = (token: string) =>
  token === "null" ? null : Number(/FunctionalRoadClass\.FRC_(\d)/.exec(token)![1]);

/** An LRP of `Lrp.java`, whose arguments are FRC, FOW, latitude, longitude, bearing, DNP and LFRCNP. */
function lrp(name: string): OpenLrLrpInput {
  const match = new RegExp(`\\b${name}\\(([^)]*)\\)`).exec(source("Lrp.java"));
  if (match === null) throw new Error(`Lrp.java has no ${name}`);
  const [frc, fow, lat, lon, bearing, dnp, lfrcnp] = match[1]!.split(",").map((t) => t.trim());
  return {
    frc: frcOf(frc!)!,
    fow: FOW[fow!.replace("FormOfWay.", "")]!,
    latitude: Number(lat),
    longitude: Number(lon),
    bearing: Number(bearing),
    distanceToNext: Number(dnp),
    lfrcnp: frcOf(lfrcnp!),
  };
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** A decoded LRP as the reference checks it (`Utils.checkDecodedLrps`). */
const asChecked = (p: LrpPoint): OpenLrLrpInput => ({
  frc: p.frc,
  fow: p.fow,
  latitude: round5(p.latitude),
  longitude: round5(p.longitude),
  bearing: p.bearing,
  distanceToNext: p.distanceToNext,
  lfrcnp: p.lfrcnp,
});

const DEC = "OpenLRBinaryDecoderTest.java";
const ENC = "OpenLRBinaryEncoderTest.java";

describe("decodeOpenLrBinary against TomTom's reference decoder tests", () => {
  const cases = [
    {
      name: "a version 2 line with both offsets",
      data: [DEC, "VALID_BIN_DATA_POS_OFFSET_V2"],
      lrps: ["LINE_DEC_LRP1", "LINE_DEC_LRP2", "LINE_DEC_LRP3"],
      // Version 2 offsets are absolute.
      offsets: [
        [DEC, "EXPECTED_POS_OFFSET_V2"],
        [DEC, "EXPECTED_NEG_OFFSET_V2"],
      ],
    },
    {
      name: "a version 3 line with both offsets",
      data: [DEC, "VALID_BIN_DATA_OFFSETS_V3"],
      lrps: ["LINE_DEC_LRP1", "LINE_DEC_LRP2", "LINE_DEC_LRP3"],
      // Version 3 offsets are shares of the first and of the last LRP length.
      offsets: [
        [DEC, "EXPECTED_POS_OFFSET_V3"],
        [DEC, "EXPECTED_NEG_OFFSET_V3"],
      ],
    },
    {
      name: "a version 3 line without offsets",
      data: [DEC, "VALID_BIN_DATA_NO_OFFSET_V3"],
      lrps: ["LINE_DEC_LRP1", "LINE_DEC_LRP2", "LINE_DEC_LRP3"],
      offsets: null,
    },
    {
      name: "the whitepaper's line example (13.1)",
      data: [ENC, "DATA_WP_EXAMPLE"],
      lrps: ["LINE_DEC_LRP1", "LINE_DEC_LRP2_WP", "LINE_DEC_LRP3_WP"],
      offsets: [[DEC, "EXPECTED_POS_OFFSET_WP_EXAMPLE"], null],
    },
  ] as const;

  it.for(cases)("decodes $name to the reference's LRPs and offsets", (c, { skip }) => {
    if (unavailable) skip(unavailable);
    const decoded = decodeOpenLrBinary(vector(c.data[0], c.data[1]));
    expect(decoded.points.map(asChecked)).toEqual(c.lrps.map(lrp));
    expect(decoded.points.map((p) => p.isLast)).toEqual([false, false, true]);
    const [pos, neg] = c.offsets ?? [null, null];
    expect(decoded.positiveOffset).toBe(pos === null ? 0 : constant(pos[0], pos[1]));
    expect(decoded.negativeOffset).toBe(neg === null ? 0 : constant(neg[0], neg[1]));
  });

  it("the whitepaper example is the base64 string section 13.1.3 prints", ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(vector(ENC, "DATA_WP_EXAMPLE")).toBe("CwRbWyNG9RpsCQCb/jsbtAT/6/+jK1lE");
  });

  it.for([
    ["PointAlongLineTest.java", "EXPECTED_RESULT_WP_ENCODING", "POINT_ALONG_LINE"],
    ["PointAlongLineTest.java", "VALID_BIN_DATA_NO_OFFSET", "POINT_ALONG_LINE"],
    ["PoiWithAccessTest.java", "EXPECTED_RESULT_WP_ENCODING", "POI_WITH_ACCESS_POINT"],
  ] as const)(
    "refuses %s %s, a point location, by naming its type",
    ([file, name, type], { skip }) => {
      if (unavailable) skip(unavailable);
      expect(() => decodeOpenLrBinary(vector(file, name))).toThrow(
        `Unsupported OpenLR location type: ${type}`,
      );
    },
  );
});

describe("encodeOpenLrBinary against TomTom's reference encoder tests", () => {
  const points = () => ["LINE_ENC_LRP1", "LINE_ENC_LRP2", "LINE_ENC_LRP3"].map(lrp);

  it.for([
    ["DATA_WP_EXAMPLE", "POSITVE_OFFSET_WP_EXAMPLE", null],
    ["DATA_VALID_NO_OFFSETS_V3", null, null],
    ["DATA_VALID_WITH_OFFSETS_V3", "POSITVE_OFFSET_WP_EXAMPLE", "NEGATIVE_OFFSET"],
  ] as const)("writes %s byte for byte", ([data, pos, neg], { skip }) => {
    if (unavailable) skip(unavailable);
    const encoded = encodeOpenLrBinary({
      points: points(),
      positiveOffset: pos === null ? 0 : constant(ENC, pos),
      negativeOffset: neg === null ? 0 : constant(ENC, neg),
    });
    expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(vector(ENC, data), "base64"));
  });

  it("refuses an offset longer than its LRP length, as the reference does", ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(() =>
      encodeOpenLrBinary({
        points: points(),
        positiveOffset: constant(ENC, "POSITVE_OFFSET_TOO_LONG"),
      }),
    ).toThrow(/OpenLR encode failed/);
  });

  it("decodes what it writes to the reference's sectors and intervals", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const decoded = decodeOpenLrBinary(encodeOpenLrBinary({ points: points() }));
    // The decoder reads back the WP example's decoded LRPs: bearing sector
    // midpoints, DNP interval midpoints and the default LFRCNP of the last.
    expect(decoded.points.map(asChecked)).toEqual(
      ["LINE_DEC_LRP1", "LINE_DEC_LRP2_WP", "LINE_DEC_LRP3_WP"].map(lrp),
    );
  });
});
