# Conservative situation deduplication

`dedupe=1` optionally folds compatible reports from different sources for display.
It does not establish authoritative event identity or combine traffic effects.
The first report in read order survives with its original ID, geometry, effects
and validity. The other reports' source IDs, record IDs, attribution and upstream
publisher credits are listed in `provenance.mergedSources`. Stored records and
individual-record reads remain separate.

## Conditions for folding

Every pair in a folded group must come from different sources and lie within
75 metres, or within 250 metres while naming the same road reference. Whitespace
and case in road reference codes are normalized. Two reports with one source ID
cannot disappear through an intervening report from another provider. A chain of
nearby reports cannot bridge two members outside the matching distance.

Spatial proximity is only a candidate gate. The reports must also agree on
canonical traffic meaning: kind/type/subtype, certainty, severity, planned state,
validity and recurring periods/exceptions, affected features, effects, vehicle
applicability, lanes, action status, numeric limits, phase-specific restrictions,
other detail fields, and expiry/staleness declarations. Missing versus explicit
values can prevent folding. This favors retaining extra reports over silently
losing a restriction; it does not attempt fuzzy equivalence or unit conversion.

Locations must have explicit `fuzziness: exact` and compatible location context,
including road/carriageway, lanes, reference system, direction and level. Root
points may differ within the distance gate; altitude still has to agree. Lines,
areas and explicit effect geometries must agree exactly. A shared centroid or
endpoints alone is not enough. Positive/negative directions require an anchored
road reference, an editioned Alert-C reference, or the same OpenLR reference.
Unknown direction, coarse/missing precision and unresolved reference axes prevent
folding.

At least one complete typed effect must be present, on the situation or in its
phases. Narrative-only reports remain separate. Any unknown vehicle applicability,
partial/unsupported effect, normalization issue, unknown compliance or unknown
validity prevents folding. Already aggregated reports remain separate so their
nested source credits are preserved.

Object key order, effect collection order, phase collection order and provider
local effect/phase IDs do not establish different traffic meaning. Effect source
paths, acquisition timestamps, record identity/revision stamps, headline and
description translations are also excluded from comparison. Their source records
remain accessible by ID. Other canonical semantic fields are compared
conservatively, including fields introduced by future model extensions.

## Queries, projections and limits

JSON, GeoJSON, JSON-LD and DATEX situation reads fold within the selected page.
The complete TraFF selection folds across its internal pages. Page boundaries
and the original keyset cursor remain unchanged; folding can return fewer records
than the requested page size. Public rights filtering and reporter redaction run
before folding.

When `simplify` is requested, reports remain unfolded even with `dedupe=1`:
simplification has already discarded the original geometry needed to establish
extent compatibility. The requested simplified geometry is still returned.

This is an intentionally conservative display heuristic. It is not a replacement
for source lifecycle handling, road binding, canonical feature identity or
restriction evidence. Consumers needing all source reports should omit `dedupe`
or use `dedupe=0`.
