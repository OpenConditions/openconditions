# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic matching tests over the in-memory sample graph.

These exercise the real `openlr-dereferencer` engine end to end: a hand-built
line location reference that traces the A->B->C road must resolve onto both
edges, and a reference placed far from any matching road must fail.
"""

from __future__ import annotations

import math

import pytest
from openlr import FRC, FOW, LineLocationReference, LocationReferencePoint
from openlr_dereferencer import Config
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
    from openlr import Coordinates

    # An LRP pair in open water far from every road in the graph.
    a = (0.0, 0.0)
    b = (0.01, 0.0)
    dnp = distance(Coordinates(*a), Coordinates(*b))
    first = _lrp(*a, _bearing_deg(a, b), FRC.FRC3, dnp)
    last = _lrp(*b, _bearing_deg(b, a), FRC.FRC7, 0)
    reference = LineLocationReference(points=[first, last], poffs=0.0, noffs=0.0)

    with pytest.raises(NoMatchError):
        match(reference, sample_graph, config=Config(search_radius=100))
