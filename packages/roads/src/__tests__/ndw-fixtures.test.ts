import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getXmlAttribute,
  getXmlChild,
  getXmlChildren,
  getXmlChildText,
  parseXmlDocument,
  xmlNodeToArray,
} from "../xml.js";

/**
 * Source fixture: six real reduced situationRecord elements from the reviewed
 * 2026-09-12 NDW capture. Provenance, licence evidence and the exact reductions
 * are recorded in the companion manifest. These assertions read the raw XML, so
 * fixture correctness never depends on the parser mapping under test.
 */
const fixtureUrl = new URL("./fixtures/ndw/restrictions-v3.xml", import.meta.url);
const xml = readFileSync(fixtureUrl, "utf8");
const manifest = JSON.parse(
  readFileSync(new URL("./fixtures/ndw/restrictions-v3.manifest.json", import.meta.url), "utf8"),
) as {
  originalSha256: string;
  fixtureSha256: string;
  license: string;
  licenseUrl: string;
  termsUrl: string;
  sourceUrl: string;
  selectedRecords: Array<{ id: string; version: string; purpose: string }>;
};

/** Mirrors the production DATEX parse options so structure reads match the real document shape. */
function parseFixture() {
  return parseXmlDocument(xml, {
    removeNSPrefix: true,
    ignoreAttributes: false,
    isArray: (n) => n === "situation" || n === "situationRecord" || n === "value",
  });
}

function situationRecords(): Array<Record<string, unknown>> {
  const doc = parseFixture();
  const container = getXmlChild(doc, "messageContainer");
  const payload = getXmlChild(container, "payload");
  return xmlNodeToArray(getXmlChildren(payload, "situation")).flatMap((situation) =>
    getXmlChildren(situation, "situationRecord"),
  );
}

describe("ndw reduced restriction fixture", () => {
  it("parses as the declared complete situation publication", () => {
    expect(() => parseFixture()).not.toThrow();
    const payload = getXmlChild(getXmlChild(parseFixture(), "messageContainer"), "payload");
    expect(getXmlAttribute(payload, "type")).toBe("sit:SituationPublication");
    expect(xml).toContain("http://datex2.eu/schema/3/messageContainer");
  });

  it("contains exactly the six selected record ids once each", () => {
    const ids = situationRecords().map((rec) => getXmlAttribute(rec, "id"));
    expect(ids).toHaveLength(6);
    expect([...ids].sort()).toEqual(manifest.selectedRecords.map((r) => r.id).sort());
    for (const id of ids) expect(ids.filter((other) => other === id)).toHaveLength(1);
  });

  it("keeps the selected source versions, including height record version 133", () => {
    const versions = new Map(
      situationRecords().map((rec) => [
        getXmlAttribute(rec, "id"),
        getXmlAttribute(rec, "version"),
      ]),
    );
    for (const record of manifest.selectedRecords) {
      expect(versions.get(record.id)).toBe(record.version);
    }
    expect(versions.get("RWS01_M1080891_NARROW_LANES_D2_WWA")).toBe("133");
  });

  it("retains the source height comparator and value under the applicability role", () => {
    expect(xml).toContain('id="RWS01_M1080891_NARROW_LANES_D2_WWA"');
    expect(xml).toContain("greaterThan");
    expect(xml).toContain("4.5");
    const height = situationRecords().find(
      (rec) => getXmlAttribute(rec, "id") === "RWS01_M1080891_NARROW_LANES_D2_WWA",
    );
    const groups = getXmlChildren(height, "forVehiclesWithCharacteristicsOf");
    expect(groups).toHaveLength(1);
    const characteristic = getXmlChild(groups[0], "heightCharacteristic");
    expect(getXmlChildText(characteristic, "comparisonOperator")).toBe("greaterThan");
    expect(getXmlChildText(characteristic, "vehicleHeight")).toBe("4.5");
  });

  it("keeps the construction vehicle under the obstruction role only", () => {
    const obstruction = situationRecords().find(
      (rec) => getXmlAttribute(rec, "id") === "NDW08_2e188db4-9bff-492d-bf28-90e17bffac8c",
    );
    expect(getXmlChildren(obstruction, "forVehiclesWithCharacteristicsOf")).toHaveLength(0);
    expect(JSON.stringify(getXmlChild(obstruction, "obstructingVehicle"))).toContain(
      "constructionOrMaintenanceVehicle",
    );
  });

  it("preserves both original Dutch lorry comments verbatim", () => {
    expect(xml).toContain("Verbod voor vrachtverkeer en autobussen");
    for (const id of ["NLRWS_0005382945_1", "NLRWS_0005406494_1"]) {
      const rec = situationRecords().find((r) => getXmlAttribute(r, "id") === id);
      expect(JSON.stringify(getXmlChild(rec, "generalPublicComment"))).toContain(
        "Verbod voor vrachtverkeer en autobussen (>3500kg). Lijnbussen toegestaan.",
      );
      expect(JSON.stringify(getXmlChild(rec, "forVehiclesWithCharacteristicsOf"))).toContain(
        "lorry",
      );
    }
  });

  it("matches the manifest fixture hash and records reuse evidence", () => {
    const actual = createHash("sha256").update(readFileSync(fixtureUrl)).digest("hex");
    expect(actual).toBe(manifest.fixtureSha256);
    expect(manifest.originalSha256).toBe(
      "f774a3df6befacfde2389f68d8a34edb6b3a30e61e8f1ce54b6519f2e657b7ce",
    );
    expect(manifest.license).toBe("CC0-1.0");
    expect(manifest.licenseUrl).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(manifest.termsUrl).toBe("https://www.ndw.nu/service/copyright");
    expect(manifest.sourceUrl).toBe("https://opendata.ndw.nu/actueel_beeld.xml.gz");
  });
});
