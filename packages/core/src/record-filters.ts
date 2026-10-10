/**
 * Who a read is for. The public scope withholds every record of a restricted
 * source (see `conditions.source.restricted`); the operator scope, granted
 * to the instance's operator alone, withholds nothing.
 */
export type Scope = "public" | "operator";

/** Filters every record collection takes, on a class table's promoted kernel columns. */
export interface RecordFilters {
  scope: Scope;
  /** west, south, east, north. */
  bbox?: [number, number, number, number];
  kinds?: readonly string[];
  types?: readonly string[];
  domain?: string;
  sources?: readonly string[];
  origins?: readonly string[];
}

/**
 * The WHERE clauses `scope` adds over the table aliased `t`, which has a
 * `source_id`: none for the operator, and for the public no record of a
 * restricted source. A source the catalogue does not know (a peer's, the
 * crowd's) is not restricted.
 */
export function scopeClauses(t: string, scope: Scope): string[] {
  if (scope === "operator") return [];
  return [
    `NOT EXISTS (SELECT 1 FROM conditions.source scope_source
                  WHERE scope_source.id = ${t}.source_id AND scope_source.restricted)`,
  ];
}

/**
 * The WHERE clauses of `f` over the table aliased `t`, binding values through
 * `p` (which returns the placeholder of a bound value).
 */
export function recordFilterClauses(
  t: string,
  f: RecordFilters,
  p: (value: unknown) => string,
): string[] {
  const clauses = scopeClauses(t, f.scope);
  if (f.bbox) clauses.push(inBox(`${t}.geom`, f.bbox, p));
  if (f.kinds?.length) clauses.push(`${t}.kind = ANY(${p([...f.kinds])}::text[])`);
  if (f.types?.length) clauses.push(`${t}.type = ANY(${p([...f.types])}::text[])`);
  if (f.domain) clauses.push(`${t}.domain = ${p(f.domain)}`);
  if (f.sources?.length) clauses.push(`${t}.source_id = ANY(${p([...f.sources])}::text[])`);
  if (f.origins?.length) clauses.push(`${t}.origin = ANY(${p([...f.origins])}::text[])`);
  return clauses;
}

/**
 * `geom` meets the box `[west, south, east, north]`. The geometry itself, not
 * its bounding box: a zone with parts either side of the antimeridian has a
 * box spanning every longitude, and would meet any box at its latitudes. The
 * spatial index still narrows the candidates first.
 */
export function inBox(
  geom: string,
  [w, s, e, n]: readonly [number, number, number, number],
  p: (value: unknown) => string,
): string {
  return `ST_Intersects(${geom}, ST_MakeEnvelope(${p(w)}, ${p(s)}, ${p(e)}, ${p(n)}, 4326))`;
}

/** A positional-parameter binder: `p(value)` appends the value and returns its placeholder. */
export function binder(params: unknown[]): (value: unknown) => string {
  return (value) => {
    params.push(value);
    return `$${params.length}`;
  };
}
