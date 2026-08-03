import { describe, expect, it } from "vitest";
import {
  checkMobilithekReference,
  mobilithekReferenceFileUrl,
  type MobilithekOfferMetadata,
} from "../lib/mobilithek-reference.js";

const latestOffer: MobilithekOfferMetadata = {
  contentStandard: [
    {
      accessURL: "/748580849261105152/D2MSTPub_LVE_123_11.xml",
      modified: "2025-05-20T10:21:53Z",
      instance: { fileName: "D2MSTPub_LVE_123_11.xml", byteSize: 40391188 },
    },
    {
      accessURL: "/748580849261105152/MeasuredData_2017_01-00-00.xsd",
      modified: "2025-05-20T10:22:06Z",
      instance: { fileName: "MeasuredData_2017_01-00-00.xsd", byteSize: 205910 },
    },
    {
      accessURL: "/748580849261105152/D2MSTPub_LVE_125_13.xml",
      modified: "2026-03-05T07:29:40Z",
      instance: { fileName: "D2MSTPub_LVE_125_13.xml", byteSize: 40663026 },
    },
  ],
};

const reference = {
  kind: "mobilithek" as const,
  offerId: "748580849261105152",
  fileNamePrefix: "D2MSTPub_LVE_",
};

describe("checkMobilithekReference", () => {
  it("recognizes the configured version as current and ignores unrelated schemas", () => {
    const result = checkMobilithekReference(
      {
        url: mobilithekReferenceFileUrl(reference.offerId, "D2MSTPub_LVE_125_13.xml"),
        reference,
      },
      latestOffer
    );

    expect(result).toMatchObject({
      status: "current",
      configuredFileName: "D2MSTPub_LVE_125_13.xml",
      latestFileName: "D2MSTPub_LVE_125_13.xml",
      latestModified: "2026-03-05T07:29:40Z",
    });
  });

  it("reports a stale configured version and provides the next URL", () => {
    const result = checkMobilithekReference(
      {
        url: mobilithekReferenceFileUrl(reference.offerId, "D2MSTPub_LVE_123_11.xml"),
        reference,
      },
      latestOffer
    );

    expect(result).toMatchObject({
      status: "stale",
      configuredFileName: "D2MSTPub_LVE_123_11.xml",
      latestFileName: "D2MSTPub_LVE_125_13.xml",
      latestUrl: mobilithekReferenceFileUrl(reference.offerId, "D2MSTPub_LVE_125_13.xml"),
    });
  });

  it("reports a provider metadata response with no matching reference files", () => {
    const result = checkMobilithekReference(
      {
        url: mobilithekReferenceFileUrl(reference.offerId, "D2MSTPub_LVE_125_13.xml"),
        reference,
      },
      { contentStandard: [{ instance: { fileName: "MeasuredData.xsd" } }] }
    );

    expect(result.status).toBe("missing");
  });
});
