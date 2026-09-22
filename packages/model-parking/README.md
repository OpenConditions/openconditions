# @openconditions/model-parking

The parking registry module of the OpenConditions data model: the `parking`
domain, the `parking_site` feature kind with its `parking_area` and
`parking_space` components, the occupancy properties (`parking.available`,
`parking.occupied`, `parking.occupancy_pct`, `parking.status`,
`parking.trend`), the `parking_rate` offer, the `parking_status` and
`parking_security` vocabularies, and the crosswalks from DATEX II v2 and v3
parking and from ParkAPI v3.

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
