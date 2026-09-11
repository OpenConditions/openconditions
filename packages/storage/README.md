# @openconditions/storage

Pure observation-to-database row projection and deterministic content hashing,
shared by the ingest and contributions services. Callers supply domain attributes
explicitly; this package does not own a registry, perform SQL, normalize inputs,
or decide writer authority.

```ts
import { toRow } from "@openconditions/storage";
const row = toRow(normalizedObservation, domainAttributes);
```

The implementation was extracted from the ingest service and remains
AGPL-3.0-or-later. See [LICENSE](LICENSE) and [the repository licensing guide](../../LICENSING.md).
