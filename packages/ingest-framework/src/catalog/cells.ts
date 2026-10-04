/** One cell of the fixed grid an on-demand feed is read on. */
export interface Cell {
  /** `<cellDeg>/<ix>/<iy>`: stable across reads, so a cell is cached and fetched once. */
  id: string;
  west: number;
  south: number;
  east: number;
  north: number;
}

const EARTH_RADIUS_KM = 6371;

/** The names a request text may use for the cell it is filled for: `{west}`, no `$`. */
export const CELL_PLACEHOLDER_NAMES = [
  "west",
  "south",
  "east",
  "north",
  "lat",
  "lon",
  "radiusKm",
] as const;

export type CellPlaceholderName = (typeof CELL_PLACEHOLDER_NAMES)[number];

/** Whether a request text names a cell placeholder. `${west}` is a credential, not one. */
export function usesCellPlaceholder(text: string | undefined): boolean {
  return (
    text !== undefined &&
    new RegExp(`(?<!\\$)\\{(${CELL_PLACEHOLDER_NAMES.join("|")})\\}`).test(text)
  );
}

/** Drops the float noise of `ix * cellDeg` (3 * 0.1 is 0.30000000000000004). */
function edge(index: number, cellDeg: number): number {
  return Number((index * cellDeg).toFixed(9));
}

/** A coordinate in grid units, rounded so an edge on a grid line is exactly an integer
 *  (0.3 / 0.1 is 2.9999999999999996). */
function gridUnits(degrees: number, cellDeg: number): number {
  return Number((degrees / cellDeg).toFixed(9));
}

/** The grid indices, first and last on each axis, of the cells covering a bbox. */
function gridRange(bbox: [number, number, number, number], cellDeg: number) {
  const [west, south, east, north] = bbox;
  const ix0 = Math.floor(gridUnits(west, cellDeg));
  const iy0 = Math.floor(gridUnits(south, cellDeg));
  const ix1 = Math.max(ix0, Math.ceil(gridUnits(east, cellDeg)) - 1);
  const iy1 = Math.max(iy0, Math.ceil(gridUnits(north, cellDeg)) - 1);
  return { ix0, iy0, ix1, iy1 };
}

/**
 * How many cells `cellsCovering` returns for a bbox, computed from the grid
 * indices alone: a caller can refuse a wide area before building its cells.
 */
export function cellCount(bbox: [number, number, number, number], cellDeg: number): number {
  const { ix0, iy0, ix1, iy1 } = gridRange(bbox, cellDeg);
  return (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
}

/**
 * The grid cells that cover a bbox (`[west, south, east, north]`), row by row
 * from the south, west to east. A bbox edge on a grid line takes no cell beyond
 * it. The grid is anchored at 0°, 0°, so the same place is always the same cell.
 */
export function cellsCovering(bbox: [number, number, number, number], cellDeg: number): Cell[] {
  const { ix0, iy0, ix1, iy1 } = gridRange(bbox, cellDeg);
  const cells: Cell[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      cells.push({
        id: `${cellDeg}/${ix}/${iy}`,
        west: edge(ix, cellDeg),
        south: edge(iy, cellDeg),
        east: edge(ix + 1, cellDeg),
        north: edge(iy + 1, cellDeg),
      });
    }
  }
  return cells;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** The centre of a cell. */
export function cellCentre(cell: Cell): { lat: number; lon: number } {
  return { lat: (cell.south + cell.north) / 2, lon: (cell.west + cell.east) / 2 };
}

const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

/**
 * The value each placeholder takes for a cell: its edges clamped to ±180° and
 * ±90°, so a cell at the antimeridian or a pole asks for no coordinate beyond
 * them, and its centre and radius those of the clamped cell.
 */
export function cellValues(cell: Cell): Record<CellPlaceholderName, string> {
  const clamped: Cell = {
    id: cell.id,
    west: clamp(cell.west, 180),
    south: clamp(cell.south, 90),
    east: clamp(cell.east, 180),
    north: clamp(cell.north, 90),
  };
  const { lat, lon } = cellCentre(clamped);
  return {
    west: String(clamped.west),
    south: String(clamped.south),
    east: String(clamped.east),
    north: String(clamped.north),
    lat: String(Number(lat.toFixed(9))),
    lon: String(Number(lon.toFixed(9))),
    radiusKm: String(cellRadiusKm(clamped)),
  };
}

/** The distance from a cell's centre to its farthest corner, rounded up to 0.1 km. */
export function cellRadiusKm(cell: Cell): number {
  const { lat, lon } = cellCentre(cell);
  const km = Math.max(
    haversineKm(lat, lon, cell.south, cell.west),
    haversineKm(lat, lon, cell.south, cell.east),
    haversineKm(lat, lon, cell.north, cell.west),
    haversineKm(lat, lon, cell.north, cell.east),
  );
  // Subtracting the noise floor keeps an exact tenth from rounding up a step.
  return Math.ceil(km * 10 - 1e-9) / 10;
}
