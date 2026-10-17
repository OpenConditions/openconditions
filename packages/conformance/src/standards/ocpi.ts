import type { PinnedSet } from "../pinned.js";

/**
 * OCPI 2.2.1 and 2.3.0 as the EV Roaming Foundation's OpenAPI 3.1 description:
 * the `ocpi/openapi-specification` repository of the `ocpi` GitHub
 * organisation, whose rendering https://evroaming.org/ocpi-downloads/ links as
 * the "OCPI v2.2.1 – OpenAPI Docs" and "OCPI v2.3.0 OpenAPI Docs". The
 * specification itself (`ocpi/ocpi`, tags `v2.2.1-d2` and `v2.3.0`) is
 * AsciiDoc only and carries no schema. The repository has no tags, so the
 * files are pinned at commit `7bacd82ba531fc565fc6d7a09a49d4dabd3aaef0`
 * (2026-05-13). Retrieved 2026-10-17.
 *
 * Each version pins the Locations and Tariffs module schemas and every file
 * their `$ref`s reach: the shared components, and Tokens, Sessions and CDRs
 * (`PublishTokenType` names Tokens' `TokenType`, Tokens names a Sessions type
 * and Sessions names CDRs' types). A file's `name` is its path below the
 * version directory, so a relative `$ref` resolves against it.
 *
 * The OpenAPI repository states no licence. The specification text is
 * copyright of the EVRoaming Foundation, "made available under the Creative
 * Commons Attribution-NoDerivatives 4.0 International Public License"
 * (`copyright.asciidoc`); either way the files are fetched, not vendored.
 */
const COMMIT = "7bacd82ba531fc565fc6d7a09a49d4dabd3aaef0";
const BASE = `https://raw.githubusercontent.com/ocpi/openapi-specification/${COMMIT}/ocpi/`;

const file = (version: string, name: string, sha256: string) => ({
  name,
  url: `${BASE}${version}/${name}`,
  sha256,
});

export const OCPI_2_2_1: PinnedSet = {
  id: "ocpi-2.2.1-openapi",
  files: [
    file(
      "2.2.1",
      "components/schema.yaml",
      "01b58cbebc9bb9ebc1b07af9ca9c78a56fe429a051e94c10ecef96391e797c1d",
    ),
    file(
      "2.2.1",
      "modules/locations/schema.yaml",
      "99bc8acff83cd69159d0c8cccd0539795c181ff8d1ce58fb439ea31e01ea3d6e",
    ),
    file(
      "2.2.1",
      "modules/tariffs/schema.yaml",
      "ad10ed628537f4589da4ef0d725d5643d8a1a91a448d4e8dcd2a3a3bcb09074b",
    ),
    file(
      "2.2.1",
      "modules/tokens/schema.yaml",
      "12bb2f4d3dae1cf075b9cde5b3146aef8fc00c327d5169e7c2685e981b3ffaae",
    ),
    file(
      "2.2.1",
      "modules/sessions/schema.yaml",
      "1b042ab48f0e01c86388683c76276b6e8997dd62d3ce2eb5ebc1976d18f0f855",
    ),
    file(
      "2.2.1",
      "modules/cdrs/schema.yaml",
      "9a752a2110386c86e2aa69227478ab8bfefd9912ac3d095e7ae237b3523a1c04",
    ),
  ],
};

export const OCPI_2_3_0: PinnedSet = {
  id: "ocpi-2.3.0-openapi",
  files: [
    file(
      "2.3.0",
      "components/schema.yaml",
      "d8986a1f8b2b78c90187aa401f780999f6bfb972acdd0985f67c0f4a167ae9f3",
    ),
    file(
      "2.3.0",
      "modules/locations/schema.yaml",
      "4e31fc0a1028eaecdabb6e382897d16ae4c677adffb261290258a7d8b217b368",
    ),
    file(
      "2.3.0",
      "modules/tariffs/schema.yaml",
      "2404330378cd2a4084d308a88e70dd58057d3011f2339a5d7e1cdd61c0c3c2d7",
    ),
    file(
      "2.3.0",
      "modules/tokens/schema.yaml",
      "8a53d813308fe2360cf1a8c83e474723f46010aa799f02fcd5b078c4af84565a",
    ),
    file(
      "2.3.0",
      "modules/sessions/schema.yaml",
      "1b042ab48f0e01c86388683c76276b6e8997dd62d3ce2eb5ebc1976d18f0f855",
    ),
    file(
      "2.3.0",
      "modules/cdrs/schema.yaml",
      "30f2e88fdd3d02ddce5fe18f941b2333044508f5b6e3e93619ae7860e24eb541",
    ),
  ],
};
