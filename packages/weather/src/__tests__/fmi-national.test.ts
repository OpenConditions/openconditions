import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { weatherDomain } from "../domain.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/weather-feed.js";

const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/fmi/national/oracle.json", import.meta.url), "utf8"),
);
test("qualified FMI cohort is enabled and independently reconciles every national captured reading", () => {
  const feed = catalogFeed("fi-fmi-weather");
  expect(feed.disabled).toBeUndefined();
  const format = weatherDomain.formats["fmi-weather"]!;
  expect(format.acquisitionBlocked).toBeUndefined();
  const out = format.parse(
    feed,
    {
      sites: [121, 122, 224].map((n) => fixture(`fmi/national/stations-${n}.xml`)),
      status: [fixture("fmi/national/observations.xml")],
    },
    parseContext("2026-11-09T16:40:18.421Z", 600),
  );
  expect(out.featuresComplete).toBe(false);
  expect(out.features).toHaveLength(193);
  expect(out.observations).toHaveLength(1108);
  expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  const seen = new Set<string>();
  for (const o of out.observations) {
    const subject = o.subject as { featureId: string; componentKey: string };
    const id = `${subject.featureId.split(":").at(-1)}:${subject.componentKey}`;
    expect(seen.has(id)).toBe(false);
    seen.add(id);
    const e = oracle.readings[id];
    expect(e).toBeDefined();
    expect(o.result).toMatchObject({ value: e.value });
    expect(o.phenomenonTime).toMatchObject({
      end: new Date(e.epoch * 1000).toISOString().replace(".000Z", "Z"),
    });
    expect(o.freshness).toMatchObject({
      expiresAt: new Date((e.epoch + 3600) * 1000).toISOString().replace(".000Z", "Z"),
    });
    expect(o.quality).toBeUndefined();
  }
  expect([...seen].sort()).toEqual(Object.keys(oracle.readings).sort());
});
