import type { PinnedFile, PinnedSet } from "../pinned.js";

/**
 * OpenLR: the binary test vectors of TomTom's reference implementation,
 * https://github.com/tomtom-international/openlr, at commit
 * `a35e3cf508511799c919403b1b3bfa0554b203fb` (master, 2025-10-31).
 * Retrieved 2026-10-21. The repository is under the Apache License 2.0 (its
 * `LICENSE`); its files are fetched like every other standard's, so the
 * vectors are always the upstream bytes.
 *
 * The vectors are Java byte arrays in the binary module's tests, read from
 * the pinned sources by name: `OpenLRBinaryDecoderTest.java` (line
 * locations in binary versions 2 and 3, with and without offsets),
 * `OpenLRBinaryEncoderTest.java` (the line the OpenLR whitepaper v1.5 rev 2
 * encodes in section 13.1.3, `CwRbWyNG9RpsCQCb/jsbtAT/6/+jK1lE`, and its
 * variants), `Lrp.java` (the LRPs those vectors encode and decode to) and
 * `PointAlongLineTest.java` / `PoiWithAccessTest.java` (the whitepaper's
 * point location examples).
 */
const RAW =
  "https://raw.githubusercontent.com/tomtom-international/openlr/a35e3cf508511799c919403b1b3bfa0554b203fb/";

const test = (name: string, sha256: string): PinnedFile => ({
  name,
  url: `${RAW}binary/src/test/java/openlr/binary/${name}`,
  sha256,
});

export const OPENLR_REFERENCE: PinnedSet = {
  id: "openlr-tomtom-a35e3cf5",
  files: [
    test(
      "OpenLRBinaryDecoderTest.java",
      "777e9ed1dbaf08fb24186c9965bd16b4f2ee7af287559af0a1da40dceaded0e8",
    ),
    test(
      "OpenLRBinaryEncoderTest.java",
      "ae3700c8e9bf128d2f4710e4d70b5698e7446c6e026355f0aea1a4dcf2207161",
    ),
    test("Lrp.java", "676e6f562e40b3bd0cdc116a8342e53d2a0ad6f335d50a72e5291b41b5ff48da"),
    test(
      "PointAlongLineTest.java",
      "a6ff6deaf56803a1c6447ff9f2c532fa6b6c30576c96e636ab82913f9857f9bb",
    ),
    test(
      "PoiWithAccessTest.java",
      "715deec7ce2407230fcc8f84a8582198a29c0f9a6f5c971b7d3318c8d590555f",
    ),
  ],
};
