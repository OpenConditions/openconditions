# road-conditions-atlas (seed)

`roads.json5` is the vendored seed of the public **road-conditions-atlas** commons
artifact: a flat list of road-condition feed descriptors — each carrying its
URL (or `catalog` resolver reference), data `license`, `format`, geographic
coverage (`country`), and any `auth`/`setup` acquisition guide. It is the
road-domain answer to the Mobility Database / Transitland feed registries.

The file is generated from two sources merged and de-duped by feed `id`:

1. the curated `FEED_SOURCES` registry (`packages/roads/src/feeds.ts`), serialised
   as pure data (any non-serialisable field is dropped); and
2. the flattened output of the catalog resolvers (`wzdx-registry`,
   `autobahn-index`) — the concrete WZDx + Autobahn feeds.

`catalog` feeds keep their catalog pointer (they are not expanded); the concrete
resolver outputs are appended alongside.

## Regenerate

```bash
pnpm --filter @openconditions/roads export:atlas
```

This pulls the WZDx + Autobahn registries live, refreshes the vendored snapshots
under `src/catalog/snapshots/`, and rewrites `roads.json5`. Add `--offline` to
resolve from the vendored snapshots without touching the network (for CI or
regeneration without upstream access):

```bash
pnpm --filter @openconditions/roads export:atlas --offline
```

The output is written as plain JSON into a `.json5` file (JSON is a valid JSON5
subset); the JSON5 reader arrives with the data-file externalization work.

## Follow-up

Publishing `roads.json5` to a standalone public `openconditions/road-conditions-atlas`
repository — the first-mover road-domain feed commons, consumed by the layered
remote-pull feed delivery — is a tracked follow-up.
