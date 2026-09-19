# @openconditions/model-weather

The weather registry module of the OpenConditions data model: the `weather`
domain, the `weather_station` feature kind, the measured and forecast
meteorological and road-surface properties (`weather.*`, `road.*`), the
`precipitation_type` vocabulary, and the crosswalks from DATEX II measured
weather values, precipitation types and road-surface condition types.

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
