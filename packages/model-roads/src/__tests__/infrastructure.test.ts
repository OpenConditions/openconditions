import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { roadsModule } from "../module.js";

const registry = buildRegistry([kernelModule, roadsModule]);

const base = (cls: "feature" | "observation", localId: string) => ({
  id: `oc:${cls}:nl-ndw-vms:${localId}`,
  temporality: cls === "feature" ? "static" : "live",
  location: {
    geometry: { type: "Point", coordinates: [5.89, 51.97] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  },
  provenance: {
    origin: "feed",
    sourceId: "nl-ndw-vms",
    sourceFormat: "datex2",
    accessMode: "bulk",
    recordId: localId,
    attribution: { provider: "NDW", license: "CC0-1.0" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: "2026-09-19T16:05:00Z" },
});

const sign = {
  ...base("feature", "VMS-1"),
  class: "feature",
  kind: "vms",
  type: "matrix",
  lifecycle: "operational",
  components: [{ key: "1", kind: "sign_face", details: { kind: "sign_face", v: 1, vmsIndex: 1 } }],
  details: { kind: "vms", v: 1, mounting: "roadside" },
};

function reading(property: string, result: unknown, componentKey?: string) {
  const draft = {
    ...base("observation", "x"),
    class: "observation",
    kind: "observation",
    property,
    subject: {
      kind: "feature",
      featureId: sign.id,
      ...(componentKey === undefined ? {} : { componentKey }),
    },
    result,
    phenomenonTime: { instant: "2026-09-19T15:57:16Z" },
    aggregation: "instantaneous",
  };
  return { ...draft, id: observationId("nl-ndw-vms", draft as never) };
}

describe("roads infrastructure", () => {
  it("registers signs, cameras and measurement sites as field devices", () => {
    for (const code of ["vms", "camera", "measurement_site"]) {
      expect(registry.kind("feature", code)?.traits).toContain("field_device");
    }
    expect(registry.kind("feature", "measurement_site")?.components).toEqual(["sensor_channel"]);
  });

  it("validates a sign with its faces and what a face shows", () => {
    expect(registry.validateDraft(sign)).toMatchObject({ ok: true });
    const display = reading(
      "vms.display",
      {
        type: "structured",
        schema: "vms_display",
        v: 1,
        value: {
          v: 1,
          workingStatus: "in_service",
          messages: [
            { index: 0, text: [{ page: 1, lines: [[{ lang: "nl", text: "Rij MONO" }]] }] },
            { index: 1, graphic: { mediaType: "image/png" } },
          ],
        },
      },
      "1",
    );
    expect(registry.validateDraft(display)).toMatchObject({ ok: true });
  });

  it("closes the device status to its vocabulary", () => {
    const ok = reading("device.status", {
      type: "category",
      value: "ok",
      vocabulary: "device_status",
    });
    expect(registry.validateDraft(ok)).toMatchObject({ ok: true });
    const bad = reading("device.status", {
      type: "category",
      value: "broken",
      vocabulary: "device_status",
    });
    expect(registry.validateDraft(bad)).toMatchObject({ ok: false });
  });

  it("requires a camera to say what its image licence allows", () => {
    const camera = {
      ...base("feature", "CAM-1"),
      class: "feature",
      kind: "camera",
      type: "traffic",
      lifecycle: "operational",
      details: { kind: "camera", v: 1 },
    };
    expect(registry.validateDraft(camera)).toMatchObject({ ok: false });
    expect(
      registry.validateDraft({
        ...camera,
        details: { kind: "camera", v: 1, imageRedistribution: "link_only" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("keeps sign displays as changes and camera images latest-only", () => {
    expect(registry.property("vms.display")?.retention).toEqual({ changeOnly: true, rawDays: 30 });
    expect(registry.property("camera.image")?.retention).toEqual({ latestOnly: true });
  });
});

describe("traffic retention", () => {
  const retention = (code: string) => registry.property(code)?.retention;

  it("keeps lane and vehicle-class readings latest-only and site series within the budget", () => {
    expect(retention("traffic.speed")).toEqual({
      rawDays: 2,
      componentHistory: false,
      rollup: { period: "hourly", histogram: { binWidth: 2 } },
    });
    expect(retention("traffic.volume")).toEqual({
      rawDays: 1,
      componentHistory: false,
      rollup: { period: "hourly" },
    });
    expect(retention("traffic.occupancy")).toEqual({
      rawDays: 2,
      componentHistory: false,
      rollup: { period: "hourly" },
    });
    expect(retention("traffic.vehicle_class_speed")).toEqual({
      rawDays: 2,
      componentHistory: false,
    });
    expect(retention("traffic.los")).toEqual({
      changeOnly: true,
      rawDays: 7,
      componentHistory: false,
    });
  });
});
