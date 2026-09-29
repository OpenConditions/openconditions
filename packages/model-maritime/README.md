# @openconditions/model-maritime

The maritime registry module of the OpenConditions data model: the
`maritime` domain, the `ferry_route` feature kind with its `ferry_leg`
components, `ferry_terminal`, the `ferry_status` vocabulary, the
`ferry.status` and `ferry.vehicle_space` properties (per sailing, named by
its departure), the `fare` offer, and the NeTEx id schemes ferries are known
by in national timetables.

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
