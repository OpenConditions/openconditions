/** One link of an HTTP `Link` header: its target as written and its parameters. */
export interface WebLink {
  /** The URI-Reference between `<` and `>`, unresolved. */
  target: string;
  /** The relation types of the first `rel` parameter, lower-cased. */
  rels: string[];
  /** The parameters by lower-cased name, the first occurrence of each. */
  params: ReadonlyMap<string, string>;
}

const TOKEN = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

/**
 * The links of an HTTP `Link` header field value (RFC 8288 §3): a
 * comma-separated list of `<target>` each followed by `; name=value`
 * parameters, a value a token or a quoted string. Commas inside the target
 * or a quoted string do not separate links. Throws on a value that does not
 * follow the grammar, so a broken header is never read as "no next page".
 */
export function parseLinkHeader(value: string): WebLink[] {
  const links: WebLink[] = [];
  let i = 0;
  const skipSpace = () => {
    while (value[i] === " " || value[i] === "\t") i++;
  };
  const fail = (): never => {
    throw new Error("malformed Link header");
  };
  const token = (): string => {
    const start = i;
    while (i < value.length && TOKEN.test(value.charAt(i))) i++;
    if (i === start) fail();
    return value.slice(start, i);
  };
  const quoted = (): string => {
    let out = "";
    i++;
    while (i < value.length && value[i] !== '"') {
      if (value[i] === "\\") i++;
      if (i >= value.length) fail();
      out += value[i++];
    }
    if (value[i] !== '"') fail();
    i++;
    return out;
  };
  while (i < value.length) {
    skipSpace();
    // Empty list elements are allowed (RFC 9110 §5.6.1).
    if (value[i] === ",") {
      i++;
      continue;
    }
    if (i >= value.length) break;
    if (value[i] !== "<") fail();
    const end = value.indexOf(">", i);
    if (end < 0) fail();
    const target = value.slice(i + 1, end).trim();
    i = end + 1;
    const params = new Map<string, string>();
    for (;;) {
      skipSpace();
      if (value[i] !== ";") break;
      i++;
      skipSpace();
      const name = token().toLowerCase();
      skipSpace();
      let param = "";
      if (value[i] === "=") {
        i++;
        skipSpace();
        param = value[i] === '"' ? quoted() : token();
      }
      if (!params.has(name)) params.set(name, param);
    }
    skipSpace();
    if (i < value.length && value[i] !== ",") fail();
    const rels = (params.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    links.push({ target, rels, params });
  }
  return links;
}

/**
 * The target of the header's `rel="next"` link, unresolved, or undefined when
 * it names none. A link with an `anchor` is about another resource than the
 * response's and does not count.
 */
export function nextLinkTarget(value: string | null): string | undefined {
  if (value === null) return undefined;
  return parseLinkHeader(value).find(
    (link) => link.rels.includes("next") && !link.params.has("anchor"),
  )?.target;
}
