# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Integration test for the PostGIS-backed map reader.

Spins up a real PostGIS container, builds the graph from the tiny OSM fixture
via ``scripts/build_graph.py``, then map-matches a known reference through
``PostgisMapReader``. This proves the database reader is wired correctly end to
end, not just the in-memory one. Skipped when Docker is unavailable.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

docker_available = True
try:
    from testcontainers.postgres import PostgresContainer
except Exception:  # pragma: no cover - import guard
    docker_available = False

from openlr import Coordinates, FRC, FOW, LineLocationReference, LocationReferencePoint
from openlr_dereferencer import Config
from openlr_dereferencer.maps.wgs84 import bearing as wgs_bearing, distance

from app.matcher import NoMatchError, match

FIXTURE = Path(__file__).parent / "fixtures" / "tiny_roads.osm"

# Matches the secondary road A-B-C in tiny_roads.osm.
NODE_A = (8.0000, 50.0000)
NODE_B = (8.0027, 50.0000)
NODE_C = (8.0054, 50.0000)


def _bearing_deg(a, b) -> float:
    return math.degrees(wgs_bearing(Coordinates(*a), Coordinates(*b))) % 360


def _is_docker_running() -> bool:
    if not docker_available:
        return False
    try:
        import docker

        docker.from_env().ping()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _is_docker_running(), reason="Docker not available for PostGIS testcontainer"
)


@pytest.fixture(scope="module")
def pg_reader():
    from app.maps.postgis import PostgisMapReader
    from psycopg_pool import ConnectionPool
    from scripts.build_graph import build_graph, load_into_postgis

    with PostgresContainer("postgis/postgis:16-3.4", driver=None) as pg:
        url = pg.get_connection_url()
        graph = build_graph(str(FIXTURE))
        nodes, edges = load_into_postgis(graph, url)
        assert nodes > 0 and edges > 0

        pool = ConnectionPool(url, min_size=1, max_size=3, open=True)
        try:
            yield PostgisMapReader(pool)
        finally:
            pool.close()


def test_postgis_reader_loads_graph(pg_reader) -> None:
    # The fixture's secondary road is bidirectional (4 directed edges) plus the
    # one-way residential street (1 edge) = 5 lines; 5 referenced nodes.
    assert pg_reader.get_linecount() == 5
    assert pg_reader.get_nodecount() == 5


def test_postgis_reader_matches_known_road(pg_reader) -> None:
    dnp = distance(Coordinates(*NODE_A), Coordinates(*NODE_B)) + distance(
        Coordinates(*NODE_B), Coordinates(*NODE_C)
    )
    first = LocationReferencePoint(
        *NODE_A, FRC.FRC3, FOW.SINGLE_CARRIAGEWAY, _bearing_deg(NODE_A, NODE_B),
        FRC.FRC3, round(dnp),
    )
    last = LocationReferencePoint(
        *NODE_C, FRC.FRC3, FOW.SINGLE_CARRIAGEWAY, _bearing_deg(NODE_C, NODE_B),
        FRC.FRC7, 0,
    )
    reference = LineLocationReference([first, last], 0.0, 0.0)

    result = match(reference, pg_reader, config=Config(search_radius=100))

    coords = result.geometry["coordinates"]
    assert coords[0][0] == pytest.approx(NODE_A[0], abs=1e-3)
    assert coords[-1][0] == pytest.approx(NODE_C[0], abs=1e-3)
    assert result.confidence > 0.5


def test_postgis_reader_rejects_far_reference(pg_reader) -> None:
    a = (0.0, 0.0)
    b = (0.01, 0.0)
    dnp = distance(Coordinates(*a), Coordinates(*b))
    first = LocationReferencePoint(
        *a, FRC.FRC3, FOW.SINGLE_CARRIAGEWAY, _bearing_deg(a, b), FRC.FRC3, round(dnp)
    )
    last = LocationReferencePoint(
        *b, FRC.FRC3, FOW.SINGLE_CARRIAGEWAY, _bearing_deg(b, a), FRC.FRC7, 0
    )
    reference = LineLocationReference([first, last], 0.0, 0.0)

    with pytest.raises(NoMatchError):
        match(reference, pg_reader, config=Config(search_radius=100))
