# @openconditions/model

The OpenConditions data model: kernel types (location, provenance, validity,
vehicle applicability, effects, results), the four record classes (feature,
situation, observation, offer), and the registry that closes the taxonomy —
`defineKind`, `defineProperty`, `defineVocabulary`, `defineEffect`,
`defineSelector`, `defineResultSchema` — with hard validation, JSON Schema,
CHECK-constraint and docs generation.

It depends on no other OpenConditions package. See
[docs/model.md](../../docs/model.md) for the model and the generated registry
reference; the assembled registry and its published JSON Schemas live in
`@openconditions/model-registry`.
