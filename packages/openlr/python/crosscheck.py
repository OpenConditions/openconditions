# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Decode and encode OpenLR line locations with the Python `openlr` library.

Reads a JSON object from stdin: `decode`, a list of base64 OpenLR binaries,
and `encode`, a list of line locations (LRPs with bearings in degrees and
DNP in metres, offsets as shares of their LRP length). Writes a JSON object
with the decoded locations, each LRP as the library reads it, and the
base64 binaries the library writes for the locations to encode.
"""

import json
import sys

from openlr import (
    FOW,
    FRC,
    LineLocationReference,
    LocationReferencePoint,
    binary_decode,
    binary_encode,
)


def decoded(value):
    reference = binary_decode(value, is_base64=True)
    if not isinstance(reference, LineLocationReference):
        return {"type": type(reference).__name__}
    return {
        "type": "line",
        "points": [
            {
                "longitude": p.lon,
                "latitude": p.lat,
                "frc": int(p.frc),
                "fow": int(p.fow),
                "bearing": p.bear,
                "lfrcnp": int(p.lfrcnp),
                "distanceToNext": p.dnp,
            }
            for p in reference.points
        ],
        "positiveOffset": reference.poffs,
        "negativeOffset": reference.noffs,
    }


def encoded(location):
    points = [
        LocationReferencePoint(
            lon=p["longitude"],
            lat=p["latitude"],
            frc=FRC(p["frc"]),
            fow=FOW(p["fow"]),
            bear=p["bearing"],
            lfrcnp=FRC(p["lfrcnp"] if p["lfrcnp"] is not None else 7),
            dnp=p["distanceToNext"],
        )
        for p in location["points"]
    ]
    reference = LineLocationReference(
        points=points, poffs=location["positiveOffset"], noffs=location["negativeOffset"]
    )
    return binary_encode(reference, is_base64=True)


def main():
    request = json.load(sys.stdin)
    json.dump(
        {
            "decoded": [decoded(v) for v in request.get("decode", [])],
            "encoded": [encoded(loc) for loc in request.get("encode", [])],
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
