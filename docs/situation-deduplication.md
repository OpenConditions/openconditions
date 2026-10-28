# Conservative situation deduplication

`dedupe=1` optionally folds compatible reports from different sources for display.
It does not establish authoritative event identity or combine traffic effects.
A report folds when it has the same traffic meaning as another (below), or when
two publishers describe one measure (see [One measure from two
publishers](#one-measure-from-two-publishers)). The first report in read order
survives with its original ID, geometry, effects and validity, except that a
report covering the other one measure survives in its place. The other reports' source IDs, record IDs, attribution and upstream
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

For the traffic-meaning match, at least one complete typed effect must be
present, on the situation or in its phases. Any unknown vehicle applicability,
partial/unsupported effect, normalization issue, unknown compliance or unknown
validity prevents folding. Already aggregated reports remain separate so their
nested source credits are preserved.

Object key order, effect collection order, phase collection order and provider
local effect/phase IDs do not establish different traffic meaning. Effect source
paths, acquisition timestamps, record identity/revision stamps, headline and
description translations are also excluded from comparison. Their source records
remain accessible by ID. Other canonical semantic fields are compared
conservatively, including fields introduced by future model extensions.

## One measure from two publishers

A city's roadworks and the state's or the motorway operator's record of the
same works agree on their dates and lie one on top of the other, but share
neither the publisher's own type nor, often, the exact validity or wording, so
their traffic meanings never match. Distance is no signal here: a street
crossing a motorway lies at 0 m. Two reports of different sources are one
measure when:

- their kinds agree, `roadworks` and `closure` counting as one;
- they state no effects, or the same kinds of effect (a closure for a closure);
- both state a start and an end, both within 25 hours of the other's, or one
  within 25 hours and the other within 31 days when their headlines also agree
  (half their words in common, in a language both use). The 25 hours are at
  most half the shorter report: a night closure a day later is the next night's;
- one lies along the other: at least 80 % of its length (60 % under the second
  date rule) within 15 m of the other, and, unless one is a point, the smaller
  covers at least 30 % of the larger. A ramp or a short section inside a long
  corridor record of the same works is another element of it and stays;
- a point, which covers nothing, also has an agreeing headline and names no
  other road than the other report.

The report covering the other survives, so a section folds into the whole. A
report carrying restriction evidence (an effect not completely read, or with
unknown vehicles) is never dropped, and two such reports never fold.

The rules come from 1,442 candidate pairs of 34 live feeds labelled by hand on
2026-10-28 (Sachsen's SPERRINFOSYS against Dresden, Leipzig, Chemnitz and the
Autobahn GmbH; the Autobahn GmbH against Berlin, München, Frankfurt and NRW
cities; MobiData BW against Stuttgart, Freiburg and Karlsruhe). They find 96 of
the 140 duplicates and 84 of the 192 reports covering part of another, against
3 of the 1,109 pairs describing different measures at one site: Dresden half
closures on a segment the state file lists as fully closed.

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
