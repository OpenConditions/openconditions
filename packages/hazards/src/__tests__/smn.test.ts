import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseCap } from "../formats/cap.js";
import { catalogFeed, parseContext } from "./helpers/hazards-feed.js";

const body = readFileSync(new URL("./fixtures/smn/cap-1.xml", import.meta.url));
it("projects SMN Spanish text, country, CAP identity, geometry and zoned validity", () => {
  const out = parseCap(
    catalogFeed("ar-smn-alerts"),
    { alerts: [body] },
    parseContext("2026-11-07T15:48:00Z"),
  );
  expect(out.situations).toHaveLength(1);
  const s = out.situations[0]!;
  expect(s).toMatchObject({
    kind: "alert",
    type: "other",
    location: { admin: { country: "AR" }, geometry: { type: "Polygon" } },
  });
  expect(JSON.stringify(s)).toContain("Evitá salir");
  expect(JSON.stringify(s)).toContain("2026-11-07T09:01:37-03:00");
  expect(out.observations).toEqual([]);
});
it("rejects a partial SMN CAP parse rather than withdrawing failed messages", () => {
  expect(() =>
    parseCap(
      catalogFeed("ar-smn-alerts"),
      { alerts: [body, Buffer.from("<html>down</html>")] },
      parseContext("2026-11-07T15:48:00Z"),
    ),
  ).toThrow();
});

it("keeps polygon messages with a shared predecessor distinct and accounts duplicate identifiers", () => {
  const sibling = Buffer.from(
    body.toString().replace(/(<identifier>)(.*?)(<\/identifier>)/, "$1$2.sibling$3"),
  );
  const out = parseCap(
    catalogFeed("ar-smn-alerts"),
    { alerts: [body, sibling, body] },
    parseContext("2026-11-07T15:48:00Z"),
  );
  expect(out.situations).toHaveLength(2);
  expect(new Set(out.situations.map((s) => s["id"])).size).toBe(2);
  expect(out.records).toMatchObject({ inputCount: 3, uniqueCount: 2, duplicates: 1 });
});
it("withholds Test, Private, Restricted and expired CAP; refuses missing namespace and unreviewed resources", () => {
  for (const text of [
    body.toString().replace("Actual", "Test"),
    body.toString().replace("Public", "Private"),
    body.toString().replace("Public", "Restricted"),
  ]) {
    expect(
      parseCap(
        catalogFeed("ar-smn-alerts"),
        { alerts: [Buffer.from(text)] },
        parseContext("2026-11-07T15:48:00Z"),
      ).situations,
    ).toEqual([]);
  }
  expect(
    parseCap(catalogFeed("ar-smn-alerts"), { alerts: [body] }, parseContext("2026-11-08T15:48:00Z"))
      .situations,
  ).toEqual([]);
  for (const text of [
    body.toString().replace(' xmlns="urn:oasis:names:tc:emergency:cap:1.2"', ""),
    body
      .toString()
      .replace(
        "</info>",
        "<resource><resourceDesc>third party</resourceDesc><mimeType>image/png</mimeType><uri>https://third-party.test/a.png</uri></resource></info>",
      ),
    body.toString().replace(/<info>.*<\/info>/s, ""),
  ]) {
    expect(() =>
      parseCap(
        catalogFeed("ar-smn-alerts"),
        { alerts: [body, Buffer.from(text)] },
        parseContext("2026-11-07T15:48:00Z"),
      ),
    ).toThrow();
  }
});
it("validity begins at effective or sent and preserves forecast onset separately", () => {
  const forecast = Buffer.from(
    body
      .toString()
      .replace(
        /<onset>.*?<\/onset>/,
        "<effective>2026-11-07T10:00:00-03:00</effective><onset>2026-11-07T14:00:00-03:00</onset>",
      ),
  );
  const s = parseCap(
    catalogFeed("ar-smn-alerts"),
    { alerts: [forecast] },
    parseContext("2026-11-07T15:48:00Z"),
  ).situations[0]!;
  expect(s["validity"]).toMatchObject({ start: "2026-11-07T10:00:00-03:00" });
  expect(s["details"]).toMatchObject({ cap: { onset: "2026-11-07T14:00:00-03:00" } });
});

it("enforces ACP qualification and refuses complete-snapshot authority in catalogue lint", async () => {
  const { hazardsDomain } = await import("../domain.js");
  expect(
    hazardsDomain.lintFeed?.({ ...catalogFeed("ar-smn-acp-alerts"), disabled: undefined }),
  ).toEqual(["SMN ACP requires a real active CAP capture before activation"]);
  expect(
    hazardsDomain.lintFeed?.({
      ...catalogFeed("ar-smn-alerts"),
      snapshot: { completeness: "complete" },
    }),
  ).toEqual(["SMN RSS requires rolling CAP acquisition without complete-snapshot authority"]);
});

it("admits the selected CAP licence and denies unknown, NC and share-alike own/upstream rights", async () => {
  const { isPublicRecord } = await import("@openconditions/ingest-framework");
  const license = catalogFeed("ar-smn-alerts").license;
  expect(isPublicRecord({ provenance: { attribution: { license } } })).toBe(true);
  for (const denied of [
    "NOASSERTION",
    "unregistered-provider-rights",
    "CC-BY-NC-4.0",
    "CC-BY-SA-4.0",
  ]) {
    expect(isPublicRecord({ provenance: { attribution: { license: denied } } })).toBe(false);
    expect(
      isPublicRecord({ provenance: { attribution: { license }, upstream: [{ license: denied }] } }),
    ).toBe(false);
  }
});
