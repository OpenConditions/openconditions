# @openconditions/model-border

The border registry module of the OpenConditions data model: the `border`
domain, the `border_crossing` feature kind with its `lane_group` components
(one per inspection queue: mode, programme, direction and vehicle class), the
`border_wait_status` vocabulary, the structured `border_wait` result and the
`border.wait` property.

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
