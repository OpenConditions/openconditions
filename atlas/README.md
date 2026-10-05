# Feed atlas

`<domain>.json` is the public commons snapshot of one domain's feed catalogue
(`roads.json`, `fuel.json`, `parking.json`): the answer, for roads, fuel and
parking, to the Mobility
Database and Transitland feed registries. Each file holds two views of the same
catalogue:

- `files`: a remote feed bundle, keyed `<domain>/<region>` for each region file
  and `credentials` for the shared credential groups those files use. The
  region files are copied as written in `feeds/`, `$schema` included, so an
  instance can pull the atlas with `OPENCONDITIONS_FEEDS_REMOTE_URL` and check
  it like its baked catalogue.
- `feeds`: every feed as the loader resolves it (derived id, country, coverage,
  rights, cadence), each catalogue parent followed by all of its children,
  approved or discovered, under their child ids (`us-wzdx-<hash>-events`,
  `de-autobahn-<road>-<service>-events`). `file` names the region file it is
  written in.

## Regenerate

```bash
pnpm export:atlas
```

This resolves each catalogue (WZDx registry, Autobahn index) live, refreshes the
vendored snapshots under `packages/<domain>/src/catalog/snapshots/`, and rewrites
`atlas/<domain>.json`. A registry that cannot be read keeps its vendored
snapshot. Add `--offline` to resolve from the vendored snapshots without
touching the network:

```bash
pnpm export:atlas --offline
```

The weekly `atlas-refresh` workflow runs the live export and opens a pull
request when anything changed.
