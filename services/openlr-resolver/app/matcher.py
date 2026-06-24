# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Map-match an OpenLR line location reference onto a road graph.

This module is the seam between the `openlr-dereferencer` engine and the HTTP
layer. It runs the decoder against any `MapReader`, turns the resulting
offset-trimmed coordinate path into GeoJSON, and derives a match confidence
from the per-LRP candidate scores the decoder considered.

Offset-trimming correctness
---------------------------
``openlr-dereferencer``'s ``build_line_location`` multiplies ``reference.poffs``
(a fraction in [0, 1]) by ``path[0].length()`` — the length of the *first*
LRP-to-LRP route segment — rather than the total matched path length. For a
two-LRP reference this is fine because there is only one segment. For three or
more LRPs the wrong per-segment length is used, so the trimmed geometry starts
and ends at the wrong points.

This module works around the engine bug by:

1. Reading the accepted path from ``LineLocation.lines`` (returned by the
   ``decode()`` call), which contains only the edges the engine committed to
   after passing the DNP length check — no ghost segments from explored-but-
   rejected candidate routes.
2. Concatenating those line geometries into one shapely ``LineString``.
3. Computing the true total geodesic path length.
4. Applying the correct positive/negative offsets in metres
   (``reference.poffs * total_len`` and ``reference.noffs * total_len``)
   as fractions of the full concatenated line and using
   ``shapely.ops.substring`` to extract the trimmed sub-line.

When both offsets are zero the untrimmed full line is returned directly.
If the combined offsets exceed the path length the result is clamped to a
degenerate one-vertex LineString at the midpoint — callers should treat
zero-length geometries as match failures.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from openlr import LineLocationReference, LocationReferencePoint
from openlr_dereferencer import Config, DEFAULT_CONFIG, decode
from openlr_dereferencer.decoding.candidate import Candidate
from openlr_dereferencer.decoding.error import LRDecodeError
from openlr_dereferencer.maps import Line, MapReader
from openlr_dereferencer.maps.wgs84 import line_string_length
from openlr_dereferencer.observer import DecoderObserver
from shapely.geometry import LineString
from shapely.ops import substring


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


def _join_line_geometries(lines: list[Line]) -> LineString:
    """Concatenate the geometries of the accepted matched lines into one ``LineString``.

    Duplicate junction nodes (where one line ends and the next begins)
    are deduplicated so the result has no repeated coordinate.
    """
    coords: list[tuple[float, float]] = []
    for line in lines:
        line_coords = list(line.geometry.coords)
        if coords and line_coords and coords[-1] == line_coords[0]:
            coords.extend(line_coords[1:])
        else:
            coords.extend(line_coords)
    return LineString(coords)


def _trim_by_offsets(
    full_line: LineString,
    total_len: float,
    p_off_m: float,
    n_off_m: float,
) -> LineString:
    """Return the sub-line after applying positive and negative offsets in metres.

    Offsets are converted to fractions of ``total_len`` so that shapely's
    ``substring(normalized=True)`` can operate in the line's own coordinate
    space (which is WGS-84 degrees, not metres). The geodesic-to-degree ratio
    is consistent enough over the short segments OpenLR references span that
    this fraction-based approach matches the engine's own internal convention.

    Degenerate case: if ``p_off_m + n_off_m >= total_len`` the offsets
    would consume the entire path. The midpoint is returned as a single-vertex
    LineString; callers should treat length-zero geometries as match failures.
    """
    if total_len <= 0:
        return full_line

    start_frac = p_off_m / total_len
    end_frac = 1.0 - (n_off_m / total_len)

    if start_frac >= end_frac:
        mid = (start_frac + end_frac) / 2.0
        mid = max(0.0, min(1.0, mid))
        pt = full_line.interpolate(mid, normalized=True)
        return LineString([pt, pt])

    return substring(full_line, start_frac, end_frac, normalized=True)


def _to_geojson(line: LineString) -> dict[str, Any]:
    return {
        "type": "LineString",
        "coordinates": [[x, y] for x, y in line.coords],
    }


def match(
    reference: LineLocationReference,
    reader: MapReader,
    config: Config = DEFAULT_CONFIG,
) -> MatchResult:
    """Resolve ``reference`` against ``reader``, returning trimmed GeoJSON geometry.

    The positive/negative offsets from ``reference`` are applied against the
    TOTAL matched path length rather than only the first or last segment length,
    correcting the ``openlr-dereferencer`` engine's ``build_line_location`` bug.

    The polyline is built from ``LineLocation.lines`` — the set of edges the
    engine committed to after all DNP checks passed — so ghost segments from
    explored-but-rejected candidate routes are never included.

    Raises ``NoMatchError`` when the decoder cannot find a consistent path.
    """

    observer = _ScoreObserver()
    try:
        location = decode(reference, reader, observer=observer, config=config)
    except LRDecodeError as exc:
        raise NoMatchError(str(exc)) from exc

    accepted_lines: list[Line] = location.lines
    if not accepted_lines:
        raise NoMatchError("Decoder produced no matched path segments")

    full_line = _join_line_geometries(accepted_lines)
    total_len = line_string_length(full_line)

    p_off_m = reference.poffs * total_len
    n_off_m = reference.noffs * total_len

    trimmed = _trim_by_offsets(full_line, total_len, p_off_m, n_off_m)

    if len(trimmed.coords) < 2:
        raise NoMatchError("Matched path collapsed to a single point after offsets")

    return MatchResult(
        geometry=_to_geojson(trimmed),
        confidence=_confidence(observer),
    )
