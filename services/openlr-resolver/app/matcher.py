# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Map-match an OpenLR line location reference onto a road graph.

This module is the seam between the `openlr-dereferencer` engine and the HTTP
layer. It runs the decoder against any `MapReader`, turns the resulting
offset-trimmed coordinate path into GeoJSON, and derives a match confidence
from the per-LRP candidate scores the decoder considered.

Offsets
-------
OpenLR expresses the positive offset as a share of the path between the first
two LRPs and the negative offset as a share of the path between the last two
LRPs (whitepaper v1.5 rev2, Rule 5 and section 7.5.2). ``openlr-dereferencer``
applies them that way: it scales ``poffs``/``noffs`` by the decoded length of
the first and last LRP-to-LRP route and trims the combined path, like TomTom's
reference decoder. The geometry returned here is that trimmed path as decoded.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from openlr import Coordinates, LineLocationReference, LocationReferencePoint
from openlr_dereferencer import Config, DEFAULT_CONFIG, decode
from openlr_dereferencer.decoding.candidate import Candidate
from openlr_dereferencer.decoding.error import LRDecodeError
from openlr_dereferencer.maps import MapReader
from openlr_dereferencer.observer import DecoderObserver


class NoMatchError(Exception):
    """Raised when no DNP-consistent path matches the location reference."""


@dataclass
class MatchResult:
    """A successful map-match: GeoJSON geometry and a [0, 1] confidence."""

    geometry: dict[str, Any]
    confidence: float


@dataclass
class _ScoreObserver(DecoderObserver):
    """Records the best candidate score seen per LRP.

    The decoder rates every candidate line for an LRP; the highest of those
    scores is the strongest evidence that the LRP was placed on the right road.
    Averaging the per-LRP bests yields a single confidence for the whole match.
    """

    best_scores: dict[LocationReferencePoint, float] = field(default_factory=dict)

    def on_candidates_found(
        self, lrp: LocationReferencePoint, candidates: Sequence[Candidate]
    ) -> None:
        if not candidates:
            return
        best = max(c.score for c in candidates)
        prior = self.best_scores.get(lrp, 0.0)
        self.best_scores[lrp] = max(prior, best)

    def on_route_fail(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_matching_fail(self, *args: Any, **kwargs: Any) -> None:
        pass


def _confidence(observer: _ScoreObserver) -> float:
    scores = list(observer.best_scores.values())
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 4)


def _to_geojson(coordinates: Sequence[Coordinates]) -> dict[str, Any]:
    return {
        "type": "LineString",
        "coordinates": [[c.lon, c.lat] for c in coordinates],
    }


def match(
    reference: LineLocationReference,
    reader: MapReader,
    config: Config = DEFAULT_CONFIG,
) -> MatchResult:
    """Resolve ``reference`` against ``reader``, returning trimmed GeoJSON geometry.

    The geometry is the decoder's location path after the positive and negative
    offsets have been applied to its first and last LRP-to-LRP routes.

    Raises ``NoMatchError`` when the decoder cannot find a consistent path.
    """

    observer = _ScoreObserver()
    try:
        location = decode(reference, reader, observer=observer, config=config)
    except LRDecodeError as exc:
        raise NoMatchError(str(exc)) from exc

    coordinates = location.coordinates()
    if len(coordinates) < 2:
        raise NoMatchError("Matched path collapsed to a single point after offsets")

    return MatchResult(
        geometry=_to_geojson(coordinates),
        confidence=_confidence(observer),
    )
