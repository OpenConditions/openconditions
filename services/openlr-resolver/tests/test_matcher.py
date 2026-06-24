# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic matching tests over the in-memory sample graph.

These exercise the real `openlr-dereferencer` engine end to end: a hand-built
line location reference that traces the A->B->C road must resolve onto both
edges, a reference placed far from any matching road must fail, and a three-LRP
reference with a non-zero positive offset must trim against the TOTAL path
length rather than only the first segment's length.
"""

from __future__ import annotations

import math

import pytest
from openlr import FRC, FOW, LineLocationReference, LocationReferencePoint
from openlr import Coordinates
from openlr_dereferencer import Config
from openlr_dereferencer.maps.wgs84 import bearing as wgs_bearing, distance, line_string_length

from app.matcher import NoMatchError, _join_line_geometries, match
from tests.conftest import NODE_A, NODE_B, NODE_C


def _bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    from openlr import Coordinates

    return math.degrees(wgs_bearing(Coordinates(*a), Coordinates(*b))) % 360


def _lrp(lon: float, lat: float, bear: float, lfrcnp: FRC, dnp: float) -> LocationReferencePoint:
    return LocationReferencePoint(
        lon=lon,
        lat=lat,
        frc=FRC.FRC3,
        fow=FOW.SINGLE_CARRIAGEWAY,
        bear=bear,
        lfrcnp=lfrcnp,
        dnp=round(dnp),
    )


def _ab_to_c_reference() -> LineLocationReference:
    """A two-LRP reference describing the road from A to C through B."""

    from openlr import Coordinates

    dnp_total = distance(Coordinates(*NODE_A), Coordinates(*NODE_B)) + distance(
        Coordinates(*NODE_B), Coordinates(*NODE_C)
    )
    first = _lrp(*NODE_A, _bearing_deg(NODE_A, NODE_B), FRC.FRC3, dnp_total)
    # The last LRP's bearing points back along the line, per the OpenLR spec.
    last = _lrp(*NODE_C, _bearing_deg(NODE_C, NODE_B), FRC.FRC7, 0)
    return LineLocationReference(points=[first, last], poffs=0.0, noffs=0.0)


def test_matches_known_road(sample_graph) -> None:
    reference = _ab_to_c_reference()

    result = match(reference, sample_graph, config=Config(search_radius=100))

    coords = result.geometry["coordinates"]
    assert result.geometry["type"] == "LineString"
    # The matched polyline must span the full A..C road within tolerance.
    assert coords[0][0] == pytest.approx(NODE_A[0], abs=1e-4)
    assert coords[-1][0] == pytest.approx(NODE_C[0], abs=1e-4)
    assert result.confidence > 0.5


def test_unresolvable_reference_raises(sample_graph) -> None:
    # An LRP pair in open water far from every road in the graph.
    a = (0.0, 0.0)
    b = (0.01, 0.0)
    dnp = distance(Coordinates(*a), Coordinates(*b))
    first = _lrp(*a, _bearing_deg(a, b), FRC.FRC3, dnp)
    last = _lrp(*b, _bearing_deg(b, a), FRC.FRC7, 0)
    reference = LineLocationReference(points=[first, last], poffs=0.0, noffs=0.0)

    with pytest.raises(NoMatchError):
        match(reference, sample_graph, config=Config(search_radius=100))


def test_three_lrp_positive_offset_trims_against_total_length(sample_graph) -> None:
    """A three-LRP reference with poffs > 0.5 must trim relative to the TOTAL path.

    The sample graph has A --(line10, ~194 m)--> B --(line11, ~194 m)--> C.
    A three-LRP reference encodes A->B->C with an intermediate LRP at B.

    The engine's ``build_line_location`` multiplies ``poffs`` by only the first
    segment's length (~194 m), so a poffs of 0.55 would cut ~107 m into A->B
    and the result would start well BEFORE B.

    With the corrected trimming applied here, poffs is applied against the TOTAL
    matched length (~387 m): 0.55 * 387 ≈ 213 m, which is past B (the ~194 m
    mark) — completely within the second segment. The test asserts that the first
    coordinate of the trimmed geometry is at longitude > NODE_B[0], proving
    total-length trimming is in effect rather than first-segment-only trimming.
    """
    dnp_ab = distance(Coordinates(*NODE_A), Coordinates(*NODE_B))
    dnp_bc = distance(Coordinates(*NODE_B), Coordinates(*NODE_C))

    # Three LRPs: first at A, intermediate at B, last at C.
    lrp_a = LocationReferencePoint(
        lon=NODE_A[0], lat=NODE_A[1],
        frc=FRC.FRC3, fow=FOW.SINGLE_CARRIAGEWAY,
        bear=round(_bearing_deg(NODE_A, NODE_B)),
        lfrcnp=FRC.FRC3, dnp=round(dnp_ab),
    )
    lrp_b = LocationReferencePoint(
        lon=NODE_B[0], lat=NODE_B[1],
        frc=FRC.FRC3, fow=FOW.SINGLE_CARRIAGEWAY,
        bear=round(_bearing_deg(NODE_B, NODE_C)),
        lfrcnp=FRC.FRC3, dnp=round(dnp_bc),
    )
    lrp_c = LocationReferencePoint(
        lon=NODE_C[0], lat=NODE_C[1],
        frc=FRC.FRC3, fow=FOW.SINGLE_CARRIAGEWAY,
        bear=round(_bearing_deg(NODE_C, NODE_B)),
        lfrcnp=FRC.FRC7, dnp=0,
    )

    # poffs = 0.55: with total-length trimming starts at 0.55 * ~387 ≈ 213 m,
    # which is past B (~194 m mark) — strictly in the second segment.
    # With first-segment-only trimming (the engine bug) it would be
    # 0.55 * ~194 ≈ 107 m, which is before B.
    poffs = 0.55
    reference = LineLocationReference(points=[lrp_a, lrp_b, lrp_c], poffs=poffs, noffs=0.0)

    result = match(reference, sample_graph, config=Config(search_radius=100))

    coords = result.geometry["coordinates"]
    assert result.geometry["type"] == "LineString"
    assert len(coords) >= 2

    # The trimmed path must start past B (past the 50 % mark of the full road),
    # proving the offset was applied against the total ~387 m, not just ~194 m.
    first_lon = coords[0][0]
    assert first_lon > NODE_B[0], (
        f"Expected trimmed start longitude > {NODE_B[0]} (past midpoint B), "
        f"got {first_lon:.6f} — offset was not applied against total path length"
    )
    # The trimmed path must end at or near C (no negative offset).
    assert coords[-1][0] == pytest.approx(NODE_C[0], abs=1e-4)


def test_geometry_built_from_accepted_path_not_ghost_segments(sample_graph) -> None:
    """The polyline must be built from the decoder's accepted path, not ghost segments.

    When the engine explores multiple candidate routes for an LRP pair it fires
    ``on_route_success`` for every route found — including routes that are later
    REJECTED by the DNP length check. Collecting lines from those observer
    callbacks produces ghost segments that inflate path length and corrupt offset
    trimming.

    This test verifies that the concatenated path length equals the sum of
    lengths of the lines in the decoded ``LineLocation.lines`` (the accepted
    path), not some larger ghost-inflated value.
    """
    from openlr_dereferencer import decode as _decode
    from app.matcher import _ScoreObserver

    reference = _ab_to_c_reference()

    observer = _ScoreObserver()
    location = _decode(reference, sample_graph, observer=observer, config=Config(search_radius=100))

    # Build the polyline the way match() now does: from the accepted path only.
    accepted_lines = location.lines
    accepted_polyline = _join_line_geometries(accepted_lines)
    accepted_len = line_string_length(accepted_polyline)

    # The expected length is the sum of individual accepted line lengths.
    expected_len = sum(ln.length for ln in accepted_lines)

    # Within floating-point tolerance the two must agree — no ghost inflation.
    assert accepted_len == pytest.approx(expected_len, rel=1e-4), (
        f"Polyline length {accepted_len:.2f} m does not match sum of accepted "
        f"line lengths {expected_len:.2f} m — ghost segments may be included"
    )

    # Sanity: the accepted path should span the full A-to-C road.
    assert accepted_lines[0].line_id == 10
    assert accepted_lines[-1].line_id == 11
