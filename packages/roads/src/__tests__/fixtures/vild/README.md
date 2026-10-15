# NDW VILD regression capture

`ndw-method2-points.xml` retains the nine records without supplied geometry from
NDW's `actueel_beeld.xml`, published at `2026-10-15T18:46:00.002131626Z` on
15 October 2026. Original situation/record IDs, groups and publication time are
preserved; namespace declarations needed by the extracted records are included.
These are Method2 point references for VILD `8 / 6.13 / A`, without offsets.
The source is NDW/Rijkswaterstaat open traffic data (CC0).

Full input SHA-256:
`24bdefdfeebcf17ab4ba62ae14d3ad59e7114fd9c0317d0512e211a03e2463ff`.

The official VILD archive, licence, generation procedure, measured gain and
precision limitations are documented in
[the location-reference research](../../../../../../docs/location-reference-research.md).
These coded points establish coarse locations, not exact closure extents.

`publisher-point-comparison.json` records the 15 Method2 records in the same
publication that also supplied an explicit point (10 distinct codes). Distances
are diagnostic great-circle separations in metres between the official table
point and the publisher point. They are independent of the table coordinates,
but are not surveyed ground truth or validation of closure extents. Repeated
codes remain separate records; do not treat them as independent survey samples.
