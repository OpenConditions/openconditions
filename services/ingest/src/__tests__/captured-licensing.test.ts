import type { CatalogFeed } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { stampAttribution } from "../pipeline/publish.js";

const source = {
  id: "example",
  name: "Named dataset",
  license: "LicenseRef-TfL-Transport-Data-Service",
  attribution: "Required provider wording",
  homepage: "https://example.test/data",
  rights: {
    redistribution: true,
    derivedRedistribution: true,
    commercialUse: true,
    attributionRequired: true,
    retention: true,
  },
  terms: { notice: "© Distinct publisher", note: "Keep source date" },
} as CatalogFeed;

describe("acquisition captures licence definitions", () => {
  it("stamps immutable definitions and every upstream publisher while preserving policy identity", () => {
    const stamped = stampAttribution(
      {
        provenance: { attribution: {}, upstream: [{ publisher: "Borough", license: "CC-BY-4.0" }] },
      },
      source,
    );
    expect(stamped).toMatchObject({
      provenance: {
        attribution: {
          license: source.license,
          licensing: {
            version: 1,
            bindings: [
              {
                license: {
                  kind: "custom",
                  id: source.license,
                  name: "TfL Transport Data Service licence (OGL v2.0 with TfL amendments)",
                },
                notice: "© Distinct publisher",
                conditions: ["Keep source date"],
              },
            ],
          },
        },
        upstream: [
          {
            licensing: {
              version: 1,
              bindings: [{ license: { kind: "spdx", expression: "CC-BY-4.0" } }],
            },
          },
        ],
      },
    });
  });
});

it("captures every configured and disabled feed's reviewed metadata without losing declarations", async () => {
  const { captureLicensing } = await import("@openconditions/ingest-framework");
  const { REPO_CATALOG } = await import("./helpers/catalog.js");
  for (const feed of [
    ...REPO_CATALOG.feeds,
    ...REPO_CATALOG.discovered,
    ...REPO_CATALOG.disabled,
  ]) {
    const captured = captureLicensing(feed);
    expect(captured.declarations?.[0].text, feed.id).toBe(feed.license);
    expect(captured.bindings[0].subject, feed.id).toBe(feed.name);
    if (feed.terms?.notice) expect(captured.bindings[0].notice, feed.id).toBe(feed.terms.notice);
    if (feed.terms?.note)
      expect(captured.bindings[0].conditions, feed.id).toEqual([feed.terms.note]);
  }
});
