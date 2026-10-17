# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Offset conversion between the wire model and `openlr` references.

The binary vector and its decoded values come from TomTom's reference
implementation (github.com/tomtom-international/openlr,
binary/src/test/java/openlr/binary/OpenLRBinaryDecoderTest.java and Lrp.java,
Copyright TomTom International B.V., Apache-2.0). `@openconditions/openlr`
decodes it to the same LRPs and to offsets of 203 m and 101 m.
"""

from __future__ import annotations

import pytest

from app.models import LrpPoint, OpenLrLocation
from app.reference import decode_base64, location_to_reference

BOTH_OFFSETS_V3 = "CwRbWyNG9RpsCQCa/jsbtAT/6/+kK3ldYQ=="


def _wire_location(positive_offset: float, negative_offset: float) -> OpenLrLocation:
    return OpenLrLocation(
        points=[
            LrpPoint(
                sequenceNumber=1, longitude=6.12682, latitude=49.60852, frc=3, fow=2,
                lfrcnp=3, bearing=140.625, distanceToNext=557, isLast=False,
            ),
            LrpPoint(
                sequenceNumber=2, longitude=6.12836, latitude=49.60399, frc=3, fow=3,
                lfrcnp=5, bearing=230.625, distanceToNext=264, isLast=False,
            ),
            LrpPoint(
                sequenceNumber=3, longitude=6.12815, latitude=49.60307, frc=5, fow=3,
                lfrcnp=7, bearing=286.875, distanceToNext=0, isLast=True,
            ),
        ],
        positiveOffset=positive_offset,
        negativeOffset=negative_offset,
    )


def test_wire_offsets_are_shares_of_the_first_and_last_lrp_paths() -> None:
    reference = location_to_reference(_wire_location(203, 101))

    assert reference.poffs == pytest.approx(203 / 557)
    assert reference.noffs == pytest.approx(101 / 264)


def test_wire_offsets_match_the_binary_decoder() -> None:
    from_binary = decode_base64(BOTH_OFFSETS_V3)
    from_wire = location_to_reference(_wire_location(203, 101))

    # The wire carries whole metres, so allow half a metre of rounding per side.
    assert from_wire.poffs == pytest.approx(from_binary.poffs, abs=0.5 / 557)
    assert from_wire.noffs == pytest.approx(from_binary.noffs, abs=0.5 / 264)
