import { describe, expect, it } from "vitest";
import { parkingDomain } from "../domain.js";
import { parseTaipei, taipeiTime, twd97ToWgs84 } from "../formats/taipei.js";
import { catalogFeed, fixture, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const now = "2026-11-07T08:11:00Z";
const payloads = () => ({
  sites: [fixture("taipei-sites.xml")],
  status: [fixture("taipei-status.xml")],
});
const feed = () => catalogFeed("tw-tpe-pma-parking");
describe("Taipei XML", () => {
  it("registers both required roles and retains static and suffixed identifiers", () => {
    expect(parkingDomain.formats["taipei"]?.endpoints).toEqual({
      sites: { required: true },
      status: { required: true },
    });
    const out = parseTaipei(feed(), payloads(), parseContext(now));
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(out.features).toHaveLength(5);
    expect(JSON.stringify(out.features)).toContain("TPE0201U03");
    expect(out.observations.length).toBeGreaterThan(0);
    expect(out.features.every((f) => f["capacityTotal"] === undefined)).toBe(true);
    expect(out.publication).toMatchObject({
      featuresComplete: false,
      offersComplete: false,
      statesComplete: false,
    });
  });
  it("uses a strict Taipei clock independent of process timezone", () => {
    expect(taipeiTime("Sat Nov 07 16:10:00 CST 2026")).toBe("2026-11-07T08:10:00.000Z");
    for (const bad of ["Sat Feb 30 16:10:00 CST 2026", "Sat Nov 07 16:10:00 UTC 2026", "garbage"])
      expect(() => taipeiTime(bad)).toThrow();
    for (const at of ["2026-11-07T09:00:00Z", "2026-11-07T07:00:00Z"])
      expect(() => parseTaipei(feed(), payloads(), parseContext(at))).toThrow();
  });
  it("checks the EPSG:3826 control point and rejects metre and zero points", () => {
    const [lon, lat] = twd97ToWgs84(302864.7812, 2771988.958);
    expect(lon).toBeCloseTo(121.5239542491223, 6);
    expect(lat).toBeCloseTo(25.055154434593323, 6);
    const out = parseTaipei(feed(), payloads(), parseContext(now));
    expect(JSON.stringify(out.features)).toContain("121.5242,25.0552");
  });
  it.each(["", "<ERROR>unavailable</ERROR>", "<DATA/>", "<DATA><PARK>"])(
    "rejects unusable XML %s",
    (bad) => {
      for (const role of ["sites", "status"] as const)
        expect(() =>
          parseTaipei(feed(), { ...payloads(), [role]: [Buffer.from(bad)] }, parseContext(now)),
        ).toThrow();
    },
  );
  it("preserves zero but omits negative, missing, fractional and over-capacity counts", () => {
    const p = payloads();
    p.status = [
      Buffer.from(
        "<DATA><UPDATETIME>Sat Nov 07 16:10:00 CST 2026</UPDATETIME><PARK><ID>TPE0001</ID><AVAILABLECAR>0</AVAILABLECAR><AVAILABLEMOTOR>-9</AVAILABLEMOTOR></PARK></DATA>",
      ),
    ];
    const out = parseTaipei(feed(), p, parseContext(now));
    expect(out.observations).toHaveLength(1);
    expect(out.observations[0]?.["result"]).toEqual({ type: "count", value: 0 });
    for (const bad of ["-9", "-6", "2.5", "18", ""]) {
      const q = {
        ...p,
        status: [
          Buffer.from(
            p.status[0]!.toString().replace(
              "<AVAILABLECAR>0</AVAILABLECAR>",
              `<AVAILABLECAR>${bad}</AVAILABLECAR>`,
            ),
          ),
        ],
      };
      expect(parseTaipei(feed(), q, parseContext(now)).observations).toHaveLength(0);
    }
  });
  it("rejects duplicate identities and orphan status rows rather than claiming completeness", () => {
    const p = payloads();
    const row = "<PARK><ID>TPE0001</ID></PARK>";
    expect(() =>
      parseTaipei(
        feed(),
        {
          ...p,
          status: [Buffer.from(p.status[0]!.toString().replace("</DATA>", row + "</DATA>"))],
        },
        parseContext(now),
      ),
    ).toThrow();
    expect(() =>
      parseTaipei(
        feed(),
        { ...p, status: [Buffer.from(p.status[0]!.toString().replace("TPE0001", "ORPHAN"))] },
        parseContext(now),
      ),
    ).toThrow();
  });
});

it("keeps stable IDs across row order and tag case, and handles absent/zero/multiple entrances", () => {
  const p = payloads();
  const xml = p.sites[0]!.toString();
  const rows = xml.match(/<PARK>[\s\S]*?<\/PARK>/g)!;
  const swapped = xml
    .replace(/<PARK>[\s\S]*<\/PARK>/, [...rows].reverse().join("\n"))
    .replace(/<(\/?)([A-Za-z_]+)>/g, (_s, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
  const a = parseTaipei(feed(), p, parseContext(now));
  const b = parseTaipei(feed(), { ...p, sites: [Buffer.from(swapped)] }, parseContext(now));
  expect(a.features.map((f) => f["id"]).sort()).toEqual(b.features.map((f) => f["id"]).sort());
  for (const [entry, expected] of [
    ["", []],
    ["<EntrancecoordInfo><Xcod>0</Xcod><Ycod>0</Ycod></EntrancecoordInfo>", []],
    [
      "<EntrancecoordInfo><Xcod>25.05</Xcod><Ycod>121.52</Ycod></EntrancecoordInfo><EntrancecoordInfo><Xcod>25.06</Xcod><Ycod>121.53</Ycod></EntrancecoordInfo>",
      [
        [121.52, 25.05],
        [121.53, 25.06],
      ],
    ],
  ] as const) {
    const altered = xml.replace(
      /<EntranceCoord>[\s\S]*?<\/EntranceCoord>/,
      `<EntranceCoord>${entry}</EntranceCoord>`,
    );
    const out = parseTaipei(feed(), { ...p, sites: [Buffer.from(altered)] }, parseContext(now));
    expect(sealFailures(out.features)).toEqual([]);
    const location = out.features[0]!["details"] as {
      entrances?: { point: { coordinates: number[] } }[];
    };
    expect((location.entrances ?? []).map((e) => e.point.coordinates)).toEqual(expected);
  }
});
it("refuses activation without explicit qualification", () => {
  const f = feed();
  delete f.disabled;
  expect(parkingDomain.lintFeed?.(f)).toContain(
    "taipei activation requires qualifiedSnapshot after geometry/time and withdrawal qualification",
  );
});

it("interprets CST under other process timezones", () => {
  const original = process.env["TZ"];
  try {
    for (const tz of ["UTC", "America/Chicago", "Asia/Taipei"]) {
      process.env["TZ"] = tz;
      expect(taipeiTime("Sat Nov 07 16:10:00 CST 2026")).toBe("2026-11-07T08:10:00.000Z");
    }
  } finally {
    if (original === undefined) delete process.env["TZ"];
    else process.env["TZ"] = original;
  }
});

it("maps all five categories and overlapping reserved counts exactly", () => {
  const p = payloads();
  const tags = ["TOTALCAR", "TOTALMOTOR", "TOTALBUS", "Pregnancy_First", "Handicap_First"];
  let xml = p.sites[0]!.toString();
  for (const tag of tags)
    xml = xml.replace(new RegExp(`<${tag}>.*?</${tag}>`), `<${tag}>20</${tag}>`);
  p.sites = [Buffer.from(xml)];
  p.status = [
    Buffer.from(
      `<DATA><UPDATETIME>Sat Nov 07 16:10:00 CST 2026</UPDATETIME><PARK><ID>TPE0001</ID><AVAILABLECAR>17</AVAILABLECAR><AVAILABLEMOTOR>4</AVAILABLEMOTOR><AVAILABLEBUS>3</AVAILABLEBUS><AVAILABLEHANDICAP>2</AVAILABLEHANDICAP><AVAILABLEPREGNANCY>1</AVAILABLEPREGNANCY></PARK></DATA>`,
    ),
  ];
  const out = parseTaipei(feed(), p, parseContext(now));
  const components = out.features[0]!["components"] as {
    details: { vehicleType: string; userGroup: string; capacity: number };
  }[];
  expect(
    components.map((c) => [c.details.vehicleType, c.details.userGroup, c.details.capacity]),
  ).toEqual([
    ["car", "any", 20],
    ["motorcycle", "any", 20],
    ["bus", "any", 20],
    ["any", "disabled", 20],
    ["any", "family", 20],
  ]);
  expect(out.observations.map((o) => o["result"])).toEqual(
    [17, 4, 3, 2, 1].map((value) => ({ type: "count", value })),
  );
});
