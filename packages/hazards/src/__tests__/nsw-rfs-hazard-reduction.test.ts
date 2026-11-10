import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseNswRfs } from "../formats/nsw-rfs.js";
import { catalogFeed, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const raw = readFileSync(new URL("./fixtures/nsw-rfs-hazard-reduction.xml", import.meta.url));
const xml = raw.toString();
const excluded = [...xml.matchAll(/<contentObject>[\s\S]*?<\/contentObject>/g)].find((match) =>
  match[0].includes("<value>Hazard Reduction</value>"),
)![0];
const parse = (body = raw) =>
  parseNswRfs(
    catalogFeed("au-nsw-rfs-alerts"),
    { alerts: [body] },
    parseContext("2026-11-10T01:38:32.883Z"),
  );

test("excludes the official planned burn while retaining wildfire publication and ordering", () => {
  expect(excluded).toContain("<value>Planned Burn</value>");
  const out = parse();
  expect(out.records).toMatchObject({ inputCount: 16, accepted: 11, terminal: 5 });
  expect(out.situations).toHaveLength(11);
  expect(out.situations.map((s) => s["id"])).not.toContain("oc:situation:au-nsw-rfs-alerts:684916");
  expect(out.nswRfsOrdering!.incidents).toHaveLength(16);
  expect(out.nswRfsOrdering!.incidents).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "684916" })]),
  );
  expect(out.situationsComplete).toBe(false);
  expect(sealFailures(out.situations)).toEqual([]);
});

test.each([
  ["unknown type", "<value>Hazard Reduction</value>", "<value>Unknown Fire</value>"],
  ["missing type", "<valueName>IncidentType</valueName>", "<valueName>Absent</valueName>"],
  [
    "duplicate type",
    "</info>",
    "<parameter><valueName>IncidentType</valueName><value>Hazard Reduction</value></parameter></info>",
  ],
  ["invalid fire semantics", /(<valueName>IsFire<\/valueName>\s*<value>)Yes/, "$1Unknown"],
  ["missing expiry", /<expires>[^<]+<\/expires>/, ""],
  ["invalid expiry", /<expires>[^<]+<\/expires>/, "<expires>invalid</expires>"],
  ["malformed CAP", "<event>Fire</event>", "<event></event>"],
  ["restricted text", "<headline>", "<headline>No redistribution. "],
])("still refuses %s in an excluded planned burn", (_name, from, to) => {
  const changed = excluded.replace(from, to);
  expect(changed).not.toBe(excluded);
  expect(() => parse(Buffer.from(xml.replace(excluded, changed)))).toThrow();
});
