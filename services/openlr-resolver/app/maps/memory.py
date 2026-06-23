# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""An in-memory `MapReader` over an explicit directed-line graph.

This reader holds the whole graph in process. It backs the deterministic
matching tests and documents the contract every `MapReader` must satisfy
without any database dependency. The PostGIS reader implements the same
interface against a persisted graph.

Each `Line` is a single directed edge between two nodes with a straight-line
geometry; this is sufficient for the decoder, which treats the geometry as a
shapely `LineString` regardless of how many vertices it has.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Hashable, Iterable

from openlr import Coordinates
from openlr import FRC as OpenlrFRC, FOW as OpenlrFOW
from shapely.geometry import LineString, Point

from openlr_dereferencer.maps import MapReader
from openlr_dereferencer.maps import Line as AbstractLine, Node as AbstractNode
from openlr_dereferencer.maps.wgs84 import distance, line_string_length

from ..frc_fow import Frc, Fow


@dataclass(frozen=True)
class NodeSpec:
    """Plain description of a graph node."""

    node_id: int
    lon: float
    lat: float


@dataclass(frozen=True)
class LineSpec:
    """Plain description of a directed graph edge between two nodes.

    `geometry` is an optional explicit vertex list (lon, lat). When omitted the
    edge is a straight line between its start and end node.
    """

    line_id: int
    start: int
    end: int
    frc: Frc
    fow: Fow
    geometry: tuple[tuple[float, float], ...] | None = None


class _Line(AbstractLine):
    def __init__(self, reader: "InMemoryMap", spec: LineSpec) -> None:
        self._reader = reader
        self._spec = spec

    @property
    def line_id(self) -> Hashable:
        return self._spec.line_id

    @property
    def start_node(self) -> "_Node":
        return self._reader.get_node(self._spec.start)

    @property
    def end_node(self) -> "_Node":
        return self._reader.get_node(self._spec.end)

    @property
    def frc(self) -> OpenlrFRC:
        return OpenlrFRC(int(self._spec.frc))

    @property
    def fow(self) -> OpenlrFOW:
        return OpenlrFOW(int(self._spec.fow))

    @property
    def geometry(self) -> LineString:
        if self._spec.geometry is not None:
            return LineString(self._spec.geometry)
        start = self._reader.nodes[self._spec.start]
        end = self._reader.nodes[self._spec.end]
        return LineString([(start.lon, start.lat), (end.lon, end.lat)])

    @property
    def length(self) -> float:
        return line_string_length(self.geometry)

    def distance_to(self, coord: Coordinates) -> float:
        geom = self.geometry
        projected = geom.interpolate(geom.project(Point(coord.lon, coord.lat)))
        nearest = Coordinates(projected.x, projected.y)
        return distance(nearest, coord)


class _Node(AbstractNode):
    def __init__(self, reader: "InMemoryMap", spec: NodeSpec) -> None:
        self._reader = reader
        self._spec = spec

    @property
    def node_id(self) -> Hashable:
        return self._spec.node_id

    @property
    def coordinates(self) -> Coordinates:
        return Coordinates(self._spec.lon, self._spec.lat)

    def outgoing_lines(self) -> Iterable[_Line]:
        for spec in self._reader.lines.values():
            if spec.start == self._spec.node_id:
                yield _Line(self._reader, spec)

    def incoming_lines(self) -> Iterable[_Line]:
        for spec in self._reader.lines.values():
            if spec.end == self._spec.node_id:
                yield _Line(self._reader, spec)

    def connected_lines(self) -> Iterable[_Line]:
        yield from self.incoming_lines()
        yield from self.outgoing_lines()


class InMemoryMap(MapReader):
    """A `MapReader` over an in-memory directed-line graph."""

    def __init__(self, nodes: dict[int, NodeSpec], lines: dict[int, LineSpec]) -> None:
        self.nodes = nodes
        self.lines = lines

    def get_line(self, line_id: Hashable) -> _Line:
        return _Line(self, self.lines[int(line_id)])

    def get_lines(self) -> Iterable[_Line]:
        for spec in self.lines.values():
            yield _Line(self, spec)

    def get_linecount(self) -> int:
        return len(self.lines)

    def get_node(self, node_id: Hashable) -> _Node:
        return _Node(self, self.nodes[int(node_id)])

    def get_nodes(self) -> Iterable[_Node]:
        for spec in self.nodes.values():
            yield _Node(self, spec)

    def get_nodecount(self) -> int:
        return len(self.nodes)

    def find_nodes_close_to(self, coord: Coordinates, dist: float) -> Iterable[_Node]:
        for spec in self.nodes.values():
            if distance(Coordinates(spec.lon, spec.lat), coord) <= dist:
                yield _Node(self, spec)

    def find_lines_close_to(self, coord: Coordinates, dist: float) -> Iterable[_Line]:
        for spec in self.lines.values():
            line = _Line(self, spec)
            if line.distance_to(coord) <= dist:
                yield line
