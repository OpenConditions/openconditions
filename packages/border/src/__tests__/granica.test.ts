import { expect, it } from "vitest";
import { borderDomain } from "../domain.js";
import { fixture, parseContext } from "./helpers/border-feed.js";

it("registers the pure HTML transport and publishes six source-dated queues", () => {
  const format = borderDomain.formats["granica-html"];
  expect(format).toBeDefined();
  const out = format!.parse(
    {
      id: "pl-granica-waits",
      format: "granica-html",
      attribution:
        "Ministerstwo Finansów / Krajowa Administracja Skarbowa; granica.gov.pl; converted to OpenConditions.",
      license: "CC-BY-4.0",
    } as never,
    { main: [fixture("granica-2026-11-08.html.txt")] },
    parseContext("2026-11-08T07:22:57Z"),
  );
  expect(out.features).toHaveLength(3);
  expect(out.observations).toHaveLength(6);
  expect(out.observations.map((o) => o["property"])).toEqual(Array(6).fill("border.wait"));
});

import { granicaInstant } from "../formats/granica.js";
import { catalogFeed } from "./helpers/border-feed.js";
import { sealFailures } from "./helpers/seal.js";

const html = () => fixture("granica-2026-11-08.html.txt").toString("utf8");
const read = (body = html(), fetchedAt = "2026-11-08T07:22:57Z") =>
  borderDomain.formats["granica-html"]!.parse(
    catalogFeed("pl-granica-waits"),
    { main: [Buffer.from(body)] },
    parseContext(fetchedAt),
  );

it("seals canonical DMC eligibility, source credit and CC0 geometry provenance", () => {
  const out = read();
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(out.features[0]).toMatchObject({
    id: "oc:feature:pl-granica-waits:401030",
    components: [
      { key: "pl-ua-car", details: { vehicleClass: "car", direction: { from: "PL", to: "UA" } } },
      {
        key: "pl-ua-dmc-gt7500",
        details: {
          eligibility: {
            maximumPermissibleGrossMass: { operator: "gt", value: { value: 7500, unit: "kg" } },
          },
        },
      },
    ],
    provenance: {
      upstream: [{ publisher: "Wikidata", license: "CC0-1.0", recordId: "Q140834461@2565475162" }],
    },
  });
  expect(
    out.observations.map(
      (o) => (o["result"] as { value: { waitMinutes: number } }).value.waitMinutes,
    ),
  ).toEqual([120, 960, 60, 840, 0, 1500]);
  expect(out.observations[0]).toMatchObject({
    phenomenonTime: { instant: "2026-11-08T07:17:00Z" },
    freshness: { expiresAt: "2026-11-08T09:17:00Z" },
  });
  expect(JSON.stringify(out)).not.toMatch(/facility.open_status|"paused":false|Dorohusk/);
});

it("keeps source deadlines on repeated successful retrieval", () => {
  const a = read();
  const b = read(html(), "2026-11-08T11:00:00Z");
  expect(b.observations.map((o) => o["phenomenonTime"])).toEqual(
    a.observations.map((o) => o["phenomenonTime"]),
  );
  expect(b.observations.map((o) => (o["freshness"] as { expiresAt: string }).expiresAt)).toEqual(
    a.observations.map((o) => (o["freshness"] as { expiresAt: string }).expiresAt),
  );
});

it("distinguishes zero, fractional duration, gray/empty cells and suspension", () => {
  expect(read(html().replaceAll("2:00&nbsp;", "0:30&nbsp;")).observations[0]).toMatchObject({
    result: { value: { waitMinutes: 30 } },
  });
  const gray = html().replaceAll("2:00&nbsp;", "&nbsp;");
  expect(read(gray).features).toHaveLength(3);
  expect(read(gray).observations).toHaveLength(5);
  expect(read(html().replaceAll("2:00&nbsp;", "ruch zawieszony")).observations[0]).toMatchObject({
    result: { value: { status: "closed" } },
  });
});

it.each([
  ["unknown crossing", (s: string) => s.replace("&nbsp;Zosin&nbsp;", "&nbsp;Unknown&nbsp;")],
  ["duplicate crossing", (s: string) => s.replace("&nbsp;Korczowa&nbsp;", "&nbsp;Medyka&nbsp;")],
  ["missing crossing", (s: string) => s.replace("&nbsp;Medyka&nbsp;", "&nbsp;Malhowice&nbsp;")],
  ["unsupported freight", (s: string) => s.replaceAll(">7,5T DMC", "≤7,5T DMC")],
  ["unsupported class", (s: string) => s.replace("obrazek  samochody OSOBOWE", "obrazek  VANS")],
  ["missing row", (s: string) => s.replace("Godzina aktualizacji:", "Update:")],
  ["truncated table", (s: string) => s.slice(0, s.indexOf("Godzina aktualizacji:"))],
  ["wrong direction", (s: string) => s.replaceAll("WYJAZD Z RP", "WJAZD DO RP")],
])("fails the entire page for %s", (_, edit) => {
  expect(() => read(edit(html()))).toThrow(/granica:/);
});

it.each([
  ["2026-10-25", "02:30", "2026-10-25T08:00:00Z"],
  ["2026-03-29", "02:30", "2026-03-29T08:00:00Z"],
  ["2026-02-30", "12:00", "2026-03-02T14:00:00Z"],
  ["2026-11-08", "25:00", "2026-11-08T14:00:00Z"],
  ["2026-11-08", "12:00", "2026-11-08T07:22:57Z"],
  ["2026-11-07", "23:50", "2026-11-08T00:20:00Z"],
  ["2026-11-08", "23:50", "2026-11-07T23:20:00Z"],
])("rejects uncertain Warsaw publication %s %s", (date, minute, fetch) =>
  expect(() => granicaInstant(date, minute, fetch)).toThrow(),
);

it.each([
  ["2026-11-08", "08:17", "2026-11-08T07:17:00Z"],
  ["2026-06-08", "08:17", "2026-06-08T06:17:00Z"],
])("interprets ordinary Warsaw minutes %s", (date, minute, expected) =>
  expect(granicaInstant(date, minute, expected)).toBe(expected),
);

it("joins reordered semantic crossing columns without changing identities or values", () => {
  // Synthetic permutation of every nine-crossing row in the real table.
  const reordered = html().replace(/<tr[ >][\s\S]*?<\/tr>/g, (row) => {
    const matches = [...row.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)];
    if (matches.length !== 9 && matches.length !== 10) return row;
    const offset = matches.length === 10 ? 1 : 0;
    const a = matches[offset + 5]!;
    const b = matches[offset + 6]!;
    return (
      row.slice(0, a.index) +
      b[0] +
      row.slice(a.index! + a[0].length, b.index) +
      a[0] +
      row.slice(b.index! + b[0].length)
    );
  });
  expect(read(reordered)).toEqual(read());
});

it("uses crossing-specific minutes independently and retains gray-cell suspensions", () => {
  const out = read(html().replaceAll("08:15", "08:14"));
  expect(out.observations[0]).toMatchObject({
    phenomenonTime: { instant: "2026-11-08T07:17:00Z" },
  });
  expect(out.observations[4]).toMatchObject({
    phenomenonTime: { instant: "2026-11-08T07:14:00Z" },
    freshness: { expiresAt: "2026-11-08T09:14:00Z" },
  });
  const gray = html()
    .replaceAll("2:00&nbsp;", "ruch zawieszony")
    .replace('class="dane1" >ruch zawieszony', 'class="dane1" bgcolor="#CCCCCC">ruch zawieszony');
  expect(read(gray).observations[0]).toMatchObject({ result: { value: { status: "closed" } } });
});

it.each([
  (s: string) => s.replaceAll("[h]", "[min]"),
  (s: string) => s.replaceAll("[h]", ""),
  (s: string) => s.replaceAll("[h]", "[h] [h]"),
  (s: string) =>
    s.replace(/<tr><td class="p-3" colspan="2"><img src="\/images\/autokar.png"[\s\S]*?<\/tr>/, ""),
  (s: string) =>
    s.replace("</table>", '<tr><td><img alt="VANS"/>estimated wait</td><td>1:00</td></tr></table>'),
  (s: string) =>
    s.replace(
      '<td class="p-3" colspan="2"><img src="/images/osobowy.png"',
      '<td class="p-3" colspan="3"><img src="/images/osobowy.png"',
    ),
])("refuses changed units and incomplete or ambiguous class structure", (change) => {
  expect(() => read(change(html()))).toThrow(/granica/);
});

it("matches the independently transcribed six-queue oracle from the November 9 capture", () => {
  const out = read(
    fixture("granica-2026-11-09.html.txt").toString("utf8"),
    "2026-11-09T18:26:35.741Z",
  );
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  expect(out.observations.map((o) => o["result"])).toEqual(
    [120, 600, 0, 180, 0, 780].map((waitMinutes) => ({
      type: "structured",
      schema: "border_wait",
      v: 1,
      value: { v: 1, status: waitMinutes === 0 ? "no_delay" : "delay", waitMinutes },
    })),
  );
  expect(out.observations.map((o) => o["phenomenonTime"])).toEqual(
    ["18:00", "18:00", "18:01", "18:01", "18:22", "18:22"].map((t) => ({
      instant: `2026-11-09T${t}:00Z`,
    })),
  );
  expect(out.observations.map((o) => (o["freshness"] as { expiresAt: string }).expiresAt)).toEqual(
    ["20:00", "20:00", "20:01", "20:01", "20:22", "20:22"].map((t) => `2026-11-09T${t}:00Z`),
  );
});
