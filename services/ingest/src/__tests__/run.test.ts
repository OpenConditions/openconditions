import { readFileSync } from "node:fs";
import { FEED_SOURCES, type RoadEvent } from "@openconditions/roads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainFeedSource } from "../pipeline/run.js";
import {
  createOpenlrClient,
  inspectSnapshotCompleteness,
  stampSourceEvidence,
} from "../pipeline/run.js";

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

describe("stampSourceEvidence", () => {
  it("persists qualified catalogue lineage and exact rights on an observation", () => {
    const event = {
      id: "wzdx-kansas:1",
      source: "wzdx-kansas",
      origin: { kind: "feed", attribution: { provider: "Kansas DOT", license: "CC0-1.0" } },
    } as RoadEvent;
    const stamped = stampSourceEvidence(event, {
      id: "wzdx-kansas",
      parentSourceId: "us-wzdx",
      rights: {
        sourceRedistribution: true,
        derivedRedistribution: true,
        commercialUse: true,
        attributionRequired: false,
        retention: true,
        evidenceOrigin: "feed_info.license",
        evidenceVersion: "CC0-1.0",
        reviewedAt: "2026-09-11T00:00:00.000Z",
      },
    } as DomainFeedSource);

    expect(stamped.origin.attribution).toMatchObject({
      parentSourceId: "us-wzdx",
      childSourceId: "wzdx-kansas",
      policyIds: ["us-wzdx", "wzdx-kansas"],
      rights: {
        source_redistribution: "yes",
        derived_redistribution: "yes",
        commercial_use: "yes",
        attribution_required: "no",
        retention: "yes",
      },
    });
  });
});

describe("inspectSnapshotCompleteness", () => {
  const source = {
    id: "complete-open511",
    snapshot: { completeness: "complete", recordsPath: "events" },
  } as DomainFeedSource;

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
    } as unknown as DomainFeedSource;
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
    } as unknown as DomainFeedSource;

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
    } as unknown as DomainFeedSource;

    expect(() =>
      inspectSnapshotCompleteness(datex, [Buffer.from("<html><body>maintenance</body></html>")]),
    ).toThrow(/d2LogicalModel/);
  });
});

describe("inspectSnapshotCompleteness — the real NDW descriptor", () => {
  const xml = readFileSync(
    new URL(
      "../../../../packages/roads/src/__tests__/fixtures/ndw/restrictions-v3.xml",
      import.meta.url,
    ),
  );
  const ndw = FEED_SOURCES.find((f) => f.id === "nl-ndw") as unknown as DomainFeedSource;

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
