# Find catalog metadata candidates

`pnpm feeds:discover` searches three public mobility catalogs and produces a human review queue. It reads catalog metadata and the repository's baked feed definitions. It does not fetch distribution payloads or samples, subscribe to sources, resolve runtime catalog children, change feeds or approve ingestion.

Prepare an installed checkout once:

```bash
pnpm install --frozen-lockfile
pnpm build:domains
pnpm feeds:discover --help
pnpm feeds:discover --output /tmp/feed-discovery.json
pnpm feeds:discover --catalog mobidrom --catalog latvia --format markdown --output /tmp/feed-discovery.md
```

The command itself never installs or builds anything. Help and argument validation work before domain imports; a missing workspace build produces `workspace_build_required` with the preparation commands. By default it selects all three catalogs and writes JSON to stdout. `--catalog` is repeatable; duplicate catalogs and conflicting scalar flags are usage errors. There is no persistent registry or scheduled run.

Exit status is `0` for a complete report within the supported scope, `2` for a partial report, and `1` for usage, inventory or output failure. A provider HTTP failure preserves successful pages and other catalogs and returns a partial report. Missing results in a partial run cannot establish withdrawal. `--output` writes a temporary file and renames it after rendering; its parent directory must exist. Paths inside the baked `feeds/` directory, including aliases through symlinks, and paths ending in `.jsonc` are refused.

## What the adapters read

| Catalog        | Metadata endpoint                                                       | Completeness scope                                      |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| MOBIDROM / NRW | `https://www.mobilitaetsdaten.nrw/api/ckan/api/3/action/package_search` | Public active datasets returned by CKAN                 |
| Belgium        | `https://transportdata.be/api/3/action/package_search`                  | Public active datasets returned by CKAN                 |
| Latvia         | `https://transportdata.gov.lv/api/v1/subscriber/metadata_dcat`          | Dataset nodes in the tested mobilityDCAT RDF/XML subset |

Every request uses one of these fixed paths. CKAN requests construct `q=*:*`, `sort=id asc`, `rows=100` and `start` locally, advancing by the actual number returned. Response-owned links never cause requests. Redirects are refused, including redirects to payloads on the catalog's own host. Requests use the existing DNS-pinned public-address egress guard with explicit limits and no environment-owned private-host exceptions.

Each catalog has a 90-second deadline, a 30-second request deadline, a 10 MiB decoded response limit and a 30 MiB total limit. CKAN has at most 20 pages and 2,000 datasets. Changed counts, repeated IDs, premature empty pages, invalid metadata and exhausted limits make the catalog incomplete with fixed diagnostic codes. A count of zero with zero results is a healthy empty CKAN catalog. Limits are reported with the observations; raising them requires a deliberate code and test change.

The Latvia parser supports namespace aliases, typed nodes, `rdf:Description` with `rdf:type`, absolute `rdf:about` and `rdf:resource` IRIs, inline and referenced blank nodes, datatype attributes and language-tagged literals. It joins distributions and simple named rights objects without dereferencing them. Missing catalog dataset or record references make the result incomplete. It rejects DTDs, entity declarations, non-UTF-8 declarations, relative IRIs, `xml:base`, `parseType`, RDF containers, property attributes and unsupported structures. Bounds are 48 levels, 20,000 graph nodes, 100,000 triples, 100,000 XML elements and 16,384 characters per literal or attribute. This is a tested subset, with no general RDF, SHACL, Turtle or JSON-LD conformance claim.

## How to read the queue

Every candidate has `status: needs_review`. Stable IDs use CKAN dataset/resource UUIDs or RDF subjects and a digest of semantic distribution evidence. HTTP and MQTT distributions remain separate. Identical fallback identities are numbered and counted rather than merged. Catalog modification timestamps describe metadata; they do not prove source freshness.

The queue uses ordinal research priorities. Within each tier, candidates with fewer blocking caveats come first, followed by stable IDs:

- `research_gap`: a relevant public-license pull-download lead with no configured country-domain source or possible multinational/bbox coverage.
- `research_extension`: a similar lead where configured sources may already cover the country/domain.
- `review_constraints`: unknown or restricted rights, access/format obstacles or possible supplier overlap.
- `already_configured`: an exact baked endpoint or explicit CKAN dataset match, with its evidence retained.

These tiers rank further research. An `accessURL` can be a landing page; the absence of an explicit `downloadURL`, push/MQTT communication, fees and contracts all lower priority even alongside CC0. CKAN resources commonly expose only an access URL, so many useful leads remain in `review_constraints`. Samples are labelled separately and never used as endpoints or fetched. A listed format does not establish parser support or a safe snapshot, deletion or replay contract.

License recognition uses exact, versioned catalog aliases and the existing OpenConditions registry/public-egress policy. Missing declarations, declared but unmapped licenses, conflicting declarations and recognized licenses remain distinct. Unversioned `cc-by` and `cc-zero` do not become versioned public licenses. Distribution declarations override dataset fallback, including unreadable or unresolved declarations; an open license does not erase usage or access restrictions. Share-alike licenses such as ODbL remain outside the current public policy. Catalog metadata being publicly readable supplies no source-data license or account entitlement.

Domain hints use metadata themes and conservative keywords. Static parking remains a research lead. Shared mobility/GBFS, timetables and transport stops alone are excluded and counted; OpenConditions' `vehicles` domain describes maintenance fleets. Unknown topics stay visible without an invented domain. DATEX alone does not identify a roads feed.

Inventory matches include disabled baked definitions. URL equality preserves path case and query values/order; same-path query variations, supported template prefixes and same-catalog aggregators indicate possible overlap. Explicit catalog URLs cited in a feed’s terms note are used only for dataset association, never as exact endpoints; trailing prose punctuation is removed. Matching titles never proves duplication. Identical endpoints across catalogs are linked without merging distributions. The inventory reads raw definitions only: operator overlays, resolved catalog children and physical-site overlap are unknown. `global`, `eu`, explicit coverage countries and bbox sources prevent claims of proven new geographic coverage.

The NRW parking and P+R bundles already aggregate several publisher datasets. Accessible-parking listings may add attributes or locations, but this tool does not count payload records or prove new physical sites. Latvia's road restrictions and roadworks can carry CC0 while requiring a push/subscription workflow; this report does not qualify that workflow or activate it.

## Report safety and verification

JSON and Markdown share the same report model. URL presentation strips userinfo and fragments and omits unknown query keys and values, retaining only a small OGC/WFS parameter allowlist. Exact metadata request URLs constructed by the tool retain their fixed paging parameters for auditability. Internal matching uses originals before redaction. Contact fields are omitted; bounded free-text hints scrub email addresses, labelled phone numbers and common credential assignments. Truncation drops a cut token so it cannot leave a partial address or URL. Tokens embedded in paths or unlabelled prose cannot be reliably detected. Review artifacts before sharing them. Diagnostics contain fixed codes, with no upstream error bodies or parser snippets. Markdown escapes metadata text and uses sanitized URLs in both link labels and destinations.

Run the focused offline checks after building the necessary workspace dependencies:

```bash
pnpm exec vitest run --project unit scripts/__tests__/feed-discovery-*.test.ts
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm lint
```

A live discovery run qualifies metadata acquisition at that time only. It supplies no database, distribution-payload, native-device, deployment or production-ingestion evidence. The full repository verification and hosted CI remain separate gates.
