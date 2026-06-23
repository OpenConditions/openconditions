# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""HTTP contract tests for the resolver service.

The `get_reader` dependency is overridden with the in-memory sample graph so
the FastAPI layer runs the real matcher without a database. These assert the
wire contract that `@openconditions/openlr`'s `MapMatchClient` depends on.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient
from openlr import Coordinates
from openlr_dereferencer.maps.wgs84 import bearing as wgs_bearing, distance

from app.service import app
from tests.conftest import NODE_A, NODE_B, NODE_C


def _bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.degrees(wgs_bearing(Coordinates(*a), Coordinates(*b))) % 360


def _lrp(lon, lat, bearing, frc, fow, lfrcnp, dnp, is_last, seq) -> dict:
    return {
        "sequenceNumber": seq,
        "longitude": lon,
        "latitude": lat,
        "frc": frc,
        "fow": fow,
        "lfrcnp": lfrcnp,
        "bearing": bearing,
        "distanceToNext": dnp,
        "isLast": is_last,
    }


def _ab_c_location() -> dict:
    dnp = distance(Coordinates(*NODE_A), Coordinates(*NODE_B)) + distance(
        Coordinates(*NODE_B), Coordinates(*NODE_C)
    )
    return {
        "type": "line",
        "points": [
            _lrp(*NODE_A, _bearing_deg(NODE_A, NODE_B), 3, 3, 3, dnp, False, 1),
            _lrp(*NODE_C, _bearing_deg(NODE_C, NODE_B), 3, 3, 7, 0, True, 2),
        ],
        "positiveOffset": 0.0,
        "negativeOffset": 0.0,
    }


@pytest.fixture
def client(sample_graph) -> TestClient:
    original = app.state.reader_provider
    app.state.reader_provider = lambda: sample_graph
    yield TestClient(app)
    app.state.reader_provider = original


def test_health(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_resolve_location_returns_geometry(client: TestClient) -> None:
    res = client.post("/resolve", json={"location": _ab_c_location()})

    assert res.status_code == 200
    body = res.json()
    assert body["geometry"]["type"] == "LineString"
    coords = body["geometry"]["coordinates"]
    assert coords[0][0] == pytest.approx(NODE_A[0], abs=1e-4)
    assert coords[-1][0] == pytest.approx(NODE_C[0], abs=1e-4)
    assert 0.0 <= body["confidence"] <= 1.0
    assert body["confidence"] > 0.5


def test_resolve_unmatchable_location_returns_404(client: TestClient) -> None:
    far = {
        "type": "line",
        "points": [
            _lrp(0.0, 0.0, 90.0, 3, 3, 3, 1000.0, False, 1),
            _lrp(0.01, 0.0, 270.0, 3, 3, 7, 0, True, 2),
        ],
        "positiveOffset": 0.0,
        "negativeOffset": 0.0,
    }
    res = client.post("/resolve", json={"location": far})

    assert res.status_code == 404
    assert res.json()["detail"]["error"] == "no_match"


def test_resolve_base64_openlr_returns_geometry(client: TestClient) -> None:
    # A real OpenLR binary encoding the A->C line location, decoded server-side.
    openlr_binary = _encode_ab_c_binary()

    res = client.post("/resolve", json={"openlr": openlr_binary})

    assert res.status_code == 200
    coords = res.json()["geometry"]["coordinates"]
    assert coords[0][0] == pytest.approx(NODE_A[0], abs=1e-3)
    assert coords[-1][0] == pytest.approx(NODE_C[0], abs=1e-3)


def test_resolve_requires_location_or_openlr(client: TestClient) -> None:
    res = client.post("/resolve", json={})
    assert res.status_code == 400


def test_invalid_body_is_400_even_without_a_reader() -> None:
    # The reader provider raises (as it would with no DATABASE_URL); a malformed
    # body must still be rejected with 400 before the reader is consulted.
    def boom():
        raise RuntimeError("DATABASE_URL environment variable is required")

    original = app.state.reader_provider
    app.state.reader_provider = boom
    try:
        res = TestClient(app).post("/resolve", json={})
    finally:
        app.state.reader_provider = original

    assert res.status_code == 400


def _encode_ab_c_binary() -> str:
    from openlr import FRC, FOW, LineLocationReference, LocationReferencePoint, binary_encode

    dnp = distance(Coordinates(*NODE_A), Coordinates(*NODE_B)) + distance(
        Coordinates(*NODE_B), Coordinates(*NODE_C)
    )
    first = LocationReferencePoint(
        *NODE_A, FRC.FRC3, FOW.SINGLE_CARRIAGEWAY, round(_bearing_deg(NODE_A, NODE_B)),
        FRC.FRC3, round(dnp),
    )
    last = LocationReferencePoint(
        *NODE_C, FRC.FRC3, FOW.SINGLE_CARRIAGEWAY, round(_bearing_deg(NODE_C, NODE_B)),
        FRC.FRC7, 0,
    )
    return binary_encode(LineLocationReference([first, last], 0.0, 0.0))
