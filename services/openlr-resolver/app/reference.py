# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Build an `openlr.LineLocationReference` from the wire model or a base64 binary.

The `openlr` library represents a line location as a `LineLocationReference`
of `LocationReferencePoint` namedtuples. Two conversions matter here:

* **Bearing.** `openlr-dereferencer` compares an LRP's `bear` field directly
  against a bearing it computes in degrees, so `bear` is in degrees here (the
  same unit the upstream decoder reports). It is passed through unchanged.
* **Offsets.** On the wire, positive/negative offsets are in metres. The
  `openlr` datatype expresses them as fractions in [0, 1] of the reference's
  total length, which is what `openlr-dereferencer` consumes. They are
  converted using the sum of the per-LRP distances-to-next.
"""

from __future__ import annotations

from openlr import (
    FRC,
    FOW,
    LineLocationReference,
    LocationReferencePoint,
    binary_decode,
)

from .models import LrpPoint, OpenLrLocation


def _frc(value: int | None) -> FRC:
    # A missing LFRCNP (last LRP) maps to the lowest importance class.
    return FRC(value if value is not None else FRC.FRC7)


def _to_lrp(point: LrpPoint) -> LocationReferencePoint:
    return LocationReferencePoint(
        lon=point.longitude,
        lat=point.latitude,
        frc=FRC(point.frc),
        fow=FOW(point.fow),
        bear=point.bearing,
        lfrcnp=_frc(point.lfrcnp),
        dnp=round(point.distanceToNext),
    )


def location_to_reference(location: OpenLrLocation) -> LineLocationReference:
    """Convert a wire `OpenLrLocation` into an `openlr.LineLocationReference`."""

    points = [_to_lrp(p) for p in location.points]

    total_length = sum(p.distanceToNext for p in location.points)
    poffs = _offset_fraction(location.positiveOffset, total_length)
    noffs = _offset_fraction(location.negativeOffset, total_length)

    return LineLocationReference(points=points, poffs=poffs, noffs=noffs)


def _offset_fraction(offset_m: float, total_length_m: float) -> float:
    if offset_m <= 0 or total_length_m <= 0:
        return 0.0
    return min(offset_m / total_length_m, 1.0)


def decode_base64(value: str) -> LineLocationReference:
    """Decode a base64 OpenLR binary into a `LineLocationReference`.

    Raises `ValueError` if the binary does not decode to a line location.
    """

    reference = binary_decode(value, is_base64=True)
    if not isinstance(reference, LineLocationReference):
        raise ValueError(
            f"Only line locations are supported, got {type(reference).__name__}"
        )
    return reference
