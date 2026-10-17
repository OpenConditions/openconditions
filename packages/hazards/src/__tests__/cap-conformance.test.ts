import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertCovered,
  definitionEnum,
  jsonSchemaEnums,
  openApiValidator,
  pinnedJson,
  pinnedOrUnavailable,
  type SchemaFile,
  unzip,
  xsdErrors,
} from "@openconditions/conformance";
import { CAP_SCHEMA, CAP_V1_2 } from "@openconditions/conformance/standards/cap-v1.2";
import { NWS_API } from "@openconditions/conformance/standards/nws-api";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
  type SkipCounts,
} from "@openconditions/ingest-framework";
import { CAP_1_2 } from "@openconditions/model-hazards";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import {
  type CapSchema,
  capJsonAsXml,
  capSchema,
  capValues,
  embeddedCapAlerts,
} from "./helpers/cap-xsd.js";
import {
  dwdFeed,
  fixture,
  gdacsFeed,
  meteoalarmFeed,
  nwsFeed,
  parseContext,
} from "./helpers/hazards-feed.js";

/**
 * The CAP parsers held to OASIS CAP 1.2 itself: the captured messages
 * validate against the pinned schema, and every value the schema enumerates
 * is shown handled by running the real parser over a message carrying it, or
 * is listed as unsupported with the reason.
 */

beforeEach(() => __resetSkips());

let cap: CapSchema | undefined;
let capFiles: SchemaFile[] = [];
let nwsApi: Record<string, unknown> | undefined;
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(CAP_V1_2);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  capFiles = pinned.files;
  cap = capSchema(capFiles);
  const api = await pinnedOrUnavailable(NWS_API);
  if ("unavailable" in api) unavailable = api.unavailable;
  else nwsApi = await pinnedJson(NWS_API, "openapi.json");
}, 60_000);

const schema = (): CapSchema => cap!;
const valid = (xml: string, name?: string) => xsdErrors(xml, capFiles, CAP_SCHEMA, name);
const text = (name: string) => fixture(name).toString("utf8");

describe("captured CAP messages against the CAP 1.2 schema", () => {
  // No captured message deviates from the schema: DWD, ECCC, GDACS and
  // MeteoAlarm all publish schema-valid CAP 1.2.
  const DIRECT = [
    "dwd-thunderstorm.xml",
    "dwd-coastal-gusts-mul.xml",
    "dwd-coast-strong-wind-mul.xml",
    "eccc-fog.xml",
    "eccc-storm-surge.xml",
    "eccc-storm-surge-ended.xml",
    ...readdirSync(join(import.meta.dirname, "fixtures", "eccc-datamart"))
      .filter((n) => n.endsWith(".cap"))
      .map((n) => `eccc-datamart/${n}`),
  ];

  test.for(DIRECT)("%s is valid", async (name, { skip }) => {
    if (unavailable) skip(unavailable);
    expect(await valid(text(name), name)).toEqual([]);
  });

  test("every entry of DWD's status zip is valid", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    const entries = [...unzip(new Uint8Array(fixture("dwd-stat-mul.zip")))];
    expect(entries).toHaveLength(3);
    for (const [name, bytes] of entries) {
      expect(await valid(new TextDecoder().decode(bytes), name), name).toEqual([]);
    }
  });

  test("every CAP alert GDACS embeds in its RSS is valid", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    const alerts = embeddedCapAlerts(text("gdacs-cap.xml"));
    expect(alerts).toHaveLength(5);
    for (const alert of alerts) expect(await valid(alert)).toEqual([]);
  });

  test("MeteoAlarm's JSON alerts are valid CAP once written as the XML they render", async ({
    skip,
  }) => {
    // MeteoAlarm publishes no JSON Schema for its warnings API; its Hub API
    // validates every submitted warning against CAP-v1.2.xsd
    // (https://api.meteoalarm.org/hub/v1), and the JSON is that XML with
    // every element a key, so the XML it renders must validate too.
    if (unavailable) skip(unavailable);
    const countries = ["austria", "croatia", "czechia", "france", "ireland", "switzerland"];
    for (const name of [
      ...countries.map((c) => `meteoalarm-${c}.json`),
      "meteoalarm-warnings.json",
    ]) {
      const { warnings } = JSON.parse(text(name)) as { warnings: { alert: unknown }[] };
      expect(warnings.length, name).toBeGreaterThan(0);
      for (const { alert } of warnings) {
        expect(await valid(capJsonAsXml(schema(), alert)), name).toEqual([]);
      }
    }
  });

  test("the schema refuses a value CAP does not enumerate", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    const errors = await valid(text("dwd-thunderstorm.xml").replace(">Actual<", ">Real<"));
    expect(errors.join("\n")).toMatch(/'Real' is not an element of the set/);
  });
});

describe("NWS alerts against the weather.gov OpenAPI document", () => {
  test("the captured snapshot is a valid active alert collection", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const validate = openApiValidator(nwsApi!, "ActiveAlertCollectionGeoJson");
    const snapshot = JSON.parse(text("nws-alerts-active.json")) as {
      features: { properties: Record<string, unknown> }[];
    };
    expect(validate(snapshot)).toEqual([]);
    snapshot.features[0]!.properties["status"] = "Real";
    expect(validate(snapshot).join("\n")).toMatch(/must be equal to one of the allowed values/);
  });

  test("every property of its Alert is read", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const ENDS = "2026-10-10T20:00:00+00:00";
    const zone = "https://api.weather.gov/zones/forecast/FLZ019";
    const f = nwsFeature({ id: "m", responseType: ["Prepare"], references: "orig" });
    const p = {
      ...f.properties,
      geocode: { UGC: ["FLZ019"], SAME: ["012079"] },
      affectedZones: [zone],
      references: [
        {
          "@id": "https://api.weather.gov/alerts/orig",
          identifier: "orig",
          sender: SENDER,
          sent: SENT,
        },
      ],
      onset: "2026-10-08T22:00:00+00:00",
      ends: ENDS,
      headline: "Wind Advisory issued by NWS",
      description: "Strong wind.",
      instruction: "Secure loose objects.",
      note: "Non-Weather Emergency Message. Not sent to IPAWS.",
      parameters: {
        NWSheadline: ["WIND ADVISORY IN EFFECT"],
        VTEC: ["/O.NEW.KTAE.WI.Y.0012.261008T2000Z-261010T2000Z/"],
      },
      code: "IPAWSv1.0",
      web: "http://www.weather.gov",
      eventCode: { SAME: ["WIY"], NationalWeatherService: ["WIY"] },
    };
    const alert = openApiValidator(nwsApi!, "Alert");
    expect(alert(p)).toEqual([]);
    const feed = nwsFeed();
    drainSkipped(feed.id);
    const out = hazardsDomain.formats["nws"]!.parse(
      feed,
      { alerts: [json({ type: "FeatureCollection", features: [{ ...f, properties: p }] })] },
      parseContext(FETCHED, 120),
    );
    expect(drainSkipped(feed.id)).toEqual({});
    const s = out.situations[0]!;
    const c = capOf(s);
    const location = s["location"] as {
      areaDescription: { text: string }[];
      admin: { geocodes: unknown[] };
      external: unknown[];
    };
    const checks: Readonly<Record<string, () => boolean>> = {
      id: () => c["identifier"] === "m",
      areaDesc: () => location.areaDescription[0]!.text === "Test area",
      geocode: () =>
        same(location.admin.geocodes, [
          { scheme: "ugc", code: "FLZ019" },
          { scheme: "same", code: "012079" },
        ]),
      affectedZones: () => same(location.external, [{ system: "nws:forecast", code: "FLZ019" }]),
      references: () =>
        (c["references"] as { identifier: string }[])[0]!.identifier === "orig" &&
        (s["relations"] as unknown[]).length === 1,
      sent: () => c["sent"] === SENT,
      effective: () => c["effective"] === SENT,
      onset: () => c["onset"] === p.onset,
      expires: () => c["expires"] === EXPIRES,
      ends: () => c["ends"] === ENDS && (s["validity"] as { end: string }).end === ENDS,
      status: () => c["status"] === "actual",
      messageType: () => c["msgType"] === "alert",
      category: () => same(c["category"], ["met"]),
      severity: () => c["severity"] === "moderate",
      certainty: () => c["certainty"] === "likely",
      urgency: () => c["urgency"] === "expected",
      event: () => first(c["event"])?.text === "Wind",
      sender: () => c["sender"] === SENDER,
      senderName: () => first(c["senderName"])?.text === "Test office",
      headline: () => first(s["headline"])?.text === p.headline,
      description: () => first(s["description"])?.text === p.description,
      instruction: () => first(s["instruction"])?.text === p.instruction,
      note: () => c["note"] === p.note,
      response: () => same(c["responseType"], ["prepare"]),
      parameters: () =>
        (c["parameters"] as unknown[]).length === 2 &&
        (c["vtec"] as { action: string }[])[0]!.action === "NEW",
      scope: () => c["scope"] === "public",
      code: () => same(c["codes"], ["IPAWSv1.0"]),
      language: () => first(c["event"])?.lang === "en-US",
      web: () => c["web"] === "http://www.weather.gov",
      eventCode: () => (c["eventCodes"] as unknown[]).length === 2,
    };
    const schemas = (nwsApi!["components"] as { schemas: Record<string, unknown> }).schemas;
    const properties = Object.keys((schemas["Alert"] as { properties: object }).properties);
    assertCovered("Alert", properties, {
      handled: (property) => Object.hasOwn(checks, property) && checks[property]!(),
    });
  });

  test("its alert enumerations are CAP 1.2's", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const sorted = (values: readonly string[]) => [...values].sort();
    const inline = jsonSchemaEnums(nwsApi);
    const nws: Record<string, string[]> = {
      status: definitionEnum(nwsApi, "AlertStatus"),
      msgType: definitionEnum(nwsApi, "AlertMessageType"),
      scope: inline.get("#/components/schemas/Alert/properties/scope")!,
      category: inline.get("#/components/schemas/Alert/properties/category")!,
      responseType: inline.get("#/components/schemas/Alert/properties/response")!,
      urgency: definitionEnum(nwsApi, "AlertUrgency"),
      severity: definitionEnum(nwsApi, "AlertSeverity"),
      certainty: definitionEnum(nwsApi, "AlertCertainty"),
    };
    for (const [element, values] of Object.entries(nws)) {
      expect(sorted(values), element).toEqual(sorted(capValues(schema(), element)));
    }
  });
});

test("the model's CAP 1.2 enumerations are the schema's, with CAP 1.0's Very Likely beside them", ({
  skip,
}) => {
  if (unavailable) skip(unavailable);
  for (const [element, values] of Object.entries(CAP_1_2)) {
    const standard = capValues(schema(), element);
    expect(
      values.filter((v) => v !== "Very Likely"),
      element,
    ).toEqual(standard);
  }
  expect(Object.keys(CAP_1_2).sort()).toEqual([
    "category",
    "certainty",
    "msgType",
    "responseType",
    "scope",
    "severity",
    "status",
    "urgency",
  ]);
});

const FETCHED = "2026-10-08T21:00:00Z";
const SENT = "2026-10-08T20:00:00+00:00";
const EXPIRES = "2026-10-09T20:00:00+00:00";
const SENDER = "warnings@example.org";
const AREA = "50,10 50,11 51,11 51,10 50,10";

/** A minimal CAP message: every header and info field CAP requires, an area with a polygon, and the fields under test. */
interface Message {
  id: string;
  status?: string;
  msgType?: string;
  scope?: string;
  /** The id of a message of the same parse this one references. */
  references?: string;
  category?: string[];
  responseType?: string[];
  urgency?: string;
  severity?: string;
  certainty?: string;
  /** No info block at all. */
  bare?: boolean;
}

/** The message in CAP's own shape, as MeteoAlarm writes it as JSON. */
const capJson = (m: Message) => ({
  identifier: m.id,
  sender: SENDER,
  sent: SENT,
  status: m.status ?? "Actual",
  msgType: m.msgType ?? "Alert",
  scope: m.scope ?? "Public",
  ...(m.references === undefined ? {} : { references: `${SENDER},${m.references},${SENT}` }),
  ...(m.bare
    ? {}
    : {
        info: [
          {
            language: "en-GB",
            category: m.category ?? ["Met"],
            event: "Wind",
            ...(m.responseType === undefined ? {} : { responseType: m.responseType }),
            urgency: m.urgency ?? "Expected",
            severity: m.severity ?? "Moderate",
            certainty: m.certainty ?? "Likely",
            expires: EXPIRES,
            area: [{ areaDesc: "Test area", polygon: [AREA] }],
          },
        ],
      }),
});

/** The message as one feature of NWS's alert collection: one category, one response. */
const nwsFeature = (m: Message) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [AREA.split(" ").map((p) => p.split(",").map(Number).reverse())],
  },
  properties: {
    id: m.id,
    areaDesc: "Test area",
    geocode: {},
    affectedZones: [],
    references:
      m.references === undefined ? [] : [{ identifier: m.references, sender: SENDER, sent: SENT }],
    sent: SENT,
    effective: SENT,
    expires: EXPIRES,
    status: m.status ?? "Actual",
    messageType: m.msgType ?? "Alert",
    category: (m.category ?? ["Met"])[0],
    severity: m.severity ?? "Moderate",
    certainty: m.certainty ?? "Likely",
    urgency: m.urgency ?? "Expected",
    event: "Wind",
    sender: SENDER,
    senderName: "Test office",
    ...(m.responseType === undefined ? {} : { response: m.responseType[0] }),
    scope: m.scope ?? "Public",
    language: "en-US",
  },
});

interface CapFormat {
  name: string;
  feed: () => HazardsCatalogFeed;
  payloads: (messages: readonly Message[]) => FeedPayloads;
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

const FORMATS: readonly CapFormat[] = [
  {
    name: "cap",
    feed: dwdFeed,
    payloads: (messages) => ({
      alerts: messages.map((m) => Buffer.from(capJsonAsXml(schema(), capJson(m)))),
    }),
  },
  {
    name: "meteoalarm",
    feed: meteoalarmFeed,
    payloads: (messages) => ({
      alerts: [json({ warnings: messages.map((m) => ({ alert: capJson(m), uuid: m.id })) })],
    }),
  },
  {
    name: "nws",
    feed: nwsFeed,
    payloads: (messages) => ({
      alerts: [json({ type: "FeatureCollection", features: messages.map(nwsFeature) })],
    }),
  },
];

/** One parse of the messages by the format, and the skips it recorded. */
function run(
  format: CapFormat,
  messages: readonly Message[],
): { out: ParseOutput; skips: SkipCounts } {
  const feed = format.feed();
  drainSkipped(feed.id);
  const out = hazardsDomain.formats[format.name]!.parse(
    feed,
    format.payloads(messages),
    parseContext(FETCHED, 120),
  );
  return { out, skips: drainSkipped(feed.id) };
}

type Cap = Record<string, unknown> & { category?: string[]; responseType?: string[] };
/** A situation's CAP details; none for no situation. */
const capOf = (s: RecordDraft | undefined): Partial<Cap> =>
  (s?.["details"] as { cap?: Cap } | undefined)?.cap ?? {};
const idOf = (format: CapFormat, id: string) => `oc:situation:${format.feed().id}:${id}`;

/** The one situation a single message published, cleanly: no skips, nothing terminal. */
function single(format: CapFormat, message: Message): RecordDraft | undefined {
  const { out, skips } = run(format, [message]);
  return out.situations.length === 1 &&
    out.records?.terminal === 0 &&
    Object.keys(skips).length === 0
    ? out.situations[0]
    : undefined;
}

/** Whether a single message published nothing and ended as terminal, not skipped. */
function withheld(format: CapFormat, message: Message): boolean {
  const { out, skips } = run(format, [message]);
  return (
    out.situations.length === 0 && out.records?.terminal === 1 && Object.keys(skips).length === 0
  );
}

/**
 * What CAP 1.2 (3.2.1) says each `status` is: only an `Actual` message is
 * "actionable by all targeted recipients"; an exercise is "not real", a
 * system message supports "alert network internal functions", a test is for
 * "technical testing only, all recipients disregard", and a draft is "not
 * actionable in its current form". Only the actual ones publish.
 */
const STATUS_PUBLISHES: Readonly<Record<string, boolean>> = {
  Actual: true,
  Exercise: false,
  System: false,
  Test: false,
  Draft: false,
};

/**
 * What CAP 1.2 (3.2.1) says each `scope` is: `Public` "for general
 * dissemination to unrestricted audiences", `Restricted` "only to users with
 * a known operational requirement", `Private` "only to specified addresses".
 * A public service republishes only the public ones.
 */
const SCOPE_PUBLISHES: Readonly<Record<string, boolean>> = {
  Public: true,
  Restricted: false,
  Private: false,
};

/**
 * What a message of each `msgType` does to an earlier message `orig` of the
 * same parse it references (CAP 1.2, 3.2.1): an `Update` "supersedes" it, a
 * `Cancel` cancels it, an `Ack` "acknowledges receipt and acceptance" and an
 * `Error` "indicates rejection" of it, neither a hazard of its own; a new
 * `Alert` stands beside it.
 */
const MSG_TYPE_OUTCOME: Readonly<Record<string, (out: ParseOutput, format: CapFormat) => boolean>> =
  {
    Alert: (out) =>
      out.situations.length === 2 &&
      out.situations.every((s) => (s["validity"] as { status: string }).status === "active") &&
      capOf(out.situations[1]!)["msgType"] === "alert",
    Update: (out, f) =>
      out.situations.length === 1 &&
      out.records?.terminal === 1 &&
      out.situations[0]!["id"] === idOf(f, "m") &&
      capOf(out.situations[0]!)["msgType"] === "update" &&
      out.situations[0]!["groupId"] === "orig" &&
      JSON.stringify(out.situations[0]!["relations"]) ===
        JSON.stringify([
          { relation: "update_of", ref: { class: "situation", id: idOf(f, "orig") } },
        ]),
    Cancel: (out, f) =>
      out.situations.length === 1 &&
      out.records?.terminal === 1 &&
      capOf(out.situations[0]!)["msgType"] === "cancel" &&
      (out.situations[0]!["validity"] as { status: string }).status === "cancelled" &&
      JSON.stringify(out.situations[0]!["relations"]) ===
        JSON.stringify([{ relation: "cancels", ref: { class: "situation", id: idOf(f, "orig") } }]),
    Ack: (out, f) =>
      out.situations.length === 1 &&
      out.records?.terminal === 1 &&
      out.situations[0]!["id"] === idOf(f, "orig"),
    Error: (out, f) =>
      out.situations.length === 1 &&
      out.records?.terminal === 1 &&
      out.situations[0]!["id"] === idOf(f, "orig"),
  };

/**
 * CAP severities as the situation's declared label, by CAP 1.2's definitions
 * (3.2.2): `Extreme` an "extraordinary threat to life or property",
 * `Severe` a "significant threat", `Moderate` a "possible threat", `Minor`
 * "minimal to no known threat".
 */
const SEVERITY_LABEL: Readonly<Record<string, string>> = {
  Extreme: "critical",
  Severe: "major",
  Moderate: "moderate",
  Minor: "minor",
  Unknown: "unknown",
};

/** A CAP token as the model's vocabulary writes it: `AllClear` → `all_clear`, `CBRNE` → `cbrne`. */
const snake = (token: string) => token.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

describe.each(FORMATS)("the $name format covers every value CAP 1.2 enumerates", (format) => {
  test("status: only actual messages publish", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("status", capValues(schema(), "status"), {
      handled: (v) =>
        Object.hasOwn(STATUS_PUBLISHES, v) &&
        (STATUS_PUBLISHES[v]
          ? capOf(single(format, { id: "m", status: v }))["status"] === snake(v)
          : withheld(format, { id: "m", status: v })),
    });
  });

  test("scope: only public messages publish", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("scope", capValues(schema(), "scope"), {
      handled: (v) =>
        Object.hasOwn(SCOPE_PUBLISHES, v) &&
        (SCOPE_PUBLISHES[v]
          ? capOf(single(format, { id: "m", scope: v }))["scope"] === snake(v)
          : withheld(format, { id: "m", scope: v })),
    });
  });

  test("msgType: updates and cancels supersede, acknowledgements and errors publish nothing", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    assertCovered("msgType", capValues(schema(), "msgType"), {
      handled: (v) => {
        if (!Object.hasOwn(MSG_TYPE_OUTCOME, v)) return false;
        const { out, skips } = run(format, [
          { id: "orig" },
          { id: "m", msgType: v, references: "orig" },
        ]);
        return Object.keys(skips).length === 0 && MSG_TYPE_OUTCOME[v]!(out, format);
      },
    });
  });

  test("category: each is the alert's category", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("category", capValues(schema(), "category"), {
      handled: (v) => {
        const s = single(format, { id: "m", category: [v] });
        return s !== undefined && JSON.stringify(capOf(s).category) === JSON.stringify([snake(v)]);
      },
    });
  });

  test("responseType: each is the alert's response; AllClear ends the warning", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("responseType", capValues(schema(), "responseType"), {
      handled: (v) => {
        const s = single(format, { id: "m", responseType: [v] });
        const status = (s?.["validity"] as { status?: string } | undefined)?.status;
        return (
          s !== undefined &&
          JSON.stringify(capOf(s).responseType) === JSON.stringify([snake(v)]) &&
          status === (v === "AllClear" ? "ended" : "active")
        );
      },
    });
  });

  test("urgency: each is kept as CAP states it", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("urgency", capValues(schema(), "urgency"), {
      handled: (v) => capOf(single(format, { id: "m", urgency: v }))["urgency"] === snake(v),
    });
  });

  test("severity: each is kept, and declares the situation's severity", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("severity", capValues(schema(), "severity"), {
      handled: (v) => {
        const s = single(format, { id: "m", severity: v });
        const severity = s?.["severity"] as { label?: string; declaredRaw?: string } | undefined;
        return (
          s !== undefined &&
          Object.hasOwn(SEVERITY_LABEL, v) &&
          capOf(s)["severity"] === snake(v) &&
          severity?.label === SEVERITY_LABEL[v] &&
          severity?.declaredRaw === v
        );
      },
    });
  });

  test("certainty: each is kept, and is the situation's certainty", ({ skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered("certainty", capValues(schema(), "certainty"), {
      handled: (v) => {
        const s = single(format, { id: "m", certainty: v });
        return s !== undefined && capOf(s)["certainty"] === snake(v) && s["certainty"] === snake(v);
      },
    });
  });
});

describe("CAP values outside the schema", () => {
  const capFormat = FORMATS[0]!;

  test("CAP 1.0's Very Likely is read as Likely, as CAP 1.2 (3.2.2) tells receivers to", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const s = single(capFormat, { id: "m", certainty: "Very Likely" });
    expect(s).toBeDefined();
    expect(s!["certainty"]).toBe("likely");
    expect(capOf(s!)["certainty"]).toBe("likely");
  });

  test.for(FORMATS)(
    "$name: the minimal messages the coverage runs on are valid CAP",
    async (format, { skip }) => {
      if (unavailable) skip(unavailable);
      expect(
        await valid(capJsonAsXml(schema(), capJson({ id: "m", responseType: ["Prepare"] }))),
      ).toEqual([]);
      expect(single(format, { id: "m" })).toBeDefined();
    },
  );
});

/** One message carrying every element CAP 1.2 declares, each with a value the checks below can find. */
const FULL = {
  identifier: "2.49.0.0.250.0.FR.full",
  sender: SENDER,
  sent: SENT,
  status: "Actual",
  msgType: "Alert",
  source: "Forecaster 7",
  scope: "Public",
  restriction: "Emergency services only",
  addresses: '"Fire Brigade" police',
  code: ["profile:test:1.0"],
  note: "Issued for the coverage check",
  references: `${SENDER},earlier,${SENT}`,
  incidents: "INC-1",
  info: [
    {
      language: "de-DE",
      category: ["Met"],
      event: "Wind",
      responseType: ["Prepare"],
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely",
      audience: "Everyone",
      eventCode: [{ valueName: "SAME", value: "HWW" }],
      effective: SENT,
      onset: "2026-10-08T22:00:00+00:00",
      expires: EXPIRES,
      senderName: "Test office",
      headline: "Wind warning",
      description: "Strong wind.",
      instruction: "Stay inside.",
      web: "https://example.org/warning",
      contact: "Duty officer",
      parameter: [{ valueName: "gusts", value: "90 km/h" }],
      resource: [
        {
          resourceDesc: "Map",
          mimeType: "image/png",
          size: "1024",
          uri: "https://example.org/map.png",
          derefUri: "iVBORw0KGgo=",
          digest: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
        },
      ],
      area: [
        {
          areaDesc: "Test area",
          polygon: [AREA],
          circle: ["50.5,12.5 5"],
          geocode: [{ valueName: "NUTS3", value: "FR101" }],
          altitude: "100",
          ceiling: "3000",
        },
      ],
    },
  ],
};

type Check = (s: RecordDraft, cap: Record<string, unknown>) => boolean;
const first = (t: unknown) => (t as { lang: string; text: string }[] | undefined)?.[0];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const locationOf = (s: RecordDraft) =>
  s["location"] as {
    geometry: { type: string; coordinates: unknown[] };
    areaDescription?: unknown;
    admin?: { geocodes?: unknown[] };
  };

/** Where each element of the full message must show in the situation it publishes. */
const ELEMENT_CHECKS: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
  alert: {
    identifier: (_, c) => c["identifier"] === FULL.identifier,
    sender: (_, c) => c["sender"] === SENDER,
    sent: (_, c) => c["sent"] === SENT,
    status: (_, c) => c["status"] === "actual",
    msgType: (_, c) => c["msgType"] === "alert",
    source: (_, c) => c["source"] === "Forecaster 7",
    scope: (_, c) => c["scope"] === "public",
    code: (_, c) => same(c["codes"], ["profile:test:1.0"]),
    note: (_, c) => c["note"] === "Issued for the coverage check",
    references: (s, c) =>
      (c["references"] as { identifier: string }[] | undefined)?.[0]?.identifier === "earlier" &&
      (s["relations"] as unknown[] | undefined)?.length === 1,
    incidents: (_, c) => same(c["incidents"], ["INC-1"]),
    info: (s) => s["kind"] === "alert",
  },
  info: {
    language: (_, c) => first(c["event"])?.lang === "de-DE",
    category: (_, c) => same(c["category"], ["met"]),
    event: (_, c) => first(c["event"])?.text === "Wind",
    responseType: (_, c) => same(c["responseType"], ["prepare"]),
    urgency: (_, c) => c["urgency"] === "expected",
    severity: (s, c) =>
      c["severity"] === "moderate" && (s["severity"] as { label: string }).label === "moderate",
    certainty: (s, c) => c["certainty"] === "likely" && s["certainty"] === "likely",
    audience: (_, c) => first(c["audience"])?.text === "Everyone",
    eventCode: (_, c) => same(c["eventCodes"], [{ valueName: "SAME", value: "HWW" }]),
    effective: (s, c) =>
      c["effective"] === SENT && (s["validity"] as { start: string }).start === SENT,
    onset: (s, c) => c["onset"] === FULL.info[0]!.onset && s["temporality"] === "forecast",
    expires: (s, c) =>
      c["expires"] === EXPIRES && (s["validity"] as { end: string }).end === EXPIRES,
    senderName: (_, c) => first(c["senderName"])?.text === "Test office",
    headline: (s) => first(s["headline"])?.text === "Wind warning",
    description: (s) => first(s["description"])?.text === "Strong wind.",
    instruction: (s) => first(s["instruction"])?.text === "Stay inside.",
    web: (_, c) => c["web"] === "https://example.org/warning",
    contact: (_, c) => first(c["contact"])?.text === "Duty officer",
    parameter: (_, c) => same(c["parameters"], [{ valueName: "gusts", value: "90 km/h" }]),
    resource: (_, c) => (c["resources"] as unknown[] | undefined)?.length === 1,
    area: (s) => locationOf(s).geometry !== null,
  },
  resource: {
    resourceDesc: (_, c) =>
      (c["resources"] as { description?: string }[])[0]?.description === "Map",
    mimeType: (_, c) => (c["resources"] as { mimeType?: string }[])[0]?.mimeType === "image/png",
    size: (_, c) => (c["resources"] as { size?: number }[])[0]?.size === 1024,
    uri: (_, c) => (c["resources"] as { uri?: string }[])[0]?.uri === "https://example.org/map.png",
    digest: (_, c) =>
      (c["resources"] as { digest?: string }[])[0]?.digest === FULL.info[0]!.resource[0]!.digest,
  },
  area: {
    areaDesc: (s) => first(locationOf(s).areaDescription)?.text === "Test area",
    // The polygon and the circle are the two parts of one shape.
    polygon: (s) => locationOf(s).geometry.coordinates.length === 2,
    circle: (s) =>
      locationOf(s).geometry.type === "MultiPolygon" &&
      locationOf(s).geometry.coordinates.length === 2,
    geocode: (s) => same(locationOf(s).admin?.geocodes, [{ scheme: "nuts", code: "FR101" }]),
    altitude: (_, c) => c["altitudeFt"] === 100,
    ceiling: (_, c) => c["ceilingFt"] === 3000,
  },
};

/** The elements CAP declares that no situation carries, and why. */
const ELEMENTS_UNSUPPORTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  alert: {
    restriction:
      "for restricted messages only (CAP 1.2, 3.2.1), which are not republished; a public message has none to keep",
    addresses:
      "for restricted and private messages only (CAP 1.2, 3.2.1), which are not republished",
  },
  resource: {
    derefUri:
      "embedded content: the model keeps what a resource is and where it lives, not the file",
  },
};

describe("every element CAP 1.2 declares", () => {
  const PAYLOADS: Readonly<Record<string, () => FeedPayloads>> = {
    cap: () => ({ alerts: [Buffer.from(capJsonAsXml(schema(), FULL))] }),
    meteoalarm: () => ({ alerts: [json({ warnings: [{ alert: FULL, uuid: "full" }] })] }),
  };

  test("the full message is valid CAP", async ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(await valid(capJsonAsXml(schema(), FULL))).toEqual([]);
  });

  describe.each(FORMATS.filter((f) => Object.hasOwn(PAYLOADS, f.name)))("$name", (format) => {
    test.for(["alert", "info", "resource", "area"])(
      "every child of %s is read or listed with its reason",
      (parent, { skip }) => {
        if (unavailable) skip(unavailable);
        const feed = format.feed();
        drainSkipped(feed.id);
        const out = hazardsDomain.formats[format.name]!.parse(
          feed,
          PAYLOADS[format.name]!(),
          parseContext(FETCHED, 120),
        );
        expect(drainSkipped(feed.id)).toEqual({});
        expect(out.situations).toHaveLength(1);
        const s = out.situations[0]!;
        const checks = ELEMENT_CHECKS[parent] ?? {};
        assertCovered(parent, schema().children.get(parent) ?? [], {
          handled: (element) => Object.hasOwn(checks, element) && checks[element]!(s, capOf(s)),
          unsupported: ELEMENTS_UNSUPPORTED[parent] ?? {},
        });
      },
    );
  });
});

describe("the CAP gdacs areas follow CAP's status, scope and message type", () => {
  // GDACS's CAP feed only lends an event's current episode its polygons; the
  // event, its severity and its certainty are read from the RSS. GDACS
  // derives these CAP tokens from the RSS and says less with them: the
  // severity from the alert colour without its score (a green cyclone or
  // flood `Moderate`, a green earthquake `Minor`), the urgency `Past` for
  // every event, those in progress too, the certainty `Unknown` but for
  // earthquakes, and the category from the event type.
  const NOT_READ =
    "GDACS derives the CAP token from its RSS, which the gdacs format reads: the alert level and score, whether the event is current, and its type";

  const areasWith = (element: string, from: string, to: string) => {
    const doc = text("gdacs-cap.xml");
    const at = doc.indexOf(`<cap:${element}>${from}</cap:${element}>`);
    expect(doc.slice(0, at)).toContain("GDACS_TC_1001334_9");
    return Buffer.from(
      `${doc.slice(0, at)}<cap:${element}>${to}</cap:${element}>${doc.slice(at + `<cap:${element}>${from}</cap:${element}>`.length)}`,
    );
  };
  const shapeOf = (areas: Buffer) => {
    const feed = gdacsFeed();
    const out = hazardsDomain.formats["gdacs"]!.parse(
      feed,
      { events: [fixture("gdacs-rss.xml")], areas: [areas] },
      parseContext("2026-10-09T01:15:00Z", 600),
    );
    const s = out.situations.find((r) => r["id"] === `oc:situation:${feed.id}:TC1001334`)!;
    return (s["location"] as { geometry: { type: string } }).geometry.type;
  };

  test.for([
    ["status", "Actual", { Actual: "MultiPolygon" }],
    ["scope", "Public", { Public: "MultiPolygon" }],
    ["msgType", "Alert", { Alert: "MultiPolygon", Update: "MultiPolygon" }],
  ] as const)("%s", ([element, from, areaFrom], { skip }) => {
    if (unavailable) skip(unavailable);
    assertCovered(element, capValues(schema(), element), {
      handled: (v) =>
        shapeOf(areasWith(element, from, v)) ===
        ((areaFrom as Record<string, string>)[v] ?? "Point"),
    });
  });

  test.for(["category", "responseType", "urgency", "severity", "certainty"])(
    "%s is not read",
    (element, { skip }) => {
      if (unavailable) skip(unavailable);
      const values = capValues(schema(), element);
      assertCovered(element, values, {
        handled: [],
        unsupported: Object.fromEntries(values.map((v) => [v, NOT_READ])),
      });
    },
  );
});
