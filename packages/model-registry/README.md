# @openconditions/model-registry

The assembled OpenConditions production registry: `productionModules` (the
kernel module plus every `@openconditions/model-<domain>` module) and
`productionRegistry()`, the closed registry services validate and seal records
with. `schemas/` holds the published JSON Schema of every registry entry.

It depends only on model packages. Storage and the domain parser packages never
import it; see [docs/model.md](../../docs/model.md).
