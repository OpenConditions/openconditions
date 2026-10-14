# Captured licence metadata

OpenConditions keeps permission selectors and display metadata separate. A feed's
`license` remains its reviewed policy ID; effective rights and public egress rules
continue to decide which records may be served. Display labels never approve use.

The source API and record provenance carry `licensing` using the shared portable
version 1 wire contract consumed by OpenMapX. `captureLicensing` in
`@openconditions/ingest-framework` captures curated registry definitions, exact
notices and conditions before acquisition results enter storage. Source API
responses expose the same structure rather than separate mutable licence-name
and URL display fields.

```json
{
  "version": 1,
  "bindings": [
    {
      "scope": "data",
      "subject": "Selected measurements",
      "license": { "kind": "spdx", "expression": "CC-BY-4.0" }
    }
  ],
  "declarations": [{ "text": "CC-BY-4.0" }]
}
```

Each binding identifies one independently licensed subject. Scopes are `data`,
`imagery`, `style`, `software` and `service`; an engine's code licence does not
license its output data. Standard grants use exact SPDX identifiers or pure
`AND`/`OR`/`WITH` expressions. A custom grant captures its `LicenseRef-...` ID,
namespace, human name, version when supplied and terms URL. OpenConditions uses
`openconditions:licences` for its curated custom definitions. Unknown declarations,
per-item grants, public-domain evidence and status marks remain explicit; do not
infer a grant from an unversioned name or public availability.

`declarations` preserve original evidence separately from presentation. Binding
`notice` and `conditions` preserve required wording and restrictions. The model
validates the bounded structure and rejects unsafe, credential-bearing links.
Labels and atom links derive from standard IDs in the consumer; custom labels
come from the captured definition, not a later registry lookup.

The publisher stamps the source and upstream publishers independently. Selected
flow field receipts retain the captured structure through JSONB, GeoJSON and
JSON-encoded MVT attributes. Deduplicate complete receipts, including custom
namespaces and notices; a source ID alone is not a complete credit identity.
An absent receipt does not prove a supplier, and malformed captured metadata must
never authorize fallback to a different current licence.

## Captured attribution placement

Display placement is separate from the reviewed redistribution/retention/usage
rights above. `AttributionPolicy` in the model is bounded, declarative metadata
on a captured licence binding. A feed can declare `attributionPolicy`; reviewed
custom licence placement definitions live in the ingest framework's
`reviewed-attribution-policies.ts`. `captureLicensing` copies the selected
source/product override with the record before storage. The existing JSONB,
GeoJSON and MVT contributor payloads retain it; no new migration or data backfill
is necessary. Retained records keep their captured requirements during outages
and later catalogue edits.

An override requires `placement` (`visible` or `details`), explicit `surfaces`
(`map`, `content`, `image`), `basis`, `reviewedAt`, primary `evidenceUrls` and a
`reason`. Visible policies may certify minimal `compactText` and select an
approved local host `logo`; unresolved policies cannot abbreviate or move credits
into details. `prominence: "normal"` preserves ordinary-size courtesy text.
`includePublisher: true` retains the actual issuing publisher beside the visible
service credit. MeteoAlarm acquisition captures the national issuing service
from the warning's actual CAP metadata, independently of the service name.
Do not infer an issuer from a country/domain or a software licence.

Consumers combine these source-specific policies with reviewed exact licence
placement defaults. CC BY 4.0 can support conspicuous one-action full details;
that does not override a provider's adjacent branding requirements. Unknown
agreements stay conservative. Do not choose an `OR` branch for the consumer,
replace actual image grants with platform metadata, or rewrite required notices
while shortening the visible name. Full notices, authors, source/licence links,
conditions and modifications must remain directly associated with displayed
items. Image/player branding remains on the relevant surface; selected flow
measurements retain only actual selected suppliers. Exports and recordings need
separate review because interactive details are unavailable there.
