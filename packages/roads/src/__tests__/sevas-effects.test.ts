import { readFileSync } from "node:fs";
import {
  buildRegistry,
  type Effect,
  effectStateAt,
  isValidityInEffectAt,
  kernelModule,
  routingBlockers,
  sealRecord,
} from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import { parseSevasSnapshot } from "../sevas.js";
import { sevasEffects } from "../sevas-effects.js";
import { parseSevasFeed } from "../sevas-feed.js";
import { roadFeed } from "./helpers/road-feed.js";

const fixture = readFileSync(new URL("./fixtures/sevas/restrictions.gml", import.meta.url), "utf8");
const source = {
  id: "de-nw-sevas-conditions",
  attribution: "NRW.Mobidrom / SEVAS",
  license: "DL-DE-ZERO-2.0",
};
const raw = parseSevasSnapshot(fixture, source).records[0]!.event!.sourceRaw as Record<
  string,
  string
>;
const base = {
  ...Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, k.startsWith("vz_") ? "false" : v]),
  ),
  typ: "265",
  wert: "2,5",
  fahrtri: "0",
  tage_einzl: "0000000",
  tage_grppe: "0",
  zeit1_von: "",
  zeit1_bis: "",
  zeit2_von: "",
  zeit2_bis: "",
  vz_1053_33: "",
};
function effect(p: Record<string, string | undefined> = {}) {
  return sevasEffects(
    Object.fromEntries(
      Object.entries({ ...base, ...p }).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    "segment-1",
  )[0]!;
}

function finalEffect(days: string): Effect {
  const props = { ...base, tage_einzl: days };
  const escapeXml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const xml = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><wfs:member><ms:restriktionen_segmente>${Object.entries(
    props,
  )
    .map(([k, v]) => `<ms:${k}>${escapeXml(v)}</ms:${k}>`)
    .join(
      "",
    )}<ms:msGeometry><gml:LineString srsName="urn:ogc:def:crs:EPSG::4326"><gml:posList srsDimension="2">51 8 51.1 8.1</gml:posList></gml:LineString></ms:msGeometry></ms:restriktionen_segmente></wfs:member></wfs:FeatureCollection>`;
  const output = parseSevasFeed(
    roadFeed({ id: source.id, format: "sevas", freshnessWindowSec: 172800 }),
    { main: [Buffer.from(xml)] },
    { fetchedAt: "2026-11-27T00:00:00Z", cadenceSec: 21600, reference: {} },
  );
  const sealed = sealRecord(buildRegistry([kernelModule, roadsModule]), output.situations[0], {
    instanceId: "test.local",
    revision: 1,
    recordedAt: "2026-11-27T00:00:00Z",
  });
  if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
  return (sealed.value["effects"] as Effect[])[0]!;
}

describe("SEVAS canonical restriction semantics", () => {
  it.each(["2026-03-29T22:30:00Z", "2026-10-25T22:30:00Z"])(
    "keeps a restricted all-day weekday unknown across DST at %s",
    (at) => {
      const e = finalEffect("0000001");
      expect(effectStateAt(e, { status: "active" }, new Date(at)).state).toBe("unknown");
      expect(e.normalization).toBe("partial");
      expect(routingBlockers(e)).toContain("not_normalized");
    },
  );
  it("treats all-seven-days without clocks as standing across the autumn extra hour", () => {
    const e = finalEffect("1111111");
    expect(e.validity?.periods).toBeUndefined();
    expect(e.normalization).toBe("complete");
    expect(effectStateAt(e, { status: "active" }, new Date("2026-10-25T22:30:00Z")).state).toBe(
      "active",
    );
  });
  it("rejects overflowing truck threshold overrides", () => {
    expect(effect({ typ: "253", vz_1053_33: "9".repeat(400) }).normalization).toBe("unsupported");
  });
  it("distinguishes actual laden mass and permitted truck mass", () => {
    expect(effect({ typ: "262", wert: "2,8" })).toMatchObject({
      kind: "dimension_limit",
      dimension: "laden_weight",
      value: { value: 2800, unit: "kg" },
      operator: "lte",
      normalization: "partial",
    });
    expect(effect({ typ: "253", wert: "" })).toMatchObject({
      kind: "access",
      mode: "prohibited",
      normalization: "partial",
      applicability: {
        kind: "classes",
        include: [
          {
            class: "truck",
            when: [
              { dimension: "gross_weight", operator: "gt", value: { value: 3500, unit: "kg" } },
            ],
          },
        ],
      },
    });
    expect(effect()).toMatchObject({
      kind: "dimension_limit",
      dimension: "height",
      value: { value: 2.5, unit: "m" },
      normalization: "complete",
    });
  });
  it("preserves local access and delivery exceptions together", () => {
    expect(effect({ vz_1020_30: "true", vz_1026_35: "true" }).applicability.except).toEqual([
      { usage: "local_access" },
      { usage: "delivery" },
    ]);
  });
  it.each(["0", "1", "2", "9"])("retains geometry axis direction %s", (code) => {
    expect(effect({ fahrtri: code }).direction).toMatchObject({
      basis: "geometry",
      value:
        ({ "0": "both", "1": "positive", "2": "negative" } as Record<string, string>)[code] ??
        "unknown",
    });
  });
  it("retains threshold overrides without confusing them with actual mass", () => {
    expect(
      effect({ typ: "253", wert: "", vz_1053_33: "7,5" }).applicability.include?.[0]?.when?.[0]
        ?.value.value,
    ).toBe(7500);
    expect(effect({ typ: "253", wert: "", vz_1053_33: "broken" }).normalization).toBe(
      "unsupported",
    );
  });
  it.each([
    { vz_1020_30: "" },
    { vz_1026_35: "unknown" },
    { vz_future: "true" },
    { vz_1048_14: "true" },
  ])("does not silently broaden uncertain supplementary signs %j", (flags) => {
    const e = effect(flags);
    expect(e.normalization).toBe("partial");
    expect(e.issues?.length).toBeGreaterThan(0);
    expect(e.source?.tokens).toMatchObject(flags);
  });
  it.each(["", "NaN", "0", "-5", "2,5 metres", "1e4"])(
    "never invents a numeric limit from %s",
    (wert) => {
      expect(effect({ wert })).toMatchObject({ kind: "unsupported", normalization: "unsupported" });
    },
  );
  it("supports ordinary Berlin weekday intervals and two alternatives", () => {
    const e = effect({
      tage_einzl: "1111100",
      zeit1_von: "08:00",
      zeit1_bis: "12:00",
      zeit2_von: "14:00",
      zeit2_bis: "17:00",
    });
    expect(e.normalization).toBe("complete");
    expect(e.validity?.periods).toHaveLength(2);
    expect(isValidityInEffectAt(e.validity!, new Date("2026-11-27T08:00:00Z"))).toBe(true);
    expect(isValidityInEffectAt(e.validity!, new Date("2026-11-27T12:00:00Z"))).toBe(false);
  });
  it.each([
    { tage_grppe: "2" },
    { tage_grppe: "3" },
    { zeit1_von: "22:00", zeit1_bis: "07:00" },
    { zeit1_von: "01:00", zeit1_bis: "04:00" },
    { zeit1_von: "01:00", zeit1_bis: "02:00" },
    { zeit1_von: "08:00", zeit1_bis: "" },
  ])("keeps unrepresentable schedules partial %j", (p) => {
    const e = effect(p);
    expect(e.normalization).toBe("partial");
    expect(e.validity?.periods).toBeUndefined();
    expect(e.issues?.some((i) => i.code === "unsupported_schedule")).toBe(true);
  });
  it.each(["2026-03-29T04:30:00Z", "2026-10-25T04:30:00Z"])(
    "does not claim a DST overnight restriction authoritative at %s",
    (at) => {
      // Berlin 06:30 in spring and 05:30 in autumn: no elapsed-duration approximation.
      const e = effect({ zeit1_von: "22:00", zeit1_bis: "06:00" });
      expect(e.normalization).toBe("partial");
      expect(e.validity?.periods).toBeUndefined();
      expect(routingBlockers(e)).toContain("not_normalized");
      const mayRouteAt =
        isValidityInEffectAt(e.validity!, new Date(at)) && routingBlockers(e).length === 0;
      expect(mayRouteAt).toBe(false);
    },
  );
  it("seals real drafts with retrieval expiry and no invented source clock", () => {
    const feed = roadFeed({
      id: source.id,
      format: "sevas",
      license: "DL-DE-ZERO-2.0",
      freshnessWindowSec: 172800,
    });
    const out = parseSevasFeed(
      feed,
      { main: [Buffer.from(fixture)] },
      { fetchedAt: "2026-11-27T00:00:00Z", cadenceSec: 21600, reference: {} },
    );
    const registry = buildRegistry([kernelModule, roadsModule]);
    expect(out.records?.inputCount).toBe(14);
    expect(out.situationsComplete).toBe(true);
    for (const draft of out.situations) {
      expect(draft["freshness"]).toMatchObject({
        fetchedAt: "2026-11-27T00:00:00.000Z",
        expiresAt: "2026-11-29T00:00:00.000Z",
      });
      expect(draft["sourceUpdatedAt"]).toBeUndefined();
      const sealed = sealRecord(registry, draft, {
        instanceId: "test.local",
        revision: 1,
        recordedAt: "2026-11-27T00:00:00Z",
      });
      expect(sealed.ok, sealed.ok ? "" : JSON.stringify(sealed.issues)).toBe(true);
    }
  });
});
