# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for OSM parsing and FRC/FOW classification (no database)."""

from __future__ import annotations

from pathlib import Path

from app.frc_fow import Frc, Fow, classify, is_oneway, is_reversed_oneway
from scripts.build_graph import build_graph

FIXTURE = Path(__file__).parent / "fixtures" / "tiny_roads.osm"


def test_classify_road_classes() -> None:
    assert classify({"highway": "motorway"}) == (Frc.FRC0, Fow.MOTORWAY)
    assert classify({"highway": "secondary"}) == (Frc.FRC3, Fow.SINGLE_CARRIAGEWAY)
    assert classify({"highway": "residential"}) == (Frc.FRC6, Fow.SINGLE_CARRIAGEWAY)
    assert classify({"highway": "motorway_link"}) == (Frc.FRC0, Fow.SLIPROAD)


def test_classify_roundabout_overrides_fow() -> None:
    frc, fow = classify({"highway": "primary", "junction": "roundabout"})
    assert frc == Frc.FRC2
    assert fow == Fow.ROUNDABOUT


def test_classify_skips_non_roads() -> None:
    assert classify({"highway": "footway"}) is None
    assert classify({"amenity": "cafe"}) is None  # no highway tag


def test_oneway_detection() -> None:
    assert is_oneway({"highway": "residential", "oneway": "yes"}) is True
    assert is_oneway({"highway": "residential"}) is False
    assert is_oneway({"highway": "primary", "junction": "roundabout"}) is True
    assert is_reversed_oneway({"oneway": "-1"}) is True
    assert is_reversed_oneway({"oneway": "yes"}) is False


def test_build_graph_emits_directed_edges() -> None:
    graph = build_graph(str(FIXTURE))

    # The footway's nodes (6, 7) must be absent; only road nodes 1-5 remain.
    assert set(graph.nodes) == {1, 2, 3, 4, 5}

    # Bidirectional secondary (way 100) -> 4 directed edges; one-way (way 200) -> 1.
    way_100 = [e for e in graph.edges if e[0] == 100]
    way_200 = [e for e in graph.edges if e[0] == 200]
    assert len(way_100) == 4
    assert len(way_200) == 1

    # Both travel directions exist for the secondary road's first segment.
    pairs = {(e[1], e[2]) for e in way_100}
    assert (1, 2) in pairs and (2, 1) in pairs

    # The one-way edge keeps its digitised direction only.
    assert way_200[0][1:3] == (4, 5)
    assert way_200[0][5] is True  # oneway flag
