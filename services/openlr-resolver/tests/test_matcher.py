# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic matching tests over the in-memory sample graph.

These exercise the real `openlr-dereferencer` engine end to end: a hand-built
line location reference that traces the A->B->C road must resolve onto both
edges, a reference placed far from any matching road must fail, and the offsets
of a three-LRP reference must trim against the first and last LRP-to-LRP paths
(OpenLR whitepaper v1.5 rev2, Rule 5 and section 7.5.2).
"""

from __future__ import annotations

import math

import pytest
from openlr import FRC, FOW, LineLocationReference, LocationReferencePoint
from openlr import Coordinates
from openlr_dereferencer import Config
from openlr_dereferencer import decode
from openlr_dereferencer.maps.wgs84 import bearing as wgs_bearing, distance

from app.matcher import NoMatchError, match
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


def _abc_three_lrp_reference(poffs: float, noffs: float) -> LineLocationReference:
    """A three-LRP reference along A->B->C with an intermediate LRP at B."""

    dnp_ab = distance(Coordinates(*NODE_A), Coordinates(*NODE_B))
    dnp_bc = distance(Coordinates(*NODE_B), Coordinates(*NODE_C))
    lrp_a = _lrp(*NODE_A, round(_bearing_deg(NODE_A, NODE_B)), FRC.FRC3, dnp_ab)
    lrp_b = _lrp(*NODE_B, round(_bearing_deg(NODE_B, NODE_C)), FRC.FRC3, dnp_bc)
    lrp_c = _lrp(*NODE_C, round(_bearing_deg(NODE_C, NODE_B)), FRC.FRC7, 0)
    return LineLocationReference(points=[lrp_a, lrp_b, lrp_c], poffs=poffs, noffs=noffs)


def test_three_lrp_positive_offset_trims_against_first_lrp_path(sample_graph) -> None:
    """The positive offset is a share of the path between the first two LRPs.

    The sample graph has A --(line 10, ~193 m)--> B --(line 11, ~193 m)--> C.
    A positive offset of 0.55 is 0.55 * ~193 m = ~106 m into A->B, so the
    location starts before B. Measuring against the ~386 m total would wrongly
    start it past B.
    """
    reference = _abc_three_lrp_reference(poffs=0.55, noffs=0.0)

    result = match(reference, sample_graph, config=Config(search_radius=100))

    coords = result.geometry["coordinates"]
    assert result.geometry["type"] == "LineString"
    # The road runs due east, so longitude is proportional to distance along it.
    expected_start_lon = NODE_A[0] + 0.55 * (NODE_B[0] - NODE_A[0])
    assert coords[0][0] == pytest.approx(expected_start_lon, abs=1e-5)
    assert coords[0][0] < NODE_B[0]
    assert coords[-1][0] == pytest.approx(NODE_C[0], abs=1e-4)


def test_three_lrp_negative_offset_trims_against_last_lrp_path(sample_graph) -> None:
    """The negative offset is a share of the path between the last two LRPs."""

    reference = _abc_three_lrp_reference(poffs=0.0, noffs=0.5)

    result = match(reference, sample_graph, config=Config(search_radius=100))

    coords = result.geometry["coordinates"]
    expected_end_lon = NODE_C[0] - 0.5 * (NODE_C[0] - NODE_B[0])
    assert coords[0][0] == pytest.approx(NODE_A[0], abs=1e-4)
    assert coords[-1][0] == pytest.approx(expected_end_lon, abs=1e-5)
    assert coords[-1][0] > NODE_B[0]


def test_geometry_is_the_decoded_location_path(sample_graph) -> None:
    """The returned geometry is the engine's offset-trimmed location path.

    It must not be rebuilt from candidate routes the engine explored and
    rejected, nor trimmed a second time after the engine applied the offsets.
    """
    reference = _abc_three_lrp_reference(poffs=0.3, noffs=0.2)
    config = Config(search_radius=100)

    location = decode(reference, sample_graph, config=config)
    result = match(reference, sample_graph, config=config)

    assert [ln.line_id for ln in location.lines] == [10, 11]
    expected = [value for c in location.coordinates() for value in (c.lon, c.lat)]
    actual = [value for pair in result.geometry["coordinates"] for value in pair]
    assert actual == pytest.approx(expected)
