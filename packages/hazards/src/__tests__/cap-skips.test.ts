import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import {
  dwdFeed,
  fixture,
  gdacsFeed,
  meteoalarmFeed,
  nwsFeed,
  parseContext,
} from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * What the CAP parsers leave unread, counted by reason in the feed's skip
 * counts rather than in `ParseOutput.rejected`: the pipeline counts the
 * dropped records among the run's rejected ones itself.
 */

beforeEach(() => __resetSkips());

function parse(
  format: string,
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  at: string,
  cadenceSec = 120,
): ParseOutput {
  return hazardsDomain.formats[format]!.parse(feed, payloads, parseContext(at, cadenceSec));
}

describe("the cap format", () => {
  /** While the DWD thunderstorm warning was in force. */
  const AT = "2026-09-29T05:40:00Z";
  const base = fixture("dwd-thunderstorm.xml").toString("utf8");
  const ID = /<identifier>[^<]*<\/identifier>/;
  /** The warning under its own identifier, with each replacement applied once. */
  const variant = (id: string, ...replacements: [string | RegExp, string][]) =>
    Buffer.from(
      replacements.reduce(
        (doc, [from, to]) => doc.replace(from, to),
        base.replace(ID, `<identifier>${id}</identifier>`),
      ),
    );

  test("each record dropped or value left unread is counted by its reason", () => {
    const feed = dwdFeed();
    const out = parse(
      "cap",
      feed,
      {
        alerts: [
          variant("kept"),
          Buffer.from("<html><body>503</body></html>"),
          variant("cap-1.1", ["emergency:cap:1.2", "emergency:cap:1.1"]),
          variant("lowercase-status", ["<status>Actual", "<status>actual"]),
          variant("no-severity", ["<severity>Moderate", "<severity>Dangerous"]),
          variant("extra-category", [
            "<category>Met</category>",
            "<category>Met</category><category>Weather</category>",
          ]),
          variant("extra-response", [
            "<responseType>Prepare</responseType>",
            "<responseType>Prepare</responseType><responseType>Leave</responseType>",
          ]),
          variant("no-info", [/<info>[\s\S]*<\/info>/, ""]),
          variant("ack", ["<msgType>Alert", "<msgType>Ack"], [/<info>[\s\S]*<\/info>/, ""]),
          variant("exercise", ["<status>Actual", "<status>Exercise"]),
          variant("restricted", ["<scope>Public", "<scope>Restricted"]),
        ],
      },
      AT,
    );
    expect(drainSkipped(feed.id)).toEqual({
      malformed: 4,
      unsupported_version: 1,
      unknown_value: 2,
    });
    expect(out.rejected).toBeUndefined();
    expect(out.situations.map((s) => String(s["id"]).split(":").at(-1))).toEqual([
      "kept",
      "extra-category",
      "extra-response",
    ]);
    expect(out.records).toMatchObject({
      inputCount: 11,
      uniqueCount: 11,
      terminal: 3,
      accepted: 3,
    });
  });

  test("an unknown category or response is left out of the alert that is kept", () => {
    const feed = dwdFeed();
    const out = parse(
      "cap",
      feed,
      {
        alerts: [
          variant(
            "m",
            ["<category>Met</category>", "<category>Weather</category><category>Met</category>"],
            ["<responseType>Prepare</responseType>", "<responseType>Leave</responseType>"],
          ),
        ],
      },
      AT,
    );
    const cap = (out.situations[0]!["details"] as { cap: Record<string, unknown> }).cap;
    expect(cap["category"]).toEqual(["met"]);
    expect(cap).not.toHaveProperty("responseType");
    expect(drainSkipped(feed.id)).toEqual({ unknown_value: 2 });
  });

  test("an alert in no category CAP defines is malformed", () => {
    const feed = dwdFeed();
    const out = parse(
      "cap",
      feed,
      { alerts: [variant("m", ["<category>Met", "<category>Weather"])] },
      AT,
    );
    expect(out.situations).toEqual([]);
    expect(drainSkipped(feed.id)).toEqual({ malformed: 1 });
  });

  test("a parse that skips nothing records nothing", () => {
    const feed = dwdFeed();
    parse("cap", feed, { alerts: [variant("kept")] }, AT);
    expect(drainSkipped(feed.id)).toEqual({});
  });

  test("a time that names no instant and a language that is no tag are left out of the alert", () => {
    const feed = dwdFeed();
    const out = parse(
      "cap",
      feed,
      {
        alerts: [
          variant(
            "m",
            ["<onset>2026-09-29T07:01:00+02:00", "<onset>2026-09-29T07:01:00"],
            ["<effective>2026-09-29T07:01:00+02:00", "<effective>toString"],
            ["<language>de-DE", "<language>x-private"],
            [/<code>[^<]*<\/code>/, "<code></code>"],
          ),
        ],
      },
      AT,
    );
    const situation = out.situations[0]!;
    const cap = (situation["details"] as { cap: Record<string, unknown> }).cap;
    expect(cap).not.toHaveProperty("onset");
    expect(cap).not.toHaveProperty("effective");
    expect(cap).not.toHaveProperty("codes");
    // The warning is in force from when it was sent.
    expect(situation["validity"]).toMatchObject({ start: "2026-09-29T07:01:00+02:00" });
    expect((situation["headline"] as { lang: string }[])[0]!.lang).toBe("und");
    expect(sealFailures(out.situations)).toEqual([]);
    expect(drainSkipped(feed.id)).toEqual({ unknown_value: 3 });
  });

  test("a message sent at a time without a zone is malformed", () => {
    const feed = dwdFeed();
    const out = parse(
      "cap",
      feed,
      {
        alerts: [
          variant("kept"),
          variant("local", ["<sent>2026-09-29T07:01:00+02:00", "<sent>2026-09-29T07:01:00"]),
        ],
      },
      AT,
    );
    expect(out.situations).toHaveLength(1);
    expect(drainSkipped(feed.id)).toEqual({ malformed: 1 });
  });

  test("an empty info block is a hazard that does not read, not a failed parse", () => {
    const feed = dwdFeed();
    const out = parse("cap", feed, { alerts: [variant("m", ["<info>", "<info/><info>"])] }, AT);
    expect(out.situations).toHaveLength(1);
    expect(drainSkipped(feed.id)).toEqual({ malformed: 1 });
  });
});

describe("the nws format", () => {
  const AT = "2026-10-08T21:10:00Z";
  interface Feature {
    type: string;
    properties?: Record<string, unknown>;
    geometry?: unknown;
  }
  const snapshot = () =>
    JSON.parse(fixture("nws-alerts-active.json").toString("utf8")) as { features: Feature[] };

  test("each record dropped or value left unread is counted by its reason", () => {
    const feed = nwsFeed();
    const c = snapshot();
    const warning = c.features.find((f) => f.properties?.["event"] === "Flash Flood Warning")!;
    const variant = (id: string, changes: Record<string, unknown>): Feature => ({
      ...warning,
      properties: { ...warning.properties, id, references: [], ...changes },
    });
    c.features.push(
      { type: "Feature" },
      variant("bogus-type", { messageType: "Bogus" }),
      variant("weather", { category: "Weather" }),
      variant("leave", { response: "Leave" }),
    );
    const out = parse("nws", feed, { alerts: [Buffer.from(JSON.stringify(c))] }, AT);
    expect(drainSkipped(feed.id)).toEqual({ malformed: 3, unknown_value: 1 });
    expect(out.rejected).toBeUndefined();
    // The six captured features: five published, the stray Test message terminal.
    expect(out.records).toMatchObject({ inputCount: 10, terminal: 1, accepted: 6 });
  });

  test("a reference sent at no instant still relates the alert but is left out of its details", () => {
    const feed = nwsFeed();
    const c = snapshot();
    const warning = c.features.find((f) => f.properties?.["event"] === "Flash Flood Warning")!;
    const reference = { sender: "w-nws.webmaster@noaa.gov", identifier: "urn:x", sent: "soon" };
    c.features = [{ ...warning, properties: { ...warning.properties, references: [reference] } }];
    const out = parse("nws", feed, { alerts: [Buffer.from(JSON.stringify(c))] }, AT);
    const situation = out.situations[0]!;
    expect((situation["details"] as { cap: object }).cap).not.toHaveProperty("references");
    expect(situation["relations"]).toHaveLength(1);
    expect(sealFailures(out.situations)).toEqual([]);
    expect(drainSkipped(feed.id)).toEqual({ unknown_value: 1 });
  });
});

describe("the meteoalarm format", () => {
  const AT = "2026-10-08T15:00:00Z";

  test("each record dropped or value left unread is counted by its reason", () => {
    const feed = meteoalarmFeed();
    const ireland = JSON.parse(fixture("meteoalarm-ireland.json").toString("utf8")) as {
      warnings: { alert: { identifier: string; info: Record<string, unknown>[] } }[];
    };
    const warning = ireland.warnings[0]!;
    const variant = (id: string, change: Record<string, unknown>) => ({
      ...warning,
      alert: {
        ...warning.alert,
        identifier: `${warning.alert.identifier}.${id}`,
        info: warning.alert.info.map((i) => ({ ...i, ...change })),
      },
    });
    const out = parse(
      "meteoalarm",
      feed,
      {
        alerts: [
          Buffer.from(
            JSON.stringify({
              warnings: [
                warning,
                { uuid: "no-alert" },
                variant("probable", { certainty: "Probable" }),
                variant("weather", { category: ["Met", "Weather"] }),
              ],
            }),
          ),
          Buffer.from("<html>Service Unavailable</html>"),
        ],
      },
      AT,
    );
    expect(drainSkipped(feed.id)).toEqual({ malformed: 3, unknown_value: 1 });
    expect(out.rejected).toBeUndefined();
    expect(out.records).toMatchObject({ inputCount: 5, uniqueCount: 5, terminal: 0, accepted: 2 });
  });

  test("a null info block or area is a hazard that does not read, not a failed parse", () => {
    const feed = meteoalarmFeed();
    const ireland = JSON.parse(fixture("meteoalarm-ireland.json").toString("utf8")) as {
      warnings: { alert: { identifier: string; info: Record<string, unknown>[] } }[];
    };
    const warning = ireland.warnings[0]!;
    const info = warning.alert.info[0]!;
    const broken = {
      ...warning,
      alert: {
        ...warning.alert,
        identifier: `${warning.alert.identifier}.broken`,
        info: [null, { ...info, area: [null] }],
      },
    };
    const out = parse(
      "meteoalarm",
      feed,
      { alerts: [Buffer.from(JSON.stringify({ warnings: [warning, broken] }))] },
      AT,
    );
    expect(out.situations.length).toBeGreaterThan(0);
    expect(drainSkipped(feed.id)).toEqual({ malformed: 2 });
  });
});

describe("the gdacs format", () => {
  const AT = "2026-10-09T01:15:00Z";
  const rss = fixture("gdacs-rss.xml").toString("utf8");

  test("an event type it does not map is unknown, an alert colour unread; earthquakes stay terminal", () => {
    const feed = gdacsFeed();
    const items = rss
      .split("<item>")
      .slice(1)
      .map((i) => `<item>${i.split("</item>")[0]}</item>`);
    const volcano = items.find((i) => i.includes("VO1000151"))!;
    const unmapped = volcano
      .replaceAll("VO1000151", "XX1000151")
      .replace(/<gdacs:eventtype>VO/, "<gdacs:eventtype>XX");
    const purple = volcano.replace(/<gdacs:alertlevel>[^<]*/, "<gdacs:alertlevel>Purple");
    const quake = items.find((i) => /<gdacs:eventtype>EQ/.test(i))!;
    const out = parse(
      "gdacs",
      feed,
      {
        events: [
          Buffer.from(
            `<rss version="2.0" xmlns:gdacs="http://www.gdacs.org" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:georss="http://www.georss.org/georss"><channel>${unmapped}${purple}${quake}</channel></rss>`,
          ),
        ],
      },
      AT,
      600,
    );
    expect(drainSkipped(feed.id)).toEqual({ unknown_type: 1, unknown_value: 1 });
    expect(out.situations).toHaveLength(1);
    expect(out.situations[0]!["severity"]).toEqual({ label: "unknown" });
    expect(out.records).toMatchObject({ inputCount: 3, terminal: 1, accepted: 1 });
  });
});
