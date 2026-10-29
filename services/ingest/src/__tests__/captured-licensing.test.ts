import {
  admitsCatalogChild,
  type CatalogFeed,
  createFetchState,
  effectiveRights,
  fetchEndpoint,
  isPublicLicense,
} from "@openconditions/ingest-framework";
import { Attribution, contentHash } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { attributionStamp, stampAttribution } from "../pipeline/publish.js";
import { repoFeed } from "./helpers/catalog.js";
import { situationDraft } from "./helpers/situations.js";

const source = {
  id: "example",
  name: "Named dataset",
  license: "LicenseRef-TfL-Transport-Data-Service",
  attribution: "Required provider wording",
  homepage: "https://example.test/data",
  rights: {
    display: true,
    redistribution: true,
    derivedRedistribution: true,
    commercialUse: true,
    attributionRequired: true,
    retention: true,
  },
  terms: { notice: "© Distinct publisher", note: "Keep source date" },
  // No terms.url or review date: the grants are an unchecked claim.
  evidence: null,
  permissions: {
    display: "unknown",
    redistribute: "unknown",
    derive: "unknown",
    retain: "unknown",
    commercial: "unknown",
  },
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

it("captures the actual national issuer of a MeteoAlarm warning without changing its grant", () => {
  const stamped = stampAttribution(
    {
      provenance: {},
      details: {
        cap: { senderName: [{ lang: "de", text: "Actual NMHS" }], web: "https://warning.test/" },
      },
    },
    { ...source, format: "meteoalarm" },
  );
  expect(
    Attribution.parse((stamped.provenance as { attribution: unknown }).attribution).publisher?.name,
  ).toBe("Actual NMHS");
  expect(stamped).toMatchObject({
    provenance: {
      attribution: { publisher: { name: "Actual NMHS", url: "https://warning.test/" } },
    },
  });
});

it("stamps one poll's drafts with one attribution, unless a draft names its own publisher", () => {
  const stamp = attributionStamp({ ...source, format: "meteoalarm" });
  const attributionOf = (draft: Record<string, unknown>) =>
    (stamp(draft).provenance as { attribution: unknown }).attribution;
  const first = attributionOf({ provenance: { recordId: "a" } });
  const second = attributionOf({ provenance: { recordId: "b" } });
  const issued = attributionOf({
    provenance: { recordId: "c" },
    details: { cap: { senderName: "Actual NMHS" } },
  });
  expect(second).toBe(first);
  expect(first).toEqual(
    (
      stampAttribution({ provenance: {} }, { ...source, format: "meteoalarm" }).provenance as {
        attribution: unknown;
      }
    ).attribution,
  );
  expect(issued).not.toBe(first);
  expect(issued).toMatchObject({ publisher: { name: "Actual NMHS" } });
});

it("does not emit an invalid publisher or truncate the CAP originator when localized names exceed the bound", () => {
  const draft = {
    provenance: {},
    details: {
      cap: {
        senderName: [
          { lang: "en", text: "x".repeat(1001) },
          { lang: "de", text: "Actual NMHS" },
        ],
        web: "https://warning.test/?api_key=secret",
      },
    },
  };
  const stamped = stampAttribution(draft, { ...source, format: "meteoalarm" });
  const attr = Attribution.parse((stamped.provenance as { attribution: unknown }).attribution);
  expect(attr.publisher).toEqual({ name: "Actual NMHS" });
  const invalidOnly = stampAttribution(
    { ...draft, details: { cap: { senderName: "x".repeat(1001) } } },
    { ...source, format: "meteoalarm" },
  );
  expect(
    Attribution.parse((invalidOnly.provenance as { attribution: unknown }).attribution).publisher,
  ).toBeUndefined();
});

describe("National Highways acquisition terms", () => {
  it("publishes the custom reuse grant without asserting indefinite retention or catalogue admission", () => {
    const feed = repoFeed("gb-nationalhighways-events");
    const attr = Attribution.parse(
      (stampAttribution({ provenance: {} }, feed).provenance as { attribution: unknown })
        .attribution,
    );
    expect(attr.license).toBe("LicenseRef-National-Highways-Transport-Data-Feeds");
    expect(attr.licensing?.bindings[0].license).toEqual({
      kind: "custom",
      namespace: "openconditions:licences",
      id: "LicenseRef-National-Highways-Transport-Data-Feeds",
      name: "National Highways Transport Data Feeds Licence (OGL v2.0 with NH amendments)",
      url: "https://developer.data.nationalhighways.co.uk/terms",
    });
    expect(feed.rights).toEqual({
      display: true,
      redistribution: true,
      derivedRedistribution: true,
      commercialUse: true,
      attributionRequired: true,
      retention: null,
      shareAlike: false,
    });
    expect(feed.restricted).toBe(false);
    expect(isPublicLicense(attr.license)).toBe(true);
    expect(admitsCatalogChild(feed.rights)).toBe(false);
    expect(attr.rights).toMatchObject({
      source_redistribution: "yes",
      derived_redistribution: "yes",
      commercial_use: "yes",
      attribution_required: "yes",
      retention: "unknown",
      evidence_origin: "https://developer.data.nationalhighways.co.uk/terms",
      reviewed_at: "2026-10-14T00:00:00.000Z",
    });
  });

  it("captures the exact acknowledgement, unresolved placement and separate access conditions", () => {
    const feed = repoFeed("gb-nationalhighways-events");
    const attr = Attribution.parse(
      (stampAttribution({ provenance: {} }, feed).provenance as { attribution: unknown })
        .attribution,
    );
    expect(attr.provider).toBe("Powered by National Highways’ Transport Data Feeds");
    const binding = attr.licensing?.bindings[0];
    expect(binding?.notice).toBe("Powered by National Highways’ Transport Data Feeds");
    expect(binding?.attribution).toMatchObject({ placement: "visible", basis: "unresolved" });
    const conditions = binding?.conditions?.join(" ") ?? "";
    expect(conditions).toMatch(/paragraph 19.*copy.*distribut.*adapt.*commercial/i);
    expect(conditions).toMatch(/paragraph 20.*brand.*registration/i);
    expect(conditions).toMatch(
      /paragraph 21e.*separate written permission.*automated.*unverified/i,
    );
    expect(conditions).toMatch(/paragraph 21c.*rights.*end/i);
  });

  it("reacquires identical payloads after the feed terms change and restamps retained records", async () => {
    const feed = repoFeed("gb-nationalhighways-events");
    const old: CatalogFeed = {
      ...feed,
      license: "OGL-UK-3.0",
      licenseUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
      attribution: "Contains National Highways data © Crown copyright and database right",
      terms: undefined,
      rights: effectiveRights("OGL-UK-3.0"),
    };
    const state = createFetchState();
    const conditionalHeaders: (string | null)[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const conditional = new Headers(init?.headers).get("If-None-Match");
      conditionalHeaders.push(conditional);
      return conditional
        ? new Response(null, { status: 304 })
        : new Response("unchanged NH payload", { headers: { ETag: '"same-payload"' } });
    };
    const options = { state, env: { GB_NATIONALHIGHWAYS_EVENTS_API_KEY: "test-key" } };
    const first = await fetchEndpoint(old, "main", fetchFn, options);
    expect(first.status).toBe("fetched");
    if (first.status !== "fetched") throw new Error("expected initial payload");
    first.accept();
    expect((await fetchEndpoint(old, "main", fetchFn, options)).status).toBe("not-modified");
    const refreshed = await fetchEndpoint(feed, "main", fetchFn, options);
    expect(refreshed.status).toBe("fetched");
    if (refreshed.status !== "fetched") throw new Error("expected reacquired payload");
    expect(refreshed.buffers).toEqual(first.buffers);
    expect(refreshed.bodyFreshness).toBe("acquired");
    expect(conditionalHeaders).toEqual([null, '"same-payload"', null]);
    const retained = stampAttribution(situationDraft("nh-record", {}, feed.id), old);
    const updated = stampAttribution(retained, feed);
    const attr = Attribution.parse((updated.provenance as { attribution: unknown }).attribution);
    expect(attr.licensing?.bindings[0].notice).toBe(
      "Powered by National Highways’ Transport Data Feeds",
    );
    expect(attr.license).toBe("LicenseRef-National-Highways-Transport-Data-Feeds");
    expect(contentHash(updated)).not.toBe(contentHash(retained));
    expect(
      Attribution.parse((retained.provenance as { attribution: unknown }).attribution).license,
    ).toBe("OGL-UK-3.0");
  });
});
