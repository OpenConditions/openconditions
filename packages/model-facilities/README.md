# @openconditions/model-facilities

The facilities registry module of the OpenConditions data model: the
`facilities` domain, the `rest_area` and `weigh_station` feature kinds, the
`facility_open_status` vocabulary and the `facility.open_status` property,
which every feature kind with the kernel's `operated_site` trait carries, and
the crosswalk from DATEX II v2 and v3 opening statuses.

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
