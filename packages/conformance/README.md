# @openconditions/conformance

Test-only. It holds what OpenConditions reads and writes against the standards' own
schemas instead of against copies of them.

## Pinned schemas

Each standard is a `PinnedSet` in `src/standards/<standard>.ts`, imported as
`@openconditions/conformance/standards/<standard>`. A set lists every schema file by
URL (or by member of a zip archive) with its SHA-256. `pinnedFiles(set)` serves it from
`node_modules/.cache/conformance/<id>/`, downloading what is missing; a file whose
checksum differs fails the test, so an upstream change never silently moves the schema
the code is held to. Several standards bodies publish their schemas without a licence
that permits copying them, which is why none are vendored.

`pinnedOrUnavailable(set)` is what a suite's `beforeAll` uses: under `CI` a fetch
failure throws, while an offline local run gets the reason to skip with.

To pin a new file, download it, record `shasum -a 256` of the bytes, and note the page
it was found on and the retrieval date beside the set.

## Checks

- `xsdErrors(xml, files, rootSchema)`: libxml2 validation against an XSD set.
- `jsonSchemaValidator(schema, { refs })` and `openApiValidator(doc, componentName)`:
  Ajv validation, with formats, in the schema's own dialect.
- `xsdEnumerations` / `xsdEnumeration`, `xsdComplexTypes` / `xsdSubtypes`,
  `jsonSchemaEnums` / `definitionEnum`: the value lists and record types a standard
  defines, read from its schema rather than copied by hand.
- `assertCovered(label, values, { handled, unsupported })`: every value is either
  handled, best shown by running the real parser over a record carrying it, or
  listed as unsupported with the reason. A listed value the standard no longer has,
  or one the code handles after all, fails as well.

The import-boundary check lets any test import this package and keeps it out of
production code.
