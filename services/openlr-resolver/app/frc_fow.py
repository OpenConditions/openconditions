# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Functional Road Class (FRC) and Form of Way (FOW) definitions plus an
explicit mapping from OpenStreetMap `highway`/`junction` tags onto them.

OpenLR location references carry an FRC (road importance, 0 = highest) and an
FOW (physical road type) per location reference point. To map-match a reference
onto an OSM-derived graph, every graph edge must expose the same two
attributes, so the graph-build step classifies each OSM way once and stores the
result.

The mapping below follows the conventions used by the OpenLR reference Java
implementation and TomTom's published OSM adapter: motorway-class roads are the
most important (FRC0) and physically separated (FOW motorway), trunk/primary
roads descend through the functional classes, and residential/service roads sit
at the bottom. Values are intentionally conservative; an unknown `highway`
value is treated as a low-importance single carriageway rather than dropped, so
the graph stays connected.
"""

from __future__ import annotations

from enum import IntEnum


class Frc(IntEnum):
    """Functional Road Class. 0 is the most important road, 7 the least."""

    FRC0 = 0
    FRC1 = 1
    FRC2 = 2
    FRC3 = 3
    FRC4 = 4
    FRC5 = 5
    FRC6 = 6
    FRC7 = 7


class Fow(IntEnum):
    """Form of Way — the physical type of a road."""

    UNDEFINED = 0
    MOTORWAY = 1
    MULTIPLE_CARRIAGEWAY = 2
    SINGLE_CARRIAGEWAY = 3
    ROUNDABOUT = 4
    TRAFFIC_SQUARE = 5
    SLIPROAD = 6
    OTHER = 7


# OSM `highway` value -> (FRC, FOW). Link roads keep the FRC of their parent
# class but take FOW SLIPROAD. The default for any other highway value is the
# residential tier.
_HIGHWAY_MAP: dict[str, tuple[Frc, Fow]] = {
    "motorway": (Frc.FRC0, Fow.MOTORWAY),
    "motorway_link": (Frc.FRC0, Fow.SLIPROAD),
    "trunk": (Frc.FRC1, Fow.MULTIPLE_CARRIAGEWAY),
    "trunk_link": (Frc.FRC1, Fow.SLIPROAD),
    "primary": (Frc.FRC2, Fow.MULTIPLE_CARRIAGEWAY),
    "primary_link": (Frc.FRC2, Fow.SLIPROAD),
    "secondary": (Frc.FRC3, Fow.SINGLE_CARRIAGEWAY),
    "secondary_link": (Frc.FRC3, Fow.SLIPROAD),
    "tertiary": (Frc.FRC4, Fow.SINGLE_CARRIAGEWAY),
    "tertiary_link": (Frc.FRC4, Fow.SLIPROAD),
    "unclassified": (Frc.FRC5, Fow.SINGLE_CARRIAGEWAY),
    "residential": (Frc.FRC6, Fow.SINGLE_CARRIAGEWAY),
    "living_street": (Frc.FRC6, Fow.SINGLE_CARRIAGEWAY),
    "service": (Frc.FRC7, Fow.SINGLE_CARRIAGEWAY),
    "road": (Frc.FRC7, Fow.OTHER),
}

_DEFAULT_CLASS: tuple[Frc, Fow] = (Frc.FRC7, Fow.SINGLE_CARRIAGEWAY)


def classify(tags: dict[str, str]) -> tuple[Frc, Fow] | None:
    """Classify an OSM way's tags into (FRC, FOW).

    Returns ``None`` when the way is not a routable road (no `highway` tag, or a
    non-vehicular value such as a footway), signalling the caller to skip it.
    A `junction=roundabout` tag overrides FOW to ROUNDABOUT while keeping the
    FRC implied by the road's class.
    """

    highway = tags.get("highway")
    if highway is None:
        return None

    if highway in _NON_VEHICULAR:
        return None

    frc, fow = _HIGHWAY_MAP.get(highway, _DEFAULT_CLASS)

    if tags.get("junction") == "roundabout":
        fow = Fow.ROUNDABOUT

    return frc, fow


# Highway values that are not part of the drivable road network and so are not
# valid OpenLR match targets.
_NON_VEHICULAR: frozenset[str] = frozenset(
    {
        "footway",
        "path",
        "pedestrian",
        "steps",
        "cycleway",
        "bridleway",
        "track",
        "corridor",
        "platform",
        "construction",
        "proposed",
        "bus_stop",
        "elevator",
        "raceway",
    }
)


def is_oneway(tags: dict[str, str]) -> bool:
    """Return whether an OSM way is one-way in its digitised direction.

    `oneway=yes/true/1/-1` and (implicitly) `junction=roundabout` are one-way.
    `oneway=-1` is one-way against the digitised direction; the graph build
    handles direction reversal, so this only reports *that* it is one-way.
    """

    oneway = tags.get("oneway", "").lower()
    if oneway in {"yes", "true", "1", "-1"}:
        return True
    if tags.get("junction") == "roundabout":
        return True
    return False


def is_reversed_oneway(tags: dict[str, str]) -> bool:
    """Return whether the way is one-way *against* its digitised direction."""

    return tags.get("oneway", "").lower() == "-1"
