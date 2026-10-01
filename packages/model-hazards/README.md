# @openconditions/model-hazards

The hazards registry module of the OpenConditions data model: the
`hazards` domain, the `alert` situation kind for warnings issued as CAP
messages (classified by what they warn of, with the publishers' event lists
of DWD, the Canadian CAP profile, NWS VTEC, MeteoAlarm and SAME as
crosswalks), the `natural_hazard` kind for hazard events themselves
(wildfire perimeters, burnt areas, smoke, floods, earthquakes), the
`fire.frp` and `fire.brightness` properties of satellite fire pixels, and
helpers for CAP's own encodings (references, polygons, circles).

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
