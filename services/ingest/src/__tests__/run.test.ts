import { readFileSync } from "node:fs";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stampAttribution } from "../pipeline/publish.js";
import {
  createOpenlrClient,
  guardedFeedFetch,
  inspectSnapshotCompleteness,
} from "../pipeline/run.js";
import { repoFeed, testFeed } from "./helpers/catalog.js";
import { fakeLookup } from "./helpers/on-demand.js";

type SnapshotSource = Pick<CatalogFeed, "snapshot">;

describe("createOpenlrClient", () => {
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env["OPENLR_RESOLVER_URL"];
  });

  afterEach(() => {
    if (savedUrl === undefined) {
      delete process.env["OPENLR_RESOLVER_URL"];
    } else {
      process.env["OPENLR_RESOLVER_URL"] = savedUrl;
    }
  });

  it("returns null when OPENLR_RESOLVER_URL is not set", () => {
    delete process.env["OPENLR_RESOLVER_URL"];
    expect(createOpenlrClient()).toBeNull();
  });

  it("returns null when OPENLR_RESOLVER_URL is an empty string", () => {
    process.env["OPENLR_RESOLVER_URL"] = "";
    expect(createOpenlrClient()).toBeNull();
  });

  it("returns a MapMatchClient when OPENLR_RESOLVER_URL is set", () => {
    process.env["OPENLR_RESOLVER_URL"] = "https://openlr.example.com";
    const client = createOpenlrClient();
    expect(client).not.toBeNull();
    expect(typeof client!.resolve).toBe("function");
  });
});

describe("stampAttribution", () => {
  it("writes the catalogue's lineage and exact rights into a situation's attribution", () => {
    const draft = {
      id: "oc:situation:wzdx-kansas:1",
      provenance: {
        origin: "feed",
        sourceId: "wzdx-kansas",
        attribution: { provider: "a payload claim", license: "a payload claim" },
      },
    };
    const stamped = stampAttribution(
      draft,
      testFeed({
        id: "wzdx-kansas",
        attribution: "Kansas DOT",
        license: "CC0-1.0",
        parentSourceId: "us-wzdx-events",
        terms: {
          url: "https://example.test/kansas-terms",
          reviewedAt: "2026-09-11",
        },
      }),
    );

    expect((stamped["provenance"] as { attribution: unknown }).attribution).toMatchObject({
      provider: "Kansas DOT",
      license: "CC0-1.0",
      parentSourceId: "us-wzdx-events",
      childSourceId: "wzdx-kansas",
      policyIds: ["us-wzdx-events", "wzdx-kansas"],
      rights: {
        source_redistribution: "yes",
        derived_redistribution: "yes",
        commercial_use: "yes",
        attribution_required: "no",
        retention: "yes",
        evidence_origin: "https://example.test/kansas-terms",
        evidence_version: "CC0-1.0",
        reviewed_at: "2026-09-11T00:00:00.000Z",
      },
    });
  });
});

describe("inspectSnapshotCompleteness", () => {
  const source = {
    id: "complete-open511",
    snapshot: { completeness: "complete", recordsPath: "events" },
  } as SnapshotSource;

  it("recognizes a structurally valid complete empty snapshot", () => {
    expect(inspectSnapshotCompleteness(source, [Buffer.from('{"events":[]}')])).toEqual({
      complete: true,
      inputRecords: 0,
      completeEmpty: true,
    });
  });

  it("rejects a 200 body missing the declared record collection", () => {
    expect(() => inspectSnapshotCompleteness(source, [Buffer.from('{"message":"ok"}')])).toThrow(
      /events.*array/,
    );
  });

  it("rejects a declared total that does not match retrieved records", () => {
    expect(() =>
      inspectSnapshotCompleteness(
        { ...source, snapshot: { ...source.snapshot!, totalCountPath: "pagination.total" } },
        [Buffer.from('{"events":[{}],"pagination":{"total":2}}')],
      ),
    ).toThrow(/declared 2.*retrieved 1/);
  });

  it("recognizes a validated DATEX document with zero situation records", () => {
    const datex = {
      id: "complete-datex",
      snapshot: {
        completeness: "complete",
        rootElement: "d2LogicalModel",
        publicationElement: "payloadPublication",
        publicationType: "SituationPublication",
        recordElement: "situationRecord",
      },
    } as SnapshotSource;
    const xml = Buffer.from(
      '<?xml version="1.0"?><d2LogicalModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><payloadPublication xsi:type="SituationPublication"><publicationTime>2026-09-11T00:00:00Z</publicationTime></payloadPublication></d2LogicalModel>',
    );

    expect(inspectSnapshotCompleteness(datex, [xml])).toEqual({
      complete: true,
      inputRecords: 0,
      completeEmpty: true,
    });
  });

  it("rejects malformed XML before it can authorize an empty DATEX publication", () => {
    const datex = {
      id: "complete-datex",
      snapshot: {
        completeness: "complete",
        rootElement: "d2LogicalModel",
        publicationElement: "payloadPublication",
        publicationType: "SituationPublication",
        recordElement: "situationRecord",
      },
    } as SnapshotSource;

    expect(() => inspectSnapshotCompleteness(datex, [Buffer.from("<d2LogicalModel>")])).toThrow(
      /Invalid XML/,
    );
  });

  it("rejects unrelated well-formed XML before it can authorize an empty publication", () => {
    const datex = {
      id: "complete-datex",
      snapshot: {
        completeness: "complete",
        rootElement: "d2LogicalModel",
        publicationElement: "payloadPublication",
        publicationType: "SituationPublication",
        recordElement: "situationRecord",
      },
    } as SnapshotSource;

    expect(() =>
      inspectSnapshotCompleteness(datex, [Buffer.from("<html><body>maintenance</body></html>")]),
    ).toThrow(/d2LogicalModel/);
  });
});

describe("inspectSnapshotCompleteness — a DATEX II v3 publication at the root", () => {
  const xml = readFileSync(
    new URL(
      "../../../../packages/roads/src/__tests__/fixtures/cita-lu/situations.xml",
      import.meta.url,
    ),
  );
  const cita = repoFeed("lu-cita-events");

  it("counts the records of CITA's root SituationPublication", () => {
    expect(inspectSnapshotCompleteness(cita, [xml])).toEqual({
      complete: true,
      inputRecords: 7,
      completeEmpty: false,
    });
  });

  it("still refuses a root of another publication type", () => {
    const other = Buffer.from(
      xml.toString("utf8").replace('xsi:type="sit:SituationPublication"', 'xsi:type="sit:Other"'),
    );
    expect(() => inspectSnapshotCompleteness(cita, [other])).toThrow(/SituationPublication/);
  });
});

describe("inspectSnapshotCompleteness — the real NDW descriptor", () => {
  const xml = readFileSync(
    new URL(
      "../../../../packages/roads/src/__tests__/fixtures/ndw/restrictions-v3.xml",
      import.meta.url,
    ),
  );
  const ndw = repoFeed("nl-ndw-events");

  it("accounts for every situation record in the reviewed capture", () => {
    expect(inspectSnapshotCompleteness(ndw, [xml])).toEqual({
      complete: true,
      inputRecords: 6,
      completeEmpty: false,
    });
  });

  it("treats a valid publication with no situations as an explicit withdrawal", () => {
    // Remove only the situations, keeping the real envelope and publication
    // metadata: an empty publication is a withdrawal, not a malformed document.
    const empty = Buffer.from(
      xml.toString("utf8").replace(/<sit:situation\b[\s\S]*<\/sit:situation>/, ""),
    );
    expect(inspectSnapshotCompleteness(ndw, [empty])).toEqual({
      complete: true,
      inputRecords: 0,
      completeEmpty: true,
    });
  });

  it.each([
    ["truncated XML", "<mc:messageContainer>"],
    ["an HTML maintenance page", "<html><body>maintenance</body></html>"],
    [
      "the wrong publication type",
      '<?xml version="1.0"?><messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><payload xsi:type="sit:SituationPublicationOther"/></messageContainer>',
    ],
    [
      "the wrong root element",
      '<?xml version="1.0"?><d2LogicalModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><payload xsi:type="sit:SituationPublication"/></d2LogicalModel>',
    ],
  ])("rejects %s rather than clearing the source", (_label, body) => {
    expect(() => inspectSnapshotCompleteness(ndw, [Buffer.from(body)])).toThrow();
  });
});

describe("guardedFeedFetch — an endpoint's own time limit", () => {
  const slow = (async (_url: string | URL | Request, init?: RequestInit) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    });
    return new Response("late");
  }) as typeof fetch;
  let timeout: string | undefined;
  beforeEach(() => {
    timeout = process.env["OPENCONDITIONS_FETCH_TIMEOUT_MS"];
    process.env["OPENCONDITIONS_FETCH_TIMEOUT_MS"] = "100";
  });
  afterEach(() => {
    if (timeout === undefined) delete process.env["OPENCONDITIONS_FETCH_TIMEOUT_MS"];
    else process.env["OPENCONDITIONS_FETCH_TIMEOUT_MS"] = timeout;
  });

  it("waits for a slow publisher as long as its endpoint allows", async () => {
    const res = await guardedFeedFetch(
      { fetch: slow, lookup: fakeLookup },
      2,
    )("https://slow.example.com/");
    expect(await res.text()).toBe("late");
  });

  it("keeps the operator's limit otherwise, and an endpoint never shortens it", async () => {
    await expect(
      guardedFeedFetch({ fetch: slow, lookup: fakeLookup })("https://slow.example.com/"),
    ).rejects.toThrow(/timed out after 100ms/);
    process.env["OPENCONDITIONS_FETCH_TIMEOUT_MS"] = "2000";
    const res = await guardedFeedFetch(
      { fetch: slow, lookup: fakeLookup },
      0.01,
    )("https://slow.example.com/");
    expect(await res.text()).toBe("late");
  });
});
