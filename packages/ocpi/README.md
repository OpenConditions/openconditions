# @openconditions/ocpi

OCPI wire types, decoders and normalizers for Node.js 24 or newer. This is the sole initial public-package qualification candidate in OpenConditions; qualification does not mean it has been published to npm. Use the retained, qualified tarball for independent evaluation. Registry publication and scope ownership are separate decisions.

The package provides ESM, CommonJS and declarations for both module systems. Its only installed dependency is `@types/node` for the public `Buffer` signatures; runtime code uses Node built-ins and has no OpenConditions workspace dependency. TypeScript consumers need Node typings available in their project and should use NodeNext module resolution. The external qualification uses TypeScript 6 with strict checking and `skipLibCheck: false`.

## Decode and normalize

```js
import { decodeOcpiList, normaliseLocation, normaliseTariff } from "@openconditions/ocpi";

const bytes = Buffer.from(
  JSON.stringify({
    status_code: 1000,
    data: [{ id: "L1", coordinates: { latitude: "50.77", longitude: "6.08" }, evses: [] }],
  }),
);
const locations = decodeOcpiList(bytes).map(normaliseLocation);
const tariff = normaliseTariff({
  id: "T1",
  currency: "eur",
  elements: [{ price_components: [{ type: "ENERGY", price: 0.45 }] }],
});
console.log(locations[0].coordinates, tariff.currency);
```

`normaliseLocation` and `normaliseTariff` also accept individual parsed objects. CommonJS consumers can use `const { normaliseLocation } = require("@openconditions/ocpi")`. A TypeScript caller can import `OcpiLocation` and `OcpiTariff` as types. The `decodeOcpiList<T>` type argument describes the caller's expected raw shape; it performs no generic schema validation.

`decodeOcpiList` accepts bare arrays, OCPI `data` envelopes and OCPDB `items` pages. A numeric OCPI status outside 1000–1999, a missing list or invalid JSON throws `OcpiDecodeError`. Normalizers reject missing identifiers, unreadable required fields and missing location coordinates. `OcpiDecodeError.reason` distinguishes `malformed` from `no_geometry`:

```js
import { normaliseLocation, OcpiDecodeError } from "@openconditions/ocpi";

try {
  normaliseLocation({ id: "without-coordinates" });
} catch (error) {
  if (!(error instanceof OcpiDecodeError)) throw error;
  console.log(error.reason); // "no_geometry"
}
```

Coordinates are read as latitude/longitude, including numeric strings. Presence of usable coordinates is not a complete geometry or deployment-boundary validation. Callers remain responsible for their application's geographic and plausibility checks.

## Supported surface and dialects

The root export deliberately retains these existing runtime functions and class:

- `decodeOcpiList`, `normaliseLocation`, `normaliseTariff`, `OcpiDecodeError`.
- `connectorPowerKw`, `normaliseEmi3`, and the small normalization helpers `isRecord`, `text`, `num`.
- `digitrafficLocation`, `fromDigitraffic`, `digitrafficStatuses`, `digitrafficTariffs`.
- `ocpdbAssociations`, `ocpdbSources`.

The root also exports `RawRecord`, `DigitrafficStatus`, `OcpdbSource`, and the `Ocpi*` wire interfaces for locations, EVSEs, connectors, business details, opening times, images, energy mixes, prices, tariffs and restrictions. Subpath imports are not supported.

Captured NDW, Via Lietuva and OCPDB dialects use the same normalizers as standard OCPI objects. Supported fields include OCPI 2.2.1 and 2.3.0 additions, with tolerant numeric/string IDs, optional nulls and open enumeration values where the implementation preserves them. Pinned official 2.2.1 and 2.3.0 schema tests document tested projections and known source deviations; the decoders are not universal OCPI validators, a protocol server or an OCPI 3.0 implementation.

Digitraffic adapters read its feature collection, camelCase fields and separate status/tariff payloads. Connector IDs are their one-based positions when the source has none. Status timestamps prefer `lastUpdatedAt`, then `modifiedAt`; locations retain the source's `modifiedAt` and use `Europe/Helsinki`. Malformed status/tariff entries invoke the supplied callback instead of silently counting as valid entries.

OCPDB associations use an association's `id` for the 2.2 tariff endpoint and fall back to `tariff_id` only when `id` is absent. `ocpdbSources` preserves source licence/contributor metadata. These mappings do not infer tariff applicability from names.

Normalizers preserve source timestamp text and do not invent a fetch time or freshness verdict. Unknown or unreadable tariff restrictions remain marked in `restrictions.unreadable`; consumers must not treat those elements as unconditionally applicable. Power is expressed in kW, using published watts when present, otherwise voltage/amperage and known phases. These are wire-level results; OpenConditions charging-domain policy is outside this package.

## Bounds and responsibilities

Decoding is synchronous and buffers/parses the supplied JSON. There is no built-in payload-byte, object-depth, page-count, rate or execution-time budget. Bound inputs before calling, especially the recursive Digitraffic key conversion. The package performs no HTTP requests, pagination, credential handling, authentication, authorization, retries or egress filtering. Error messages may include source identifiers and parse diagnostics; apply your own logging and secret-handling boundary.

The packed ESM/CJS bundles, source maps and declarations contain OCPI's source only. The repository's AGPL conformance helper, official schemas and captured provider fixtures are test inputs and are not distributed. Code is Apache-2.0; see the included `LICENSE` and `NOTICE`. Provider data retains its own rights and attribution requirements. This package grants no rights to a feed's data.

## Qualify a tarball without publishing

From the repository root, `pnpm check:packed-packages --output /tmp/ocpi-candidate` requires a new empty output directory and builds and packs with the pinned pnpm version, then checks the actual archive in an external consumer. It retains the tarball and a JSON receipt. The consumer installs with lifecycle scripts disabled and checks all runtime exports, ESM, CJS and both declaration branches with strict TypeScript. No workspace links or repository aliases are used.

To recheck retained bytes, supply `--tarball /path/to/candidate.tgz --sha256 "$CANDIDATE_SHA256"`, optionally with `--output /path/to/proof`. Supplied mode does not build or repack. It checks the expected SHA-256 before use, installs a copy of those bytes, and checks the original again afterward. Receipts are created exclusively and never replace an existing file. The supported archive is the pinned packer's regular-file USTAR output; unknown files, links or other archive formats fail qualification. Keep the accepted bytes and receipt together. This command provides qualification evidence and performs no registry publication.
