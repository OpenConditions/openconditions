# @openconditions/model-roads

The roads registry module of the OpenConditions data model: the `roads`
domain, its situation kinds with their types, subtypes and `details` schemas,
the crosswalks to DATEX II, WZDx, Open511, IBI 511, TraFF, GTFS-RT and
Road511, and the normalized vehicle-restriction contract
(`RoadRestrictionDetailsV1`) with its mapping onto kernel effects.

It holds definitions only and depends on `@openconditions/model` alone, so
consumers can read the roads vocabulary without parsers, storage or ingest
code. The assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
