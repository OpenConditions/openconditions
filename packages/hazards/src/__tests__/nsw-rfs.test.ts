import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseNswRfs } from "../formats/nsw-rfs.js";
import { catalogFeed, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const body = readFileSync(new URL("./fixtures/nsw-rfs-current.xml", import.meta.url));
const at = "2026-11-07T17:13:00Z";
const parse = (b = body, fetchedAt = at) =>
  parseNswRfs(catalogFeed("au-nsw-rfs-alerts"), { alerts: [b] }, parseContext(fetchedAt));
describe("NSW RFS current incidents", () => {
  test("accounts official records, seals and publishes only wildfire anchors with full instructions", () => {
    const out = parse();
    expect(out.situations.length).toBeGreaterThan(0);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.records!.inputCount).toBe(
      out.records!.accepted + out.records!.terminal + out.records!.duplicates,
    );
    for (const s of out.situations) {
      expect(s).toMatchObject({
        kind: "alert",
        type: "fire",
        subtype: "wildfire",
        effects: [],
        location: { extent: "point", fuzziness: "extent_unknown", geometry: { type: "Point" } },
      });
      expect(s["instruction"]).toBeDefined();
      expect(s["validity"]).toMatchObject({ status: "active" });
    }
  });
  test.each([
    "<html>error</html>",
    body.toString().slice(0, -80),
    body.toString().replace("<info>", '<info xmlns="urn:foreign">'),
    '<!DOCTYPE x [<!ENTITY x "boom">]>' + body.toString(),
  ])("rejects whole malformed document", (text) =>
    expect(() => parse(Buffer.from(text))).toThrow(),
  );
  test("rejects stale source publication regardless of retrieval", () =>
    expect(() => parse(body, "2026-11-09T00:00:00Z")).toThrow(/fresh/));
  test("preserves publisher-qualified incident grouping across message identities", () => {
    const a = parse();
    const b = parse(
      Buffer.from(
        body.toString().replaceAll("2026-11-07T20:51:00.0000000:", "2026-11-07T21:51:00.0000000:"),
      ),
    );
    expect(a.situations.map((s) => s["groupId"])).toEqual(b.situations.map((s) => s["groupId"]));
  });
});

test.each([
  ["missing fire semantics", "<valueName>IsFire</valueName>", "<valueName>Absent</valueName>"],
  ["unknown fire semantics", "<value>Yes</value>", "<value>Unknown</value>"],
  ["unknown native code", "<value>bushFire</value>", "<value>unknownFire</value>"],
  ["missing native code", "https://govshare.gov.au/xmlui/handle/10772/6495", "urn:unknown"],
  ["unknown incident type", "<value>Bush Fire</value>", "<value>Unknown Fire</value>"],
  [
    "contradiction",
    "<valueName>IsFire</valueName>\r\n\t\t\t\t\t\t\t<value>Yes</value>",
    "<valueName>IsFire</valueName><value>No</value>",
  ],
  ["constructed Update", "<msgType>Alert</msgType>", "<msgType>Update</msgType>"],
  ["constructed Cancel", "<msgType>Alert</msgType>", "<msgType>Cancel</msgType>"],
])("fails the whole snapshot for %s", (_name, from, to) => {
  expect(body.toString()).toContain(from);
  expect(() => parse(Buffer.from(body.toString().replace(from, to)))).toThrow();
});

test("unmapped LGA anchor is coarse and still has unknown fire extent", () => {
  const out = parse(
    Buffer.from(body.toString().replace("<headline>", "<headline>(Unmapped Incident) ")),
  );
  expect(out.situations[0]).toMatchObject({ location: { fuzziness: "low_res", extent: "point" } });
  expect(sealFailures(out.situations)).toEqual([]);
});

test("prefixes are resolved by namespace, including inherited CAP declarations", () => {
  const xml = body
    .toString()
    .replaceAll(
      'xmlns="urn:oasis:names:tc:emergency:cap:1.2"',
      'xmlns="urn:oasis:names:tc:emergency:cap:1.2" xmlns:c="urn:oasis:names:tc:emergency:cap:1.2"',
    )
    .replaceAll("<info>", "<c:info>")
    .replaceAll("</info>", "</c:info>");
  expect(parse(Buffer.from(xml)).situations).toEqual(parse().situations);
});

test("duplicates have an explicit disposition; conflicting versions reject", () => {
  const xml = body.toString();
  const object = xml.match(/<contentObject>[\s\S]*?<\/contentObject>/)![0];
  const repeated = xml.replace("</EDXLDistribution>", `${object}</EDXLDistribution>`);
  const out = parse(Buffer.from(repeated));
  expect(out.records!.duplicates).toBe(1);
  expect(out.situations).toEqual(parse().situations);
  expect(() =>
    parse(
      Buffer.from(
        xml.replace(
          "</EDXLDistribution>",
          `${object.replace("Under control", "Responding")}</EDXLDistribution>`,
        ),
      ),
    ),
  ).toThrow(/conflicting/);
});

test("empty and successful subsets never qualify themselves for withdrawal", () => {
  const xml = body.toString().replace(/<contentObject>[\s\S]*?<\/contentObject>/g, "");
  const out = parse(Buffer.from(xml));
  expect(out.records).toMatchObject({ inputCount: 0, accepted: 0 });
  expect(out.snapshotQualified).toBe(false);
  expect(parse().snapshotQualified).toBe(false);
});

test("rejects unaccounted wrapper content rather than accepting an apparent empty/subset", () => {
  const xml = body
    .toString()
    .replace("<contentObject>", "<unexpected><contentObject>")
    .replace("</contentObject>", "</contentObject></unexpected>");
  expect(() => parse(Buffer.from(xml))).toThrow(/unaccounted/);
});
test("rejects expressly restricted instructions instead of publishing them", () => {
  const xml = body.toString().replace("<instruction>", "<instruction>No redistribution. ");
  expect(() => parse(Buffer.from(xml))).toThrow(/restricted/);
});

test("rejects duplicate singleton instructions instead of losing warning text", () => {
  const xml = body
    .toString()
    .replace("</instruction>", "</instruction><instruction>Second instruction</instruction>");
  expect(() => parse(Buffer.from(xml))).toThrow();
});

test("constructed CAP Update/Cancel references supersede only the same publisher incident", () => {
  const xml = body.toString();
  const object = xml.match(/<contentObject>[\s\S]*?<\/contentObject>/)![0];
  const id = object.match(/<identifier>(.*?)<\/identifier>/)![1];
  const sent = object.match(/<sent>(.*?)<\/sent>/)![1];
  const refs = `<references>webmaster@rfs.nsw.gov.au,${id},${sent}</references>`;
  const updated = object
    .replace(`<identifier>${id}</identifier>`, "<identifier>constructed-update</identifier>")
    .replace("<msgType>Alert</msgType>", "<msgType>Update</msgType>")
    .replace("<incidents>", `${refs}<incidents>`);
  const out = parse(
    Buffer.from(xml.replace("</EDXLDistribution>", `${updated}</EDXLDistribution>`)),
  );
  expect(out.situations).toHaveLength(parse().situations.length);
  const update = out.situations.find((s) =>
    JSON.stringify(s["externalIds"]).includes("constructed-update"),
  )!;
  expect(update["groupId"]).toBe(parse().situations[0]!["groupId"]);
  expect(update).toMatchObject({
    details: { cap: { msgType: "update", references: [{ identifier: id, sent }] } },
  });
  expect(sealFailures(out.situations)).toEqual([]);
  const cancelled = updated
    .replace("constructed-update", "constructed-cancel")
    .replace("<msgType>Update</msgType>", "<msgType>Cancel</msgType>");
  const result = parse(
    Buffer.from(xml.replace("</EDXLDistribution>", `${cancelled}</EDXLDistribution>`)),
  );
  expect(
    result.situations.find((s) => JSON.stringify(s["externalIds"]).includes("constructed-cancel")),
  ).toMatchObject({ validity: { status: "cancelled" } });
  expect(sealFailures(result.situations)).toEqual([]);
  const noInfo = cancelled.replace(/<info>[\s\S]*?<\/info>/, "");
  expect(
    parse(Buffer.from(xml.replace("</EDXLDistribution>", `${noInfo}</EDXLDistribution>`)))
      .situations,
  ).toHaveLength(parse().situations.length - 1);
  expect(() =>
    parse(
      Buffer.from(
        xml.replace(
          "</EDXLDistribution>",
          `${updated.replace(sent, "2020-01-01T00:00:00Z")}</EDXLDistribution>`,
        ),
      ),
    ),
  ).toThrow();
});
