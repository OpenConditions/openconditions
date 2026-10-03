# @openconditions/storage

The write side of the model record tables, shared by the ingest and
contributions services: one poll's situations, features, offers and
observations sealed against the registry and written in the caller's
transaction (revisions, tombstones, a per-class row cap), observation series
with their partitioned history and rollups, the partition maintenance and the
record sweep. Callers supply the registry and hold the source's advisory lock.

```ts
import { writeSnapshot } from "@openconditions/storage";
const summary = await writeSnapshot(
  sql,
  sourceId,
  { features, observations },
  {
    registry,
    instanceId,
    now,
    complete: { situation: true },
  },
);
```

The implementation was extracted from the ingest service and remains
AGPL-3.0-or-later. See [LICENSE](LICENSE) and [the repository licensing guide](../../LICENSING.md).
