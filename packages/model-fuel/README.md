# @openconditions/model-fuel

The fuel registry module of the OpenConditions data model: the `fuel` domain,
the `fuel_station` feature kind with one `fuel_product` component per priced
product, the price properties (`fuel.price`, `fuel.price_cap`,
`fuel.product_available`), the `fuel_grade` vocabulary, the `padd` district
scheme US regional averages are published per, and the crosswalks from the
DATEX II fuel vocabularies of both versions.

It holds definitions only and depends on `@openconditions/model` alone. The
assembled registry that includes this module is
`@openconditions/model-registry`. See [docs/model.md](../../docs/model.md).
