import type { Geometry, Position } from "geojson";

function bboxOfPositions(positions: Position[], acc: number[]): void {
  for (const [x, y] of positions) {
    if (x! < acc[0]!) acc[0] = x!;
    if (y! < acc[1]!) acc[1] = y!;
    if (x! > acc[2]!) acc[2] = x!;
    if (y! > acc[3]!) acc[3] = y!;
  }
}

function collectBbox(geometry: Geometry, acc: number[]): void {
  switch (geometry.type) {
    case "Point":
      bboxOfPositions([geometry.coordinates], acc);
      break;
    case "MultiPoint":
    case "LineString":
      bboxOfPositions(geometry.coordinates, acc);
      break;
    case "MultiLineString":
    case "Polygon":
      for (const ring of geometry.coordinates) bboxOfPositions(ring, acc);
      break;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) bboxOfPositions(ring, acc);
      }
      break;
    case "GeometryCollection":
      for (const member of geometry.geometries) collectBbox(member, acc);
      break;
  }
}

/** Bounding-box intersection test (bbox-vs-bbox, not exact geometry). */
export function intersectsBbox(
  geometry: Geometry,
  bbox: [number, number, number, number],
): boolean {
  const acc = [Infinity, Infinity, -Infinity, -Infinity];
  collectBbox(geometry, acc);
  const [minX, minY, maxX, maxY] = acc;
  if (minX === Infinity) return false;
  const [west, south, east, north] = bbox;
  return maxX! >= west && minX! <= east && maxY! >= south && minY! <= north;
}
