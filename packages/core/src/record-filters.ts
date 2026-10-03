/** Filters every record collection takes, on a class table's promoted kernel columns. */
export interface RecordFilters {
  /** west, south, east, north. */
  bbox?: [number, number, number, number];
  kinds?: readonly string[];
  types?: readonly string[];
  domain?: string;
  sources?: readonly string[];
  origins?: readonly string[];
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
  const clauses: string[] = [];
  if (f.bbox) {
    const [w, s, e, n] = f.bbox;
    clauses.push(`${t}.geom && ST_MakeEnvelope(${p(w)}, ${p(s)}, ${p(e)}, ${p(n)}, 4326)`);
  }
  if (f.kinds?.length) clauses.push(`${t}.kind = ANY(${p([...f.kinds])}::text[])`);
  if (f.types?.length) clauses.push(`${t}.type = ANY(${p([...f.types])}::text[])`);
  if (f.domain) clauses.push(`${t}.domain = ${p(f.domain)}`);
  if (f.sources?.length) clauses.push(`${t}.source_id = ANY(${p([...f.sources])}::text[])`);
  if (f.origins?.length) clauses.push(`${t}.origin = ANY(${p([...f.origins])}::text[])`);
  return clauses;
}

/** A positional-parameter binder: `p(value)` appends the value and returns its placeholder. */
export function binder(params: unknown[]): (value: unknown) => string {
  return (value) => {
    params.push(value);
    return `$${params.length}`;
  };
}
