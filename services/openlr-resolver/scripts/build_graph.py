#!/usr/bin/env python3
# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Build the OpenLR map-matching graph in PostGIS from an OSM extract.

Reads an ``.osm.pbf`` (or ``.osm`` XML) file with pyosmium, keeps drivable
``highway=*`` ways, classifies each into an OpenLR Functional Road Class and
Form of Way (see :mod:`app.frc_fow`), and loads two tables:

* ``conditions.osm_nodes`` — every node referenced by a kept way.
* ``conditions.osm_lines`` — one **directed** edge per consecutive node pair of
  a kept way. Bidirectional ways produce both a forward and a reversed edge so
  travel direction is always explicit, which OpenLR matching requires.

Both tables get a GiST index on ``geom``.

Usage::

    python -m scripts.build_graph --pbf <extract.osm.pbf> --database-url <url>

The ``DATABASE_URL`` environment variable is used when ``--database-url`` is
omitted. See ``README.md`` for the full Geofabrik extract command; this script
itself never downloads anything.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field

import osmium
import psycopg

from app.frc_fow import classify, is_oneway, is_reversed_oneway


@dataclass
class Graph:
    """Accumulated nodes and directed edges, ready to load into PostGIS."""

    # node_id -> (lon, lat)
    nodes: dict[int, tuple[float, float]] = field(default_factory=dict)
    # (way_id, start_node, end_node, frc, fow, oneway, wkt)
    edges: list[tuple[int, int, int, int, int, bool, str]] = field(default_factory=list)


class _RoadHandler(osmium.SimpleHandler):
    """Collects drivable ways and the nodes they reference."""

    def __init__(self, graph: Graph) -> None:
        super().__init__()
        self.graph = graph

    def way(self, way: "osmium.osm.Way") -> None:
        tags = {tag.k: tag.v for tag in way.tags}
        classified = classify(tags)
        if classified is None:
            return
        frc, fow = classified

        coords: list[tuple[int, float, float]] = []
        for node in way.nodes:
            if node.location.valid():
                coords.append((node.ref, node.location.lon, node.location.lat))
        if len(coords) < 2:
            return

        oneway = is_oneway(tags)
        reversed_dir = is_reversed_oneway(tags)
        if reversed_dir:
            coords.reverse()

        for node_id, lon, lat in coords:
            self.graph.nodes[node_id] = (lon, lat)

        for (a_id, a_lon, a_lat), (b_id, b_lon, b_lat) in zip(coords, coords[1:]):
            wkt = f"LINESTRING({a_lon} {a_lat}, {b_lon} {b_lat})"
            self.graph.edges.append((way.id, a_id, b_id, int(frc), int(fow), oneway, wkt))
            if not oneway:
                rwkt = f"LINESTRING({b_lon} {b_lat}, {a_lon} {a_lat})"
                self.graph.edges.append(
                    (way.id, b_id, a_id, int(frc), int(fow), oneway, rwkt)
                )


def build_graph(osm_path: str) -> Graph:
    """Parse an OSM file into an in-memory :class:`Graph`."""

    graph = Graph()
    handler = _RoadHandler(graph)
    # `locations=True` makes pyosmium attach node coordinates to way nodes.
    handler.apply_file(osm_path, locations=True)
    return graph


DDL = """
CREATE SCHEMA IF NOT EXISTS conditions;

DROP TABLE IF EXISTS conditions.osm_lines;
DROP TABLE IF EXISTS conditions.osm_nodes;

CREATE TABLE conditions.osm_nodes (
    node_id BIGINT PRIMARY KEY,
    geom geometry(Point, 4326) NOT NULL
);

CREATE TABLE conditions.osm_lines (
    line_id BIGSERIAL PRIMARY KEY,
    way_id BIGINT NOT NULL,
    start_node BIGINT NOT NULL,
    end_node BIGINT NOT NULL,
    frc SMALLINT NOT NULL,
    fow SMALLINT NOT NULL,
    oneway BOOLEAN NOT NULL,
    geom geometry(LineString, 4326) NOT NULL
);
"""

INDEXES = """
CREATE INDEX osm_nodes_geom_idx ON conditions.osm_nodes USING GIST (geom);
CREATE INDEX osm_lines_geom_idx ON conditions.osm_lines USING GIST (geom);
CREATE INDEX osm_lines_start_idx ON conditions.osm_lines (start_node);
CREATE INDEX osm_lines_end_idx ON conditions.osm_lines (end_node);
"""


def load_into_postgis(graph: Graph, database_url: str) -> tuple[int, int]:
    """Create the schema and bulk-load the graph. Returns (node_count, edge_count)."""

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS postgis")
            cur.execute(DDL)

            with cur.copy(
                "COPY conditions.osm_nodes (node_id, geom) FROM STDIN"
            ) as copy:
                for node_id, (lon, lat) in graph.nodes.items():
                    copy.write_row((node_id, f"SRID=4326;POINT({lon} {lat})"))

            with cur.copy(
                "COPY conditions.osm_lines "
                "(way_id, start_node, end_node, frc, fow, oneway, geom) FROM STDIN"
            ) as copy:
                for way_id, a, b, frc, fow, oneway, wkt in graph.edges:
                    copy.write_row((way_id, a, b, frc, fow, oneway, f"SRID=4326;{wkt}"))

            cur.execute(INDEXES)
        conn.commit()

    return len(graph.nodes), len(graph.edges)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", required=True, help="Path to the .osm.pbf or .osm file")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="PostGIS connection URL (defaults to $DATABASE_URL)",
    )
    args = parser.parse_args(argv)

    if not args.database_url:
        parser.error("--database-url or $DATABASE_URL is required")

    print(f"[build-graph] reading {args.pbf}", file=sys.stderr)
    graph = build_graph(args.pbf)
    print(
        f"[build-graph] parsed {len(graph.nodes)} nodes, {len(graph.edges)} edges",
        file=sys.stderr,
    )
    nodes, edges = load_into_postgis(graph, args.database_url)
    print(f"[build-graph] loaded {nodes} nodes, {edges} edges into PostGIS", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
