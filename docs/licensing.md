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
