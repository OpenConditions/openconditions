# Feed catalogue

Every feed OpenConditions ingests is written here as data. The ingest service
reads this directory at startup, checks it as a whole, and polls what it holds.
Adding or fixing a feed is an edit to one region file; no code changes.

## Layout

```
feeds/
  credentials.jsonc        credential fields shared by several feeds
  roads/                   one directory per domain
    de.jsonc               one file per region
    nl.jsonc
    …
  schema/                  generated JSON Schemas (do not edit)
    roads.schema.json
    credentials.schema.json
```

A domain directory holds region files named for what they cover: an ISO 3166-1
alpha-2 code in lower case (`de`, `us`), `eu` for a pan-European feed, or
`global`. A directory that names no known domain is an error, and so is any
other file in a domain directory; hidden files (`.DS_Store`) are skipped.

## Region files

A region file is JSONC (comments and trailing commas allowed):

```jsonc
{
  "$schema": "../schema/roads.schema.json",
  "maintainers": [{ "name": "…", "github": "…" }],
  "feeds": [
    {
      "subdivision": "hh",
      "operator": "polizei",
      "product": "events",
      "name": "Polizei Hamburg traffic incidents (Landesmeldestelle)",
      "tier": "authoritative",
      "format": "geojson",
      "endpoints": {
        "main": { "url": "https://api.hamburg.de/…", "cadenceSec": 300 },
      },
      "geojson": { "idField": "id", "typeField": "art" },
      "freshnessWindowSec": 900,
      "license": "DL-DE-BY-2.0",
      "licenseUrl": "https://www.govdata.de/dl-de/by-2-0",
      "attribution": "Freie und Hansestadt Hamburg, Polizei Hamburg",
      "privacyUrl": "https://www.hamburg.de/datenschutz/",
    },
  ],
}
```

`$schema` is required and must be `../schema/<domain>.schema.json`; editors use it
to complete and check fields. `maintainers` is optional. The fields every feed
shares are defined in `packages/ingest-framework/src/catalog/schema.ts`; a domain
adds its own (roads: `geojson`, `flowMap`, `posListLonLat`, `srsName`, `bbox`,
`openlrResolver`, `laneNumbering`, in `packages/roads/src/feed-schema.ts`).

`tier` is `authoritative` for the publishing authority and `aggregator` for a
relay of others' data. `freshnessWindowSec` is how old the last good poll may
get before the feed is reported stale. `snapshot` declares a publication that
is the publisher's complete current set, so a record missing from it is
withdrawn.

The other optional fields every feed may carry:

- `accessMode`: `bulk` (the default; each poll fetches the published set) or
  `on_demand` (the publisher answers queries), stamped on each record's
  provenance.
- `requestLimits`: the publisher's stated limits, `perMinute`, `perDay`,
  `maxRadiusKm` and `keyScope` (`instance` or `consumer`: whom one key serves).
- `extrasAllow`: the source fields kept on each record under `extras`.
- `extrasFederate`: whether those extras are sent to federation peers
  (default `false`).
- `rawRetention`: the class raw payloads are archived under, `situation`,
  `observation` or `reference`; by default the format's (`observation` for a
  measurements format, else `situation`), and only when the rights grant
  retention.

`coverage` says where a feed's data lies: `countries`, a list of upper-case
codes, and `bbox`, `[west, south, east, north]` in degrees. A national feed
covers its country (`["DE"]`); a narrower one names the ISO 3166-2
subdivisions it covers (`["DE-BY"]`, `["US-NY"]`). Left out, a feed in a
country's region file covers that country, and one in `eu.jsonc` or
`global.jsonc` covers nothing in particular.

## Feed ids

A feed's id is derived, never written:

```
[region, subdivision, operator, qualifier, product].filter(Boolean).join("-")
```

The region comes from the file name and is left out for `global`. Every token is
lower-case `[a-z0-9]+`. `subdivision` is an ISO 3166-2 subdivision or a city
slug; `operator` names the publisher, or the platform when the platform is what
publishes the regional bundle (the `de-*-mobilithek-events` feeds are
Mobilithek's per-state collections, not one authority's feed); `product` is
what the feed publishes. The roads products are:

| product      | what                                                     |
| ------------ | -------------------------------------------------------- |
| `events`     | situations: incidents, roadworks, closures, restrictions |
| `conditions` | road and weather conditions along road segments          |
| `flow`       | measured traffic: speed, volume, level of service        |

`qualifier` (one or more dash-joined tokens) tells apart two feeds that would
otherwise share an id: `ca-on-511-construction-events` beside
`ca-on-511-events`, `de-nw-autobahn-los-flow` beside `de-nw-autobahn-flow`.
Leave it out when the id is unique without it. An id, once published, does not
change: it names the feed's records, its status and its credentials.

## Endpoints and decoders

`endpoints` maps a role to what is fetched. Every feed has `main`, the data it
publishes. A format may declare more roles; the roads measurement formats that
place readings by site id declare `sites`, the reference data that gives each
site its geometry.

An endpoint has exactly one of:

- `url`: one URL;
- `urls`: several URLs whose payloads are parsed together;
- `reference`: a published file found by name (`{ "kind": "mobilithek",
"offerId": "…", "fileNamePrefix": "…" }`), always with a `decoder`.

and `cadenceSec`, how often it is fetched. Reference endpoints refresh every six
hours (`21600`). The optional request fields are `method`, `body`, `headers`,
`gzip` (the body is gzipped), `pagination` (`skipParam`, `pageSize`,
`recordsPath`, `maxPages`), `expand` (see credentials) and `fanout`, for an
endpoint of several URLs (`urls` or `expand`): `"all"`, the default, needs every
URL to answer, so one failure fails the poll; `"tolerant"` costs only the
failing URL's records, and sends no conditional requests.

`decoder` names how a reference endpoint is read. The roads decoders are
`datex2-sites` (a DATEX II measurement site table), `datex2-locations` (DATEX II
predefined locations) and the station registries `fintraffic-stations`,
`webtris-sites`, `miv-config`, `france-comptage-csv`, `hk-detector-csv` and
`bcn-trams-csv`. A format accepts only the roles and decoders it declares
(`packages/roads/src/domain.ts`); anything else is a lint error.

## Credentials

A feed declares the secrets it needs under `credentials`, by field name, with a
title and an optional `description` and `setup` guide (`url`, `urlLabel`,
`steps`, `cost`, `notes`, `email`) that the admin panel renders. A field may be
`optional` or carry a `default` (QLDTraffic ships the publisher's public key).
Field names say what the value is: `api_key`, `user`, `password`,
`subscription_id`, `sites_subscription_id`, `client_id`, `client_secret`.

A field is used by `auth` or as a `${field}` placeholder in a URL, body or header:

```jsonc
"credentials": { "api_key": { "title": "Tark Tee key (Estonia)" } },
"auth": { "kind": "query-key", "param": "apiKey", "credential": "api_key" },
```

The auth kinds are `none`, `query-key`, `header-key` (with an optional
`valuePrefix`), `basic`, `bearer`, `oauth2-client-credentials` and `mtls`.
`expand` names a field whose value is a comma-separated list: the endpoint's URL
is filled once per item (one Mobilithek client pull per subscription id), and an
unset value means no URLs, so the feed stays dormant until it is configured.

One account that serves several feeds is declared once, in `credentials.jsonc`,
as a shared group, and referred to as `@<group>.<field>`:

```jsonc
"auth": { "kind": "mtls", "cert": "@mobilithek.cert", "key": "@mobilithek.key" },
```

A group is named after the account or portal that issues the credential, not
after the feeds that use it: `mobilithek` (the org machine certificate every
Mobilithek feed uses), `au-vic-transportvic` (the Transport Victoria open-data
portal key that both the `vicroads` and the `transportvic` feeds use),
`us-oh-ohgo`, `hr-hc`, …; a regional issuer's group is `<region>-<issuer>`. A
group serves at least two feeds; a credential one feed uses stays on that feed.

Each credential is read from an environment variable (or `<NAME>_FILE`): a
feed's own field from `<FEED_ID>_<FIELD>`, a shared field from
`<GROUP>_<FIELD>`, upper-cased with `-` as `_`. So `de-hh-autobahn-flow`'s
`subscription_id` is `DE_HH_AUTOBAHN_FLOW_SUBSCRIPTION_ID`, and
`@mobilithek.cert` is `MOBILITHEK_CERT`. A catalogue child uses its parent's
names.

## Licences and terms

`license` is an SPDX identifier where SPDX lists the licence (`CC-BY-4.0`,
`ODbL-1.0`, `DL-DE-BY-2.0`), otherwise `LicenseRef-<name>`
(`LicenseRef-GeoNutzV`), matched exactly. The ids the catalogue accepts, and the
rights each grants, are in `packages/ingest-framework/src/catalog/licenses.ts`.
A feed with no known licence is `NOASSERTION` and must say what is known in
`terms`.

`terms` records a feed's own terms where they differ from its licence: `url`,
`reviewedAt`, `note`, and any of `redistribution`, `derivedRedistribution`,
`commercialUse`, `attributionRequired`, `retention`. A key set in `terms`
(even to `null`) overrides the licence; an absent key defers to it.

## Disabled feeds

A dead or blocked feed stays documented in its region file:

```jsonc
"disabled": { "reason": "publisher withdrew the open endpoint", "since": "2026-09-30" },
```

It is checked like any other feed but never polled, and `/feeds/status` lists it
with its reason.

## Catalogue resolvers

A feed with `catalog` is a registry of feeds rather than one feed:
`catalog.resolver` names the domain resolver that enumerates its children (roads:
`autobahn-index`, `wzdx-registry`), and `endpoints.main.url` is the registry it
reads, the only place its URL is written. A resolver serves one parent: its
snapshot and approved children are the resolver's. Children are named by their
qualifier under the parent's region, subdivision, operator and product (`de-autobahn-a1-warning-events`,
`us-wzdx-fe9b3423ea03546f-events`) and inherit every field they leave out.
Without `approvedChildren` the parent fans its children out at fetch time; with
it, only the listed children are polled and the rest are shown to operators as
discovered. Each resolver keeps a vendored snapshot it falls back to when the
registry is down.

## Checking the catalogue

```sh
pnpm feeds:lint                       # schema, ids, formats, credentials, licences, URLs
pnpm feeds:check feeds/roads/nl.jsonc # fetch and parse the feeds of these files live
```

`feeds:lint` fails on any error: a duplicate id, an unknown product, format,
role or decoder, a credential that is undeclared or never used, a shared group
with fewer than two feeds, two credentials read from one environment variable
(`xx-op-flow`'s `events_k` and `xx-op-flow-events`' `k` are both
`XX_OP_FLOW_EVENTS_K`, and a field `k_file` is field `k`'s `_FILE` variant), an
unknown licence, `NOASSERTION` without `terms`, a private URL, a wrong
`$schema`, a `disabled.since` in the future, a catalogue parent without one
usable `endpoints.main.url` or naming a resolver another parent names, or an
approved catalogue child that does not resolve. `feeds:check` fetches and parses each
feed of the given files (every file when none is given); a parse or format error,
or a file that is no region file, fails it, a network or HTTP failure is
reported as a warning, and a feed whose credentials are not set is skipped as
`missing configuration`, naming the variables to set.
