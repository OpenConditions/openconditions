# @openconditions/model-roads

The roads registry module of the OpenConditions data model: the `roads`
domain, its situation kinds with their types, subtypes and `details` schemas,
the road infrastructure it measures and signs (measurement sites, variable
message signs, cameras, their components and the `traffic.*`, `vms.display`,
`camera.image` and `device.status` properties), the network's fixed things
(structures with their clearances, level crossings, blackspots, emergency
phones, lane-control gantries), the winter registers (mountain passes and
chain-control zones with `pass.status` and `winter.chain_level`),
travel-time routes with `traffic.travel_time`, tolls (toll points and
sections, the `toll` offer and `toll.price`), `structureRestrictions`, which
derives the standing restrictions a structure imposes, the crosswalks to DATEX II,
WZDx, Open511, IBI 511, TraFF, GTFS-RT and Road511, and the normalized
vehicle-restriction contract
(`RoadRestrictionDetailsV1`) with its mapping onto kernel effects.

It holds definitions only and depends on `@openconditions/model` alone, so
consumers can read the roads vocabulary without parsers, storage or ingest
code. The assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
