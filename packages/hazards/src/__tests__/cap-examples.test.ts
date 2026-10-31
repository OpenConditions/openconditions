import {
  pinnedBytes,
  pinnedFiles,
  pinnedOrUnavailable,
  type SchemaFile,
  xsdErrors,
} from "@openconditions/conformance";
import {
  CAP_SCHEMA,
  CAP_V1_2,
  CAP_V1_2_EXAMPLES,
} from "@openconditions/conformance/standards/cap-v1.2";
import {
  __resetSkips,
  drainSkipped,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { readCapXml } from "../cap/xml.js";
import { hazardsDomain } from "../domain.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { hazardFeed, meteoalarmFeed, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

/**
 * The four messages of OASIS CAP 1.2's Appendix A (pinned in
 * `CAP_V1_2_EXAMPLES`) through every format that reads CAP messages: the
 * `cap` format reads them as the XML they are, and the `meteoalarm` format
 * as the JSON envelope MeteoAlarm writes the same CAP in. What each must
 * yield is written from the standard: status, message type and scope, one
 * situation per hazard with every language of it, areas, shapes and codes,
 * urgency, severity and certainty, the references of an update, and
 * resources. The `nws` format reads api.weather.gov's GeoJSON, not CAP
 * messages, so none of these is its input.
 */

let unavailable: string | undefined;
let examples: Map<string, Buffer>;
let schemaFiles: SchemaFile[];

beforeAll(async () => {
  for (const set of [CAP_V1_2_EXAMPLES, CAP_V1_2]) {
    const pinned = await pinnedOrUnavailable(set);
    if ("unavailable" in pinned) {
      unavailable = pinned.unavailable;
      return;
    }
  }
  examples = new Map(
    [...(await pinnedBytes(CAP_V1_2_EXAMPLES))].map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  schemaFiles = await pinnedFiles(CAP_V1_2);
}, 120_000);

beforeEach(() => __resetSkips());

/** A CAP feed of the United States, as the examples are US messages. */
const usCapFeed = (): HazardsCatalogFeed =>
  hazardFeed("us", {
    operator: "example",
    product: "alerts",
    name: "CAP examples",
    tier: "authoritative",
    format: "cap",
    endpoints: { alerts: { url: "https://example.org/cap.xml", cadenceSec: 300 } },
    snapshot: { completeness: "complete" },
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "Example",
    privacyUrl: "https://example.org/privacy",
  });

/** Before A.2 expires (16:00 PDT on 17 June 2003), after every example is sent. */
const AT = "2003-06-17T22:00:00Z";

const example = (n: number) => {
  const body = examples.get(`example${n}.xml`);
  if (body === undefined) throw new Error(`no example${n}.xml`);
  return body;
};

const xml = (n: number) => readCapXml(example(n));

function parseCap(bodies: readonly Buffer[]): { out: ParseOutput; skipped: object } {
  const feed = usCapFeed();
  const out = hazardsDomain.formats["cap"]!.parse(feed, { alerts: [...bodies] }, parseContext(AT));
  return { out, skipped: drainSkipped(feed.id) };
}

function parseMeteoAlarm(bodies: readonly Buffer[]): { out: ParseOutput; skipped: object } {
  const feed = meteoalarmFeed();
  const envelope = {
    warnings: bodies.map((b, i) => ({ alert: readCapXml(b), uuid: `example-${i}` })),
  };
  const out = hazardsDomain.formats["meteoalarm"]!.parse(
    feed,
    { alerts: [Buffer.from(JSON.stringify(envelope))] },
    parseContext(AT),
  );
  return { out, skipped: drainSkipped(feed.id) };
}

/** A situation without what belongs to its feed rather than its message. */
function message(s: RecordDraft) {
  const {
    id,
    provenance: _provenance,
    freshness: _freshness,
    relations,
    location,
    ...rest
  } = s as Record<string, unknown> & { relations?: { ref: { id: string } }[] };
  const local = (ref: string) => ref.replace(/^oc:situation:[^:]+:/, "");
  const { admin: _admin, ...place } = location as Record<string, unknown>;
  return {
    id: local(String(id)),
    ...rest,
    location: place,
    ...(relations ? { relations: relations.map((r) => ({ ...r, ref: local(r.ref.id) })) } : {}),
  };
}

const en = (text: string) => [{ lang: "en-US", text }];

describe("OASIS CAP 1.2 Appendix A examples", () => {
  test("A.1 alone deviates from the schema, by its resource without a MIME type", async ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const errors = await Promise.all(
      [1, 2, 3, 4].map(async (n) =>
        (await xsdErrors(decodedText(n), schemaFiles, CAP_SCHEMA, `example${n}.xml`))
          .map((e) => e.replace(/^example\d\.xml:\d+: /, ""))
          .join("\n"),
      ),
    );
    expect(errors).toEqual([
      "Schemas validity error : Element '{urn:oasis:names:tc:emergency:cap:1.2}uri': This element is not expected. Expected is ( {urn:oasis:names:tc:emergency:cap:1.2}mimeType ).",
      "",
      "",
      "",
    ]);
  });

  test("A.4 declares UTF-8 but is written in ISO-8859-1, and its Spanish reads", ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(example(4))).toThrow();
    const spanish = xml(4).info![1]!;
    expect(spanish.language).toBe("es-US");
    expect(spanish.event).toBe("Abducción de Niño");
    expect(spanish.senderName).toBe("Departamento de Policía de Los Ángeles - LAPD");
    expect(spanish.area![0]!.areaDesc).toBe("condado de Los Ángeles");
  });

  test("the cap format publishes each as one situation, as the standard reads it", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const { out, skipped } = parseCap([1, 2, 3, 4].map(example));
    expect(sealFailures(out.situations)).toEqual([]);
    // A.1's resource names no MIME type, so the model cannot hold it.
    expect(skipped).toEqual({ unknown_value: 1 });
    expect(out.records).toMatchObject({ inputCount: 4, accepted: 4, terminal: 0 });
    const [hsas, storm, quake, amber] = out.situations.map(message);
    for (const s of out.situations) {
      expect((s["location"] as { admin: unknown }).admin).toMatchObject({ country: "US" });
    }

    expect(hsas).toEqual({
      id: "43b080713727",
      class: "situation",
      kind: "alert",
      type: "other",
      temporality: "live",
      externalIds: [{ scheme: "cap", id: "43b080713727", authority: "hsas@dhs.gov" }],
      location: {
        geometry: null,
        extent: "area",
        geometryOrigin: "none",
        fuzziness: "exact",
        areaDescription: en("U.S. nationwide and interests worldwide"),
      },
      planned: false,
      certainty: "likely",
      severity: { label: "major", source: "declared", declaredRaw: "Severe" },
      headline: en("Homeland Security Sets Code ORANGE"),
      description: en(
        "The Department of Homeland Security has elevated the Homeland Security Advisory System threat level to ORANGE / High in response to intelligence which may indicate a heightened threat of terrorism.",
      ),
      instruction: en(
        "A High Condition is declared when there is a high risk of terrorist attacks. In addition to the Protective Measures taken in the previous Threat Conditions, Federal departments and agencies should consider agency-specific Protective Measures in accordance with their existing plans.",
      ),
      // No expiry: in force until a later message ends it.
      validity: { status: "active", start: "2003-04-02T14:39:01-05:00" },
      effects: [],
      groupId: "43b080713727",
      details: {
        kind: "alert",
        v: 1,
        cap: {
          identifier: "43b080713727",
          sender: "hsas@dhs.gov",
          sent: "2003-04-02T14:39:01-05:00",
          status: "actual",
          msgType: "alert",
          scope: "public",
          category: ["security"],
          event: en("Homeland Security Advisory System Update"),
          urgency: "immediate",
          severity: "severe",
          certainty: "likely",
          parameters: [{ valueName: "HSAS", value: "ORANGE" }],
          web: "http://www.dhs.gov/dhspublic/display?theme=29",
          senderName: en("U.S. Government, Department of Homeland Security"),
        },
      },
    });

    expect(storm).toEqual({
      id: "KSTO1055887203",
      class: "situation",
      kind: "alert",
      type: "thunderstorm",
      subtype: "severe",
      temporality: "live",
      externalIds: [{ scheme: "cap", id: "KSTO1055887203", authority: "KSTO@NWS.NOAA.GOV" }],
      // CAP writes a point latitude first; GeoJSON longitude first.
      location: {
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-120.14, 38.47],
              [-119.95, 38.34],
              [-119.74, 38.52],
              [-119.89, 38.62],
              [-120.14, 38.47],
            ],
          ],
        },
        extent: "area",
        geometryOrigin: "source",
        fuzziness: "exact",
        areaDescription: en(
          "EXTREME NORTH CENTRAL TUOLUMNE COUNTY IN CALIFORNIA, EXTREME NORTHEASTERN CALAVERAS COUNTY IN CALIFORNIA, SOUTHWESTERN ALPINE COUNTY IN CALIFORNIA",
        ),
      },
      planned: false,
      certainty: "observed",
      severity: { label: "major", source: "declared", declaredRaw: "Severe" },
      headline: en("SEVERE THUNDERSTORM WARNING"),
      description: en(
        "AT 254 PM PDT...NATIONAL WEATHER SERVICE DOPPLER RADAR INDICATED A SEVERE THUNDERSTORM OVER SOUTH CENTRAL ALPINE COUNTY...OR ABOUT 18 MILES SOUTHEAST OF KIRKWOOD...MOVING SOUTHWEST AT 5 MPH. HAIL...INTENSE RAIN AND STRONG DAMAGING WINDS ARE LIKELY WITH THIS STORM.",
      ),
      instruction: en("TAKE COVER IN A SUBSTANTIAL SHELTER UNTIL THE STORM PASSES."),
      // Without `effective`, the warning is in force from when it is sent.
      validity: {
        status: "active",
        start: "2003-06-17T14:57:00-07:00",
        end: "2003-06-17T16:00:00-07:00",
      },
      effects: [],
      groupId: "KSTO1055887203",
      details: {
        kind: "alert",
        v: 1,
        cap: {
          identifier: "KSTO1055887203",
          sender: "KSTO@NWS.NOAA.GOV",
          sent: "2003-06-17T14:57:00-07:00",
          status: "actual",
          msgType: "alert",
          scope: "public",
          category: ["met"],
          event: en("SEVERE THUNDERSTORM"),
          eventCodes: [{ valueName: "SAME", value: "SVR" }],
          responseType: ["shelter"],
          urgency: "immediate",
          severity: "severe",
          certainty: "observed",
          expires: "2003-06-17T16:00:00-07:00",
          senderName: en("NATIONAL WEATHER SERVICE SACRAMENTO CA"),
          contact: en("BARUFFALDI/JUSKIE"),
        },
      },
    });
    expect((out.situations[1]!["location"] as { admin: unknown }).admin).toEqual({
      country: "US",
      geocodes: [
        { scheme: "same", code: "006109" },
        { scheme: "same", code: "006009" },
        { scheme: "same", code: "006003" },
      ],
    });
    expect(out.situations[1]!["freshness"]).toMatchObject({
      expiresAt: "2003-06-17T16:00:00-07:00",
    });

    expect(quake).toEqual({
      id: "TRI13970876.2",
      class: "situation",
      kind: "alert",
      type: "other",
      temporality: "live",
      externalIds: [{ scheme: "cap", id: "TRI13970876.2", authority: "trinet@caltech.edu" }],
      // A circle of radius 0 is its centre, the position the alert states.
      location: {
        geometry: { type: "Point", coordinates: [-115.5527, 32.9525] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
        areaDescription: en(
          "1 mi. WSW of Brawley, CA; 11 mi. N of El Centro, CA; 30 mi. E of OCOTILLO (quarry); 1 mi. N of the Imperial Fault",
        ),
      },
      // An Update relates to the message it references, whose warning it continues.
      relations: [{ relation: "update_of", ref: "TRI13970876.1" }],
      planned: false,
      certainty: "observed",
      severity: { label: "minor", source: "declared", declaredRaw: "Minor" },
      headline: en("EQ 3.4 Imperial County CA"),
      description: en(
        "A minor earthquake measuring 3.4 on the Richter scale occurred near Brawley, California at 8:53 PM Pacific Daylight Time on Wednesday, June 11, 2003. (This event has now been reviewed by a seismologist)",
      ),
      validity: { status: "active", start: "2003-06-11T20:56:00-07:00" },
      effects: [],
      groupId: "TRI13970876.1",
      details: {
        kind: "alert",
        v: 1,
        cap: {
          identifier: "TRI13970876.2",
          sender: "trinet@caltech.edu",
          sent: "2003-06-11T20:56:00-07:00",
          status: "actual",
          msgType: "update",
          scope: "public",
          references: [
            {
              sender: "trinet@caltech.edu",
              identifier: "TRI13970876.1",
              sent: "2003-06-11T20:30:00-07:00",
            },
          ],
          category: ["geo"],
          event: en("Earthquake"),
          urgency: "past",
          severity: "minor",
          certainty: "observed",
          parameters: [
            { valueName: "EventID", value: "13970876" },
            { valueName: "Version", value: "1" },
            { valueName: "Magnitude", value: "3.4 Ml" },
            { valueName: "Depth", value: "11.8 mi." },
            { valueName: "Quality", value: "Excellent" },
          ],
          web: "http://www.trinet.org/scsn/scsn.html",
          senderName: en(
            "Southern California Seismic Network (TriNet) operated by Caltech and USGS",
          ),
        },
      },
    });

    // Both info blocks warn of one hazard in two languages: one situation.
    const both = (english: string, spanish: string) => [
      { lang: "en-US", text: english },
      { lang: "es-US", text: spanish },
    ];
    const contact = "DET. SMITH, 77TH DIV, LOS ANGELES POLICE DEPT-LAPD AT 213 485-2389";
    expect(amber).toMatchObject({
      id: "KAR0-0306112239-SW",
      kind: "alert",
      type: "missing_person",
      subtype: "child_abduction",
      temporality: "live",
      location: {
        geometry: null,
        extent: "area",
        geometryOrigin: "none",
        areaDescription: both("Los Angeles County", "condado de Los Ángeles"),
      },
      certainty: "likely",
      severity: { label: "major", source: "declared", declaredRaw: "Severe" },
      headline: both(
        "Amber Alert in Los Angeles County",
        "Alerta Amber en el condado de Los Ángeles",
      ),
      validity: { status: "active", start: "2003-06-11T22:39:00-07:00" },
      groupId: "KAR0-0306112239-SW",
      details: {
        cap: {
          status: "actual",
          msgType: "alert",
          scope: "public",
          source: "SW",
          category: ["rescue"],
          event: both("Child Abduction", "Abducción de Niño"),
          eventCodes: [{ valueName: "SAME", value: "CAE" }],
          urgency: "immediate",
          severity: "severe",
          certainty: "likely",
          senderName: both(
            "Los Angeles Police Dept - LAPD",
            "Departamento de Policía de Los Ángeles - LAPD",
          ),
          contact: both(contact, contact),
        },
      },
    });
    const description = out.situations[3]!["description"] as { lang: string; text: string }[];
    expect(description.map((d) => d.lang)).toEqual(["en-US", "es-US"]);
    expect(description[1]!.text).toContain("VÍCTIMAS: KHAYRI DOE JR.");
    expect(description[1]!.text).toContain("LOCALIZACIÓN: 5721 DOE ST., LOS ÁNGELES.");
    expect(JSON.stringify(out.situations)).not.toContain("�");
    expect((out.situations[3]!["location"] as { admin: unknown }).admin).toEqual({
      country: "US",
      geocodes: [{ scheme: "same", code: "006037" }],
    });
  });

  test("the meteoalarm format reads the same CAP, written as its JSON, the same way", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const bodies = [1, 2, 3, 4].map(example);
    const cap = parseCap(bodies);
    const meteoalarm = parseMeteoAlarm(bodies);
    expect(sealFailures(meteoalarm.out.situations)).toEqual([]);
    expect(meteoalarm.skipped).toEqual(cap.skipped);
    expect(meteoalarm.out.records).toMatchObject({ inputCount: 4, accepted: 4, terminal: 0 });
    expect(meteoalarm.out.situations.map(message)).toEqual(cap.out.situations.map(message));
  });

  /** An example's XML with its tokens replaced, as another message of the same shape. */
  const variant = (n: number, replace: [string, string][]) =>
    Buffer.from(replace.reduce((text, [from, to]) => text.replace(from, to), decodedText(n)));

  test.for([
    ["Exercise", "status"],
    ["System", "status"],
    ["Test", "status"],
    ["Draft", "status"],
    ["Restricted", "scope"],
    ["Private", "scope"],
    ["Ack", "msgType"],
    ["Error", "msgType"],
  ] as const)(
    "A.2 as %s (%s) is not published, and ends here by design",
    ([token, field], { skip }) => {
      if (unavailable) skip(unavailable);
      const original = field === "status" ? "Actual" : field === "scope" ? "Public" : "Alert";
      const body = variant(2, [
        [`<${field}>${original}</${field}>`, `<${field}>${token}</${field}>`],
      ]);
      for (const parse of [parseCap, parseMeteoAlarm]) {
        const { out, skipped } = parse([body]);
        expect(out.situations).toEqual([]);
        expect(out.records).toMatchObject({ inputCount: 1, accepted: 0, terminal: 1 });
        expect(skipped).toEqual({});
      }
    },
  );

  test("A.3 supersedes the message it updates when both are in one parse", ({ skip }) => {
    if (unavailable) skip(unavailable);
    // The earthquake's first report, as A.3 names it in its references.
    const original = variant(3, [
      ["<identifier>TRI13970876.2</identifier>", "<identifier>TRI13970876.1</identifier>"],
      ["<sent>2003-06-11T20:56:00-07:00</sent>", "<sent>2003-06-11T20:30:00-07:00</sent>"],
      ["<msgType>Update</msgType>", "<msgType>Alert</msgType>"],
      ["<references>trinet@caltech.edu,TRI13970876.1,2003-06-11T20:30:00-07:00</references>", ""],
    ]);
    for (const parse of [parseCap, parseMeteoAlarm]) {
      const { out } = parse([original, example(3)]);
      expect(out.situations.map((s) => message(s).id)).toEqual(["TRI13970876.2"]);
      expect(out.records).toMatchObject({ inputCount: 2, accepted: 1, terminal: 1 });
    }
  });

  test("a Cancel of A.2 supersedes it and is published as cancelled", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const cancel = variant(2, [
      ["<identifier>KSTO1055887203</identifier>", "<identifier>KSTO1055888000</identifier>"],
      ["<sent>2003-06-17T14:57:00-07:00</sent>", "<sent>2003-06-17T15:10:00-07:00</sent>"],
      [
        "<msgType>Alert</msgType>",
        "<msgType>Cancel</msgType>\n  <references>KSTO@NWS.NOAA.GOV,KSTO1055887203,2003-06-17T14:57:00-07:00</references>",
      ],
    ]);
    for (const parse of [parseCap, parseMeteoAlarm]) {
      const { out } = parse([example(2), cancel]);
      expect(out.situations.map(message)).toMatchObject([
        {
          id: "KSTO1055888000",
          relations: [{ relation: "cancels", ref: "KSTO1055887203" }],
          validity: { status: "cancelled", endedReason: "cancelled" },
          groupId: "KSTO1055887203",
        },
      ]);
      expect(out.records).toMatchObject({ inputCount: 2, accepted: 1, terminal: 1 });
    }
  });
});

/** An example's text, decoded as the CAP reader decodes it. */
function decodedText(n: number): string {
  const body = example(n);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}
