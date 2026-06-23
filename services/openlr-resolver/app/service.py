# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""FastAPI application exposing the OpenLR resolver.

The HTTP layer is intentionally thin: it validates the request, builds an
`openlr` reference, delegates to `matcher.match`, and shapes the response. The
`MapReader` is provided through a FastAPI dependency so the engine can run
against the PostGIS graph in production and an injected graph under test.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from .matcher import NoMatchError, match
from .maps.postgis import get_reader
from .models import ResolveRequest, ResolveResponse
from .reference import decode_base64, location_to_reference

app = FastAPI(title="openlr-resolver", version="0.1.0")


def reader_provider():
    """Return the active `MapReader`.

    Defined as an attribute on the app so tests can swap in an in-memory graph
    without a database. Production uses the PostGIS reader.
    """

    return get_reader()


app.state.reader_provider = reader_provider


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/resolve", response_model=ResolveResponse)
def resolve(request: ResolveRequest) -> ResolveResponse:
    # Validate the request shape before touching the (database-backed) reader,
    # so a malformed body is a 400 rather than a connection error.
    if request.location is not None:
        reference = location_to_reference(request.location)
    elif request.openlr is not None:
        try:
            reference = decode_base64(request.openlr)
        except Exception as exc:  # noqa: BLE001 - any decode failure is a bad request
            raise HTTPException(status_code=400, detail=f"Invalid OpenLR binary: {exc}")
    else:
        raise HTTPException(
            status_code=400,
            detail="Request must include either 'location' or 'openlr'",
        )

    reader = app.state.reader_provider()

    try:
        result = match(reference, reader)
    except NoMatchError as exc:
        raise HTTPException(status_code=404, detail={"error": "no_match", "reason": str(exc)})

    return ResolveResponse(geometry=result.geometry, confidence=result.confidence)
