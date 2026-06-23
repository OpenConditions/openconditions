# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""A PostGIS-backed `MapReader` over the OSM-derived road graph.

The graph lives in two tables, populated by ``scripts/build_graph.py``:

* ``conditions.osm_nodes(node_id BIGINT PRIMARY KEY, geom geometry(Point,4326))``
* ``conditions.osm_lines(line_id BIGINT PRIMARY KEY, way_id BIGINT,
  start_node BIGINT, end_node BIGINT, frc SMALLINT, fow SMALLINT,
  oneway BOOLEAN, geom geometry(LineString,4326))``

Each row in ``osm_lines`` is one **directed** edge: a one-way OSM way yields a
single line, a bidirectional way yields two (forward and reversed). The line's
``start_node``/``end_node`` therefore always describe travel direction, which is
what OpenLR matching requires.

Spatial proximity queries use ``geography`` casts so radii are in metres,
matching the units the decoder works in.
"""

from __future__ import annotations

import os
from typing import Hashable, Iterable

from psycopg_pool import ConnectionPool
from openlr import Coordinates
from openlr import FRC as OpenlrFRC, FOW as OpenlrFOW
from shapely import wkb
from shapely.geometry import LineString, Point

from openlr_dereferencer.maps import MapReader
from openlr_dereferencer.maps import Line as AbstractLine, Node as AbstractNode
from openlr_dereferencer.maps.wgs84 import distance, line_string_length


_NODES = "conditions.osm_nodes"
_LINES = "conditions.osm_lines"


class PostgisLine(AbstractLine):
    """A directed edge loaded lazily from ``conditions.osm_lines``."""

    def __init__(self, reader: "PostgisMapReader", line_id: int) -> None:
        self._reader = reader
        self._line_id = line_id

    @property
    def line_id(self) -> Hashable:
        return self._line_id

    def _row(self) -> tuple:
        return self._reader.line_row(self._line_id)

    @property
    def start_node(self) -> "PostgisNode":
        return self._reader.get_node(self._row()[0])

    @property
    def end_node(self) -> "PostgisNode":
        return self._reader.get_node(self._row()[1])

    @property
    def frc(self) -> OpenlrFRC:
        return OpenlrFRC(self._row()[2])

    @property
    def fow(self) -> OpenlrFOW:
        return OpenlrFOW(self._row()[3])

    @property
    def geometry(self) -> LineString:
        return wkb.loads(self._row()[4])

    @property
    def length(self) -> float:
        return line_string_length(self.geometry)

    def distance_to(self, coord: Coordinates) -> float:
        geom = self.geometry
        projected = geom.interpolate(geom.project(Point(coord.lon, coord.lat)))
        return distance(Coordinates(projected.x, projected.y), coord)


class PostgisNode(AbstractNode):
    """A graph node loaded lazily from ``conditions.osm_nodes``."""

    def __init__(self, reader: "PostgisMapReader", node_id: int) -> None:
        self._reader = reader
        self._node_id = node_id

    @property
    def node_id(self) -> Hashable:
        return self._node_id

    @property
    def coordinates(self) -> Coordinates:
        lon, lat = self._reader.node_coords(self._node_id)
        return Coordinates(lon, lat)

    def outgoing_lines(self) -> Iterable[PostgisLine]:
        for (line_id,) in self._reader.query(
            f"SELECT line_id FROM {_LINES} WHERE start_node = %s", (self._node_id,)
        ):
            yield PostgisLine(self._reader, line_id)

    def incoming_lines(self) -> Iterable[PostgisLine]:
        for (line_id,) in self._reader.query(
            f"SELECT line_id FROM {_LINES} WHERE end_node = %s", (self._node_id,)
        ):
            yield PostgisLine(self._reader, line_id)

    def connected_lines(self) -> Iterable[PostgisLine]:
        yield from self.incoming_lines()
        yield from self.outgoing_lines()


class PostgisMapReader(MapReader):
    """A `MapReader` over the PostGIS road graph."""

    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def query(self, sql: str, params: tuple = ()) -> list[tuple]:
        with self._pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return cur.fetchall()

    def line_row(self, line_id: int) -> tuple:
        rows = self.query(
            f"SELECT start_node, end_node, frc, fow, geom "
            f"FROM {_LINES} WHERE line_id = %s",
            (line_id,),
        )
        if not rows:
            raise KeyError(f"line {line_id} not found")
        return rows[0]

    def node_coords(self, node_id: int) -> tuple[float, float]:
        rows = self.query(
            f"SELECT ST_X(geom), ST_Y(geom) FROM {_NODES} WHERE node_id = %s",
            (node_id,),
        )
        if not rows:
            raise KeyError(f"node {node_id} not found")
        return rows[0]

    def get_line(self, line_id: Hashable) -> PostgisLine:
        return PostgisLine(self, int(line_id))

    def get_lines(self) -> Iterable[PostgisLine]:
        for (line_id,) in self.query(f"SELECT line_id FROM {_LINES}"):
            yield PostgisLine(self, line_id)

    def get_linecount(self) -> int:
        return self.query(f"SELECT COUNT(*) FROM {_LINES}")[0][0]

    def get_node(self, node_id: Hashable) -> PostgisNode:
        return PostgisNode(self, int(node_id))

    def get_nodes(self) -> Iterable[PostgisNode]:
        for (node_id,) in self.query(f"SELECT node_id FROM {_NODES}"):
            yield PostgisNode(self, node_id)

    def get_nodecount(self) -> int:
        return self.query(f"SELECT COUNT(*) FROM {_NODES}")[0][0]

    def find_nodes_close_to(self, coord: Coordinates, dist: float) -> Iterable[PostgisNode]:
        rows = self.query(
            f"SELECT node_id FROM {_NODES} "
            f"WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)",
            (coord.lon, coord.lat, dist),
        )
        for (node_id,) in rows:
            yield PostgisNode(self, node_id)

    def find_lines_close_to(self, coord: Coordinates, dist: float) -> Iterable[PostgisLine]:
        rows = self.query(
            f"SELECT line_id FROM {_LINES} "
            f"WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)",
            (coord.lon, coord.lat, dist),
        )
        for (line_id,) in rows:
            yield PostgisLine(self, line_id)


_pool: ConnectionPool | None = None


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL environment variable is required")
        _pool = ConnectionPool(url, min_size=1, max_size=5, open=True)
    return _pool


def get_reader() -> PostgisMapReader:
    """FastAPI dependency yielding the process-wide PostGIS map reader."""

    return PostgisMapReader(_get_pool())
