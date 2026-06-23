# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Wire models for the resolver HTTP contract.

These mirror the `OpenLrLocation` shape produced by the `@openconditions/openlr`
TypeScript decoder, so a record decoded upstream can be POSTed verbatim.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class LrpPoint(BaseModel):
    """A single Location Reference Point from a decoded OpenLR line location."""

    sequenceNumber: int
    longitude: float
    latitude: float
    frc: int = Field(ge=0, le=7)
    fow: int = Field(ge=0, le=7)
    lfrcnp: int | None = Field(default=None, ge=0, le=7)
    bearing: float
    distanceToNext: float
    isLast: bool


class OpenLrLocation(BaseModel):
    """A decoded OpenLR line location reference."""

    type: Literal["line"] = "line"
    points: list[LrpPoint] = Field(min_length=2)
    positiveOffset: float = 0.0
    negativeOffset: float = 0.0


class ResolveRequest(BaseModel):
    """Resolve request body.

    Exactly one of `location` (a pre-decoded location) or `openlr` (a base64
    OpenLR binary, decoded server-side) must be provided.
    """

    location: OpenLrLocation | None = None
    openlr: str | None = None


class ResolveResponse(BaseModel):
    """Successful resolve response: GeoJSON geometry plus a match confidence."""

    geometry: dict[str, Any]
    confidence: float = Field(ge=0.0, le=1.0)
