import { buildRegistry, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  CAP_CATEGORIES,
  CAP_CERTAINTIES,
  CAP_MSG_TYPES,
  CAP_RESPONSE_TYPES,
  CAP_SCOPES,
  CAP_SEVERITIES,
  CAP_SEVERITY_LABELS,
  CAP_STATUSES,
  CAP_URGENCIES,
} from "../crosswalk/cap.js";
import { hazardsCrosswalk, hazardsModule } from "../module.js";
import { CAP_1_2 } from "../vocabularies/cap.js";

const registry = buildRegistry([kernelModule, hazardsModule]);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

const alert = {
  id: "oc:situation:de-dwd:2.49.0.0.276.0.DWD.PVW.1790658060000.7cb973e0",
  class: "situation",
  kind: "alert",
  type: "thunderstorm",
  temporality: "live",
  location: {
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [6.85, 53.58],
          [6.88, 53.58],
          [6.88, 53.6],
          [6.85, 53.58],
        ],
      ],
    },
    extent: "area",
    geometryOrigin: "source",
    fuzziness: "exact",
    admin: { country: "DE", geocodes: [{ scheme: "warncellid", code: "903457002" }] },
  },
  provenance: {
    origin: "feed",
    sourceId: "de-dwd",
    sourceFormat: "derived",
    accessMode: "bulk",
    recordId: "2.49.0.0.276.0.DWD.PVW.1790658060000.7cb973e0",
    attribution: { provider: "Deutscher Wetterdienst", license: "CC-BY-4.0" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: "2026-09-29T06:05:00Z" },
  planned: false,
  certainty: "likely",
  severity: { label: "moderate", source: "declared", declaredRaw: "Moderate" },
  headline: [{ lang: "de-DE", text: "Amtliche WARNUNG vor STARKEM GEWITTER" }],
  validity: {
    status: "active",
    start: "2026-09-29T07:01:00+02:00",
    end: "2026-09-29T07:45:00+02:00",
  },
  effects: [],
  details: {
    kind: "alert",
    v: 1,
    cap: {
      identifier: "2.49.0.0.276.0.DWD.PVW.1790658060000.7cb973e0",
      sender: "opendata@dwd.de",
      sent: "2026-09-29T07:01:00+02:00",
      status: "actual",
      msgType: "alert",
      scope: "public",
      category: ["met"],
      event: [{ lang: "de-DE", text: "STARKES GEWITTER" }],
      eventCodes: [{ valueName: "II", value: "36" }],
      responseType: ["prepare"],
      urgency: "immediate",
      severity: "moderate",
      certainty: "likely",
      onset: "2026-09-29T07:01:00+02:00",
      parameters: [{ valueName: "gusts", value: "~65 [km/h]" }],
      web: "https://dwd.de/warnungen",
    },
  },
};

const withCap = (cap: object) => ({
  ...alert,
  details: { ...alert.details, cap: { ...alert.details.cap, ...cap } },
});

describe("alerts", () => {
  it("registers an alert with its CAP message, located by a DWD warn cell", () => {
    expect(registry.validateDraft(alert).ok).toBe(true);
  });

  it("keeps an update's references as sender, identifier and time", () => {
    const update = withCap({
      msgType: "update",
      references: [
        {
          sender: "opendata@dwd.de",
          identifier: "2.49.0.0.276.0.DWD.PVW.1790657940000.0eac7b84",
          sent: "2026-09-29T06:59:00+02:00",
        },
      ],
    });
    expect(registry.validateDraft(update).ok).toBe(true);
  });

  it("keeps CAP's own severity verbatim and refuses a token CAP does not define", () => {
    expect(registry.validateDraft(withCap({ severity: "Moderate" })).ok).toBe(false);
    expect(registry.validateDraft(withCap({ category: [] })).ok).toBe(false);
  });

  it("classifies alerts by the hazard they warn of, with other for none", () => {
    expect(registry.validateDraft({ ...alert, type: "other" }).ok).toBe(true);
    expect(registry.validateDraft({ ...alert, type: "cap" }).ok).toBe(false);
    expect(registry.kind("situation", "alert")?.types?.["thunderstorm"]).toContain("tornado");
  });
});

describe("CAP crosswalks", () => {
  it("maps every token of every CAP 1.2 enumeration", () => {
    expect(sorted(Object.keys(CAP_STATUSES))).toEqual(sorted(CAP_1_2.status));
    expect(sorted(Object.keys(CAP_MSG_TYPES))).toEqual(sorted(CAP_1_2.msgType));
    expect(sorted(Object.keys(CAP_SCOPES))).toEqual(sorted(CAP_1_2.scope));
    expect(sorted(Object.keys(CAP_CATEGORIES))).toEqual(sorted(CAP_1_2.category));
    expect(sorted(Object.keys(CAP_RESPONSE_TYPES))).toEqual(sorted(CAP_1_2.responseType));
    expect(sorted(Object.keys(CAP_URGENCIES))).toEqual(sorted(CAP_1_2.urgency));
    expect(sorted(Object.keys(CAP_SEVERITIES))).toEqual(sorted(CAP_1_2.severity));
    expect(sorted(Object.keys(CAP_SEVERITY_LABELS))).toEqual(sorted(CAP_1_2.severity));
    expect(sorted(Object.keys(CAP_CERTAINTIES))).toEqual(sorted(CAP_1_2.certainty));
  });

  it("maps CAP severity onto the label and reads CAP 1.0's Very Likely as likely", () => {
    expect(hazardsCrosswalk.value("severity", "cap", "Extreme")).toBe("critical");
    expect(hazardsCrosswalk.value("severity", "cap", "Severe")).toBe("major");
    expect(hazardsCrosswalk.value("certainty", "cap", "Very Likely")).toBe("likely");
    expect(hazardsCrosswalk.value("cap_certainty", "cap", "Very Likely")).toBe("likely");
    expect(hazardsCrosswalk.value("cap_severity", "cap", "Extreme")).toBe("extreme");
    expect(hazardsCrosswalk.value("cap_response_type", "cap", "AllClear")).toBe("all_clear");
    expect(hazardsCrosswalk.value("cap_category", "cap", "CBRNE")).toBe("cbrne");
  });
});
