import { historyRowOf, recordFromHistory, templateOf } from "@openconditions/core";
import { sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { describe, expect, it } from "vitest";
import { observationDraft } from "./drafts.js";

const registry = productionRegistry();
const RECORDED = "2026-10-01T10:00:05.000Z";
const PAYLOADS = ["a".repeat(64), "b".repeat(64)];

function seal(draft: Record<string, unknown>) {
  const sealed = sealRecord(registry, draft, {
    instanceId: "test.local",
    revision: 1,
    recordedAt: RECORDED,
  });
  if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
  return sealed.value;
}

/** A history row as Postgres hands it back: timestamps as Dates. */
function fromDatabase(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...row };
  for (const key of [
    "phenomenon_start",
    "phenomenon_end",
    "result_time",
    "valid_until",
    "fetched_at",
    "recorded_at",
  ]) {
    if (typeof out[key] === "string") out[key] = new Date(out[key] as string);
  }
  return out;
}

function roundTrip(draft: Record<string, unknown>) {
  const record = seal(draft);
  const spec = registry.property(record["property"] as string)!.result;
  const row = historyRowOf(record, spec, { fetchId: 7, payloadHashes: PAYLOADS });
  const back = recordFromHistory(registry, templateOf(record), fromDatabase(row), PAYLOADS);
  return { record, row, back };
}

const SITE_CHANNEL = {
  kind: "feature",
  featureId: "oc:feature:nl-ndw-flow:s1",
  componentKey: "lane1",
};
const PRODUCT = { kind: "feature", featureId: "oc:feature:es-minetur:42", componentKey: "e5" };

describe("observation history rows", () => {
  it("read back a quantity reading, its payload reference and its publisher time", () => {
    const { record, row, back } = roundTrip(
      observationDraft(
        "traffic.speed",
        { type: "quantity", value: 87.5, unit: "km/h" },
        {
          aggregation: "mean",
          provenance: {
            ...(observationDraft("traffic.speed", {})["provenance"] as object),
            rawRef: { hash: PAYLOADS[1] },
            sourceUpdatedAt: "2026-10-01T09:59:00Z",
          },
        },
      ),
    );
    expect(row).toMatchObject({ value_num: 87.5, value_json: null, fetch_id: 7, raw_part: 1 });
    expect(row["extra"]).toEqual({ provenance: { sourceUpdatedAt: "2026-10-01T09:59:00Z" } });
    expect(back).toEqual(record);
  });

  it("read back a category, a boolean and a money reading", () => {
    for (const draft of [
      observationDraft(
        "traffic.los",
        { type: "category", value: "queuing", vocabulary: "los" },
        { subject: SITE_CHANNEL },
      ),
      observationDraft(
        "fuel.product_available",
        { type: "boolean", value: false },
        { subject: PRODUCT, sourceId: "es-minetur" },
      ),
      observationDraft(
        "fuel.price",
        { type: "money", amount: "1.4590", currency: "EUR", per: "L" },
        { subject: PRODUCT, sourceId: "es-minetur" },
      ),
    ]) {
      const { record, back } = roundTrip(draft);
      expect(back).toEqual(record);
    }
  });

  it("keep what the registry does not imply, and a result of another type whole", () => {
    const accurate = roundTrip(
      observationDraft("traffic.speed", { type: "quantity", value: 80, unit: "km/h", accuracy: 2 }),
    );
    expect(accurate.row["value_json"]).toEqual({ accuracy: 2 });
    expect(accurate.back).toEqual(accurate.record);

    const unknown = roundTrip(observationDraft("traffic.speed", { type: "unknown" }));
    expect(unknown.row).toMatchObject({ value_num: null, value_json: { type: "unknown" } });
    expect(unknown.back).toEqual(unknown.record);
  });

  it("read back a forecast for an area, with its interval and issue time", () => {
    const { record, row, back } = roundTrip(
      observationDraft(
        "road.condition_forecast",
        { type: "category", value: "ice", vocabulary: "surface_state" },
        {
          subject: { kind: "location" },
          temporality: "forecast",
          phenomenonTime: { start: "2026-10-02T03:00:00.000Z", end: "2026-10-02T06:00:00.000Z" },
          forecast: {
            issuedAt: "2026-10-01T12:00:00.000Z",
            leadTime: { value: 54000, unit: "s" },
          },
          location: {
            geometry: null,
            extent: "area",
            geometryOrigin: "none",
            fuzziness: "exact",
            admin: { country: "FI", geocodes: [{ scheme: "nuts", code: "FI1B" }] },
          },
        },
      ),
    );
    expect(row).toMatchObject({
      phenomenon_end: "2026-10-02T06:00:00.000Z",
      issued_at: "2026-10-01T12:00:00.000Z",
    });
    expect(back).toEqual(record);
  });

  it("keep a payload reference this poll did not deliver, in full", () => {
    const { record, row, back } = roundTrip(
      observationDraft(
        "traffic.speed",
        { type: "quantity", value: 50, unit: "km/h" },
        {
          provenance: {
            ...(observationDraft("traffic.speed", {})["provenance"] as object),
            rawRef: { hash: "c".repeat(64), pointer: "/sites/3" },
          },
        },
      ),
    );
    expect(row).toMatchObject({ fetch_id: null, raw_part: null });
    expect(back).toEqual(record);
  });

  it("keep each crowd reading's reporter and record id with the reading, not the series", () => {
    const crowdReading = (keyId: string, recordId: string, at: string) =>
      observationDraft(
        "charging.evse_status",
        { type: "category", value: "out_of_order", vocabulary: "evse_status" },
        {
          at,
          sourceId: "crowd",
          subject: { kind: "feature", featureId: "oc:feature:test.local:abc", componentKey: "1" },
          provenance: {
            origin: "crowd",
            sourceId: "crowd",
            sourceFormat: "crowd",
            accessMode: "bulk",
            recordId,
            attribution: { provider: "OpenConditions contributors", license: "ODbL-1.0" },
            reporter: { keyId },
            privacy: { class: "crowd_pseudonym" },
          },
        },
      );
    const first = seal(crowdReading("key-one", "a".repeat(64), "2026-10-01T09:00:00.000Z"));
    const second = seal(crowdReading("key-two", "b".repeat(64), "2026-10-01T09:30:00.000Z"));
    const template = templateOf(second);
    expect(template["provenance"]).not.toHaveProperty("reporter");
    expect(template["provenance"]).not.toHaveProperty("recordId");
    const spec = registry.property("charging.evse_status")!.result;
    const row = historyRowOf(first, spec, {});
    expect(row["extra"]).toEqual({
      provenance: { recordId: "a".repeat(64), reporter: { keyId: "key-one" } },
    });
    expect(recordFromHistory(registry, template, fromDatabase(row))).toEqual(first);
  });
});
