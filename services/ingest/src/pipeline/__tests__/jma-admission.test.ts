import { readFileSync } from "node:fs";
import { jmaSituations, jmaUnit, readJmaReport } from "@openconditions/hazards";
import { expect, test } from "vitest";
import { admitJmaWarnings } from "../jma-admission.js";

const xml = readFileSync(
  new URL(
    "../../../../../packages/hazards/src/__tests__/fixtures/jma/synthetic-jma-only-VPWW56.xml",
    import.meta.url,
  ),
  "utf8",
);
function report(at: string, restricted = false, cancelled = false) {
  return readJmaReport(
    Buffer.from(
      xml
        .replace(/<DateTime>[^<]+<\/DateTime>/, `<DateTime>${at}</DateTime>`)
        .replace(
          "<InfoType>発表</InfoType>",
          cancelled ? "<InfoType>取消</InfoType>" : "<InfoType>発表</InfoType>",
        )
        .replace("</Body>", restricted ? "<Text>Copyright Partner</Text></Body>" : "</Body>"),
    ),
    "VPWW56",
  );
}
const first = report("2026-11-07T01:00:00Z");
const hidden = report("2026-11-07T03:00:00Z", true, true);
const replay = report("2026-11-07T02:00:00Z");
const empty = { products: {}, areas: {} };

test.each([false, true])(
  "withheld terminal freezes last-good across restart and both poll orders %s",
  (reverse) => {
    const initial = admitJmaWarnings(empty, {}, [first]);
    const batch = [replay, hidden];
    const next = admitJmaWarnings(initial.native, {}, reverse ? batch.reverse() : batch);
    expect(
      Object.values(next.native.areas).every((a) => a.report.controlAt === first.controlAt),
    ).toBe(true);
    const restored = JSON.parse(JSON.stringify(next)) as typeof next;
    expect(admitJmaWarnings(restored.native, restored.withheld, [first, replay])).toEqual(restored);
    expect(JSON.stringify(next)).not.toContain("Copyright Partner");
    expect(next.withheld[jmaUnit(hidden)]?.controlAt).toBe(hidden.controlAt);
    const newer = report("2026-11-07T04:00:00Z");
    expect(admitJmaWarnings(next.native, next.withheld, [newer]).native).not.toEqual(next.native);
  },
);

test("a held correction never replaces last good; different offices/products/events remain independent", () => {
  const initial = admitJmaWarnings(empty, {}, [first]);
  const held = admitJmaWarnings(initial.native, {}, [hidden]);
  expect(held.native).toEqual(initial.native);
  for (const other of [
    { ...replay, editorialOffice: "札幌管区気象台" },
    { ...replay, family: "VPWW55" as const },
    { ...replay, eventId: "other" },
  ]) {
    const next = admitJmaWarnings(held.native, held.withheld, [other]);
    expect(next.native.products[jmaUnit(other)]).toEqual(other);
    expect(next.native.products[jmaUnit(first)]).toEqual(first);
  }
});

test("same-clock rights exclusion wins both input orders and stores no restricted XML", () => {
  const safe = report(hidden.controlAt);
  for (const batch of [
    [safe, hidden],
    [hidden, safe],
  ]) {
    const next = admitJmaWarnings(empty, {}, batch);
    expect(next.native).toEqual(empty);
    expect(Object.keys(next.withheld)).toHaveLength(1);
  }
});

test("admissible unsupported warning cancellation and malformed native XML still refuse", () => {
  expect(() => admitJmaWarnings(empty, {}, [report("2026-11-07T04:00:00Z", false, true)])).toThrow(
    "cancellation",
  );
  expect(() => admitJmaWarnings(empty, {}, [{ ...first, nativeXml: "<broken>" }])).toThrow();
});

test.each(["訂正", "発表", "取消"])(
  "withheld %s retains last-good expiry and never exposes restricted bytes",
  (kind) => {
    const active = {
      ...first,
      validAt: "2026-11-07T05:00:00Z",
      messageUrl:
        "https://www.data.jma.go.jp/developer/xml/data/20261107010000_0_VPWW56_010000.xml",
    };
    const initial = admitJmaWarnings(empty, {}, [active]);
    const terminal = {
      ...hidden,
      nativeXml: hidden.nativeXml.replace(
        "<InfoType>取消</InfoType>",
        `<InfoType>${kind}</InfoType>`,
      ),
      warnings: hidden.warnings.map((w) => ({ ...w, status: "解除" })),
    };
    const next = admitJmaWarnings(initial.native, {}, [terminal]);
    expect(next.native).toEqual(initial.native);
    expect(admitJmaWarnings(next.native, next.withheld, [replay]).native).toEqual(initial.native);
    expect(
      jmaSituations(
        {
          id: "expiry",
          format: "jma-xml",
          attribution: "Japan Meteorological Agency",
          license: "CC-BY-4.0",
        },
        next.native,
        "2026-11-07T06:00:00Z",
      ),
    ).toEqual([]);
  },
);
