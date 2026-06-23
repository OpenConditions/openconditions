# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Map-match an OpenLR line location reference onto a road graph.

This module is the seam between the `openlr-dereferencer` engine and the HTTP
layer. It runs the decoder against any `MapReader`, turns the resulting
offset-trimmed coordinate path into GeoJSON, and derives a match confidence
from the per-LRP candidate scores the decoder considered.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from openlr import LineLocationReference, LocationReferencePoint
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


class _ScoreObserver(DecoderObserver):
    """Records the best candidate score seen for each location reference point.

    The decoder rates every candidate line for an LRP; the highest of those
    scores is the strongest evidence that the LRP was placed on the right road.
    Averaging the per-LRP bests yields a single confidence for the whole match.
    """

    def __init__(self) -> None:
        self.best_scores: dict[LocationReferencePoint, float] = {}

    def on_candidates_found(
        self, lrp: LocationReferencePoint, candidates: Sequence[Candidate]
    ) -> None:
        if not candidates:
            return
        best = max(c.score for c in candidates)
        prior = self.best_scores.get(lrp, 0.0)
        self.best_scores[lrp] = max(prior, best)

    def on_route_success(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401
        pass

    def on_route_fail(self, *args: Any, **kwargs: Any) -> None:
        pass

    def on_matching_fail(self, *args: Any, **kwargs: Any) -> None:
        pass


def _confidence(observer: _ScoreObserver) -> float:
    scores = list(observer.best_scores.values())
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 4)


def _to_geojson(coordinates: Sequence[Any]) -> dict[str, Any]:
    return {
        "type": "LineString",
        "coordinates": [[c.lon, c.lat] for c in coordinates],
    }


def match(
    reference: LineLocationReference,
    reader: MapReader,
    config: Config = DEFAULT_CONFIG,
) -> MatchResult:
    """Resolve `reference` against `reader`, returning trimmed GeoJSON geometry.

    Raises `NoMatchError` when the decoder cannot find a consistent path.
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
