import { readFileSync } from "node:fs";
import {
  buildRegistry,
  canonicalClusters,
  canonicalComponents,
  crowdRulesFor,
  extendVocabulary,
  type FusableObservation,
  type FusionCandidate,
  fuse,
  fusedObservation,
  type LandingContext,
  type LinkableFeature,
  landClaim,
  observationConfirms,
  observationId,
  proposeLink,
  type RegistryModule,
  sealRecord,
  situationsAgree,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { productionModules } from "../index.js";

/**
 * Crowd fit check: reports a driver can make, landed on the production
 * registry and judged against real published records. The road closure is
 * Autobahn GmbH's (DL-DE-BY-2.0), captured 2026-10-01 from the A5 closure
 * service; the charging sites come from the MobiData BW charge-point database
 * (CC BY 4.0), captured 2026-09-22 for central Karlsruhe and 2026-10-01 for
 * one car park that two of its sources describe — a live feed relayed from
 * chargecloud (CC0) and the Bundesnetzagentur register (CC BY 4.0); the fuel
 * prices are MINETUR's (CC BY 4.0), captured 2026-09-22. The fuel module
 * registers the MINETUR format; the others OpenConditions does not parse
 * yet, so they are registered by a test-only module.
 */
const fitFormats: RegistryModule = {
  name: "crowd-fit",
  entries: [
    extendVocabulary({
      vocabulary: "source_format",
      values: ["ocpi", "autobahn-closure"],
    }),
  ],
};
const registry = buildRegistry([...productionModules, fitFormats]);
const INSTANCE = "oc.example.org";
const KEY = "GlQczzclqGJy6D0X9dNq8pSYKRfkCqszpEp5g3ZGlwY";
const OTHER_KEY = "8nR0Y3oQ2kX7cS1wV5bT9uZ4aE6dF0gH2jK4lM6nP8q";

const json = (dir: string, name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${name}`, import.meta.url), "utf8"));

const point = (lon: number, lat: number) => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
});

const feed = (
  sourceId: string,
  sourceFormat: string,
  recordId: string,
  provider: string,
  license: string,
) => ({
  origin: "feed",
  sourceId,
  sourceFormat,
  accessMode: "bulk",
  recordId,
  attribution: { provider, license },
  privacy: { class: "authoritative" },
});

const seal = (draft: Record<string, unknown>, recordedAt = "2026-10-01T12:00:00Z") =>
  sealRecord(registry, draft, { instanceId: INSTANCE, revision: 1, recordedAt });

function sealed(draft: Record<string, unknown>) {
  const result = seal(draft);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 1));
  return result.value;
}

function ctx(now: string, resolveFeature?: LandingContext["resolveFeature"]): LandingContext {
  return {
    instanceId: INSTANCE,
    now,
    attribution: { provider: INSTANCE, license: "CC0-1.0" },
    ...(resolveFeature === undefined ? {} : { resolveFeature }),
  };
}

let nonce = 0;
const nextNonce = () => `fit-nonce-${String(++nonce).padStart(10, "0")}`;

describe("what drivers report", () => {
  const NOW = "2026-10-01T12:00:00Z";
  const here = { type: "Point", coordinates: [8.5596, 49.1463] };
  const closure = (scope: string) => ({
    id: "closure:1",
    kind: "closure",
    v: 1,
    scope,
    applicability: { kind: "all" },
    compliance: "mandatory",
    normalization: "complete",
  });
  /**
   * The categories of the OpenMapX report dialog, as claims of the model.
   * Transit disruptions wait for the transit domain; micromobility and
   * accessibility reports have no road classification and stay `other`, as
   * they do today.
   */
  const CATEGORIES: Record<string, Record<string, unknown>> = {
    road_closure: { kind: "closure", type: "closure", subtype: "full", effects: [closure("road")] },
    lane_closure: {
      kind: "closure",
      type: "closure",
      subtype: "lane",
      effects: [
        {
          id: "lane_restriction:1",
          kind: "lane_restriction",
          v: 1,
          lanesClosed: 1,
          vehicleImpact: "some_lanes_closed",
          applicability: { kind: "all" },
          compliance: "mandatory",
          normalization: "partial",
        },
      ],
    },
    accident: { kind: "incident", type: "accident" },
    stopped_vehicle: { kind: "incident", type: "breakdown", subtype: "disabled_vehicle" },
    hazard_object: { kind: "incident", type: "obstruction", subtype: "object" },
    hazard_weather: { kind: "weather_condition", type: "weather" },
    hazard_animal: { kind: "incident", type: "obstruction", subtype: "animal" },
    jam: {
      kind: "congestion",
      type: "congestion",
      subtype: "queuing",
      details: { kind: "congestion", v: 1, los: "queuing" },
    },
    roadworks: { kind: "roadworks", type: "works" },
    micromobility: { kind: "other", type: "other" },
    accessibility: { kind: "other", type: "other" },
    other: { kind: "other", type: "other" },
  };

  it("lands every road category of the report dialog and seals it", () => {
    for (const [category, classification] of Object.entries(CATEGORIES)) {
      const landed = landClaim(
        registry,
        {
          claim: {
            claimClass: "situation",
            ...classification,
            geometry: here,
            fuzziness: "exact",
            severityLevel: 3,
            reportedAt: "2026-10-01T11:59:00Z",
            nonce: nextNonce(),
          },
          keyId: KEY,
        },
        ctx(NOW),
      );
      expect(landed.ok, category).toBe(true);
      if (landed.ok) expect(seal(landed.draft).ok, category).toBe(true);
    }
  });

  it("lets each report live as long as what it reports lasts", () => {
    const life = (kind: string, type: string) =>
      crowdRulesFor(registry, { class: "situation", kind, type })?.ttlSec;
    expect(life("congestion", "congestion")).toBe(300);
    expect(life("incident", "obstruction")).toBe(900);
    expect(life("incident", "accident")).toBe(1800);
    expect(life("closure", "closure")).toBe(14400);
    expect(life("roadworks", "works")).toBe(604800);
    expect(life("restriction", "dimension")).toBeUndefined();
    expect(life("alert", "wind")).toBeUndefined();
  });

  it("refuses a transit disruption: the transit domain is not registered", () => {
    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "situation",
          kind: "transit_disruption",
          type: "disruption",
          geometry: here,
          fuzziness: "exact",
          reportedAt: "2026-10-01T11:59:00Z",
          nonce: nextNonce(),
        },
        keyId: KEY,
      },
      ctx(NOW),
    );
    expect(landed.ok).toBe(false);
  });
});

interface AutobahnClosure {
  identifier: string;
  title: string;
  startTimestamp: string;
  description: string[];
  geometry: { type: "LineString"; coordinates: number[][] };
}

describe("a closure the motorway operator publishes", () => {
  const record = json("crowd", "autobahn-a5-closure.json").closure[0] as AutobahnClosure;
  const ramp = sealed({
    id: `oc:situation:de-autobahn-events:${record.identifier}`,
    class: "situation",
    kind: "closure",
    type: "closure",
    subtype: "ramp",
    temporality: "live",
    location: {
      geometry: record.geometry,
      extent: "linear",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [{ ref: "A5", class: "motorway", designation: { scheme: "de_bab", ref: "A5" } }],
    },
    provenance: feed(
      "de-autobahn-events",
      "autobahn-closure",
      record.identifier,
      "Die Autobahn GmbH des Bundes",
      "DL-DE-BY-2.0",
    ),
    freshness: { fetchedAt: "2026-10-01T11:40:00Z" },
    planned: true,
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    headline: [{ lang: "de", text: record.title }],
    validity: { status: "active", start: record.startTimestamp },
    effects: [
      {
        id: `${record.identifier}/closure`,
        kind: "closure",
        v: 1,
        scope: "ramp",
        applicability: { kind: "all" },
        compliance: "mandatory",
        normalization: "complete",
      },
    ],
    details: { kind: "closure", v: 1 },
  });

  const report = (lon: number, lat: number, reportedAt = "2026-10-01T11:58:00Z") => {
    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "situation",
          kind: "closure",
          type: "closure",
          subtype: "ramp",
          geometry: { type: "Point", coordinates: [lon, lat] },
          fuzziness: "exact",
          reportedAt,
          nonce: nextNonce(),
        },
        keyId: KEY,
      },
      ctx("2026-10-01T12:00:00Z"),
    );
    if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
    return landed.draft as never;
  };

  it("resolves a driver's report on the ramp, in effect when it was made", () => {
    // 40 m north of the ramp's middle.
    expect(situationsAgree(registry, report(8.561, 49.14682), ramp as never)).toBe(true);
  });

  it("does not resolve a report on the motorway half a kilometre away, or before the works", () => {
    expect(situationsAgree(registry, report(8.5546, 49.1435), ramp as never)).toBe(false);
    const early = landClaim(
      registry,
      {
        claim: {
          claimClass: "situation",
          kind: "closure",
          type: "closure",
          geometry: { type: "Point", coordinates: [8.561, 49.14682] },
          fuzziness: "exact",
          reportedAt: "2026-09-19T04:30:00Z",
          nonce: nextNonce(),
        },
        keyId: KEY,
      },
      ctx("2026-09-19T05:00:00Z"),
    );
    expect(early.ok && situationsAgree(registry, early.draft as never, ramp as never)).toBe(false);
  });
});

interface OcpdbConnector {
  id: string;
  standard: string;
  format: string;
  power_type: string;
  max_voltage?: number;
  max_amperage?: number;
  max_electric_power?: number;
}
interface OcpdbEvse {
  uid: string;
  evse_id?: string;
  status: string;
  last_updated: string;
  connectors: OcpdbConnector[];
}
interface OcpdbLocation {
  id: string;
  source: string;
  original_id: string;
  address: string;
  coordinates: { latitude: number; longitude: number };
  operator?: { name: string };
  evses: OcpdbEvse[];
}

/** eMI3 EVSE ids: country, operator, `E`, outlet — with or without the separators. */
const EMI3 = /^[A-Z]{2}\*?[A-Z0-9]{3}\*?E[A-Z0-9*]{1,31}$/;

/**
 * One OCPDB location as a charging site. The register's rows carry the
 * register's own ids in the EVSE id field (`BNETZA*1031489*1`); they are
 * `bnetza` ids, not eMI3 ones, so nothing pretends they could match a live
 * feed's eMI3 ids.
 */
function chargingSite(loc: OcpdbLocation) {
  const id = `oc:feature:de-bw-ocpdb:${loc.id}`;
  const provenance = {
    ...feed("de-bw-ocpdb", "ocpi", loc.id, "MobiData BW", "CC-BY-4.0"),
    upstream: [{ publisher: loc.source, recordId: loc.original_id }],
  };
  const location = point(loc.coordinates.longitude, loc.coordinates.latitude);
  const components = loc.evses.flatMap((evse) => [
    {
      key: evse.uid,
      kind: "evse",
      ...(evse.evse_id === undefined
        ? {}
        : {
            externalIds: [
              { scheme: EMI3.test(evse.evse_id) ? "emi3:evse" : "bnetza", id: evse.evse_id },
            ],
          }),
      details: {
        kind: "evse",
        v: 1,
        uid: evse.uid,
        ...(evse.evse_id ? { evseId: evse.evse_id } : {}),
      },
    },
    ...evse.connectors.map((c) => ({
      key: c.id,
      parentKey: evse.uid,
      kind: "connector",
      details: {
        kind: "connector",
        v: 1,
        standard: registry.crosswalk.value("connector_standard", "ocpi", c.standard) ?? "UNKNOWN",
        format: c.format.toLowerCase(),
        powerType: c.power_type,
      },
    })),
  ]);
  const feature = sealed({
    id,
    class: "feature",
    kind: "charging_site",
    temporality: "static",
    lifecycle: "operational",
    location,
    // The database's location id names its row for one upstream source, not
    // an operator's OCPI location: it publishes one row per source of a car
    // park, so the id is the aggregator's own (`provider`). The register's
    // number is a `bnetza` id.
    externalIds: [
      { scheme: "provider", id: loc.id, authority: "de-bw-ocpdb" },
      ...(loc.source === "bnetza_api" ? [{ scheme: "bnetza", id: loc.original_id }] : []),
    ],
    ...(loc.operator === undefined
      ? {}
      : { operator: { role: "operator", name: [{ lang: "de", text: loc.operator.name }] } }),
    provenance,
    freshness: { fetchedAt: "2026-10-01T06:40:00Z" },
    components,
    details: { kind: "charging_site", v: 1 },
  });
  const statuses = loc.evses.map((evse) => {
    const draft = {
      class: "observation",
      kind: "observation",
      property: "charging.evse_status",
      temporality: "live",
      location,
      provenance,
      freshness: { fetchedAt: "2026-10-01T06:40:00Z" },
      subject: { kind: "feature", featureId: id, componentKey: evse.uid },
      result: {
        type: "category",
        value: registry.crosswalk.value("evse_status", "ocpi", evse.status) ?? "unknown",
        vocabulary: "evse_status",
      },
      phenomenonTime: { instant: evse.last_updated },
      aggregation: "instantaneous",
    };
    return sealed({ id: observationId("de-bw-ocpdb", draft as never), ...draft });
  });
  return { feature, statuses };
}

const linkable = (f: Record<string, unknown>) => f as unknown as LinkableFeature;

describe("a charge point two sources describe", () => {
  const [live, register] = (
    json("crowd", "ocpdb-luisenstrasse-2f.json").items as OcpdbLocation[]
  ).map(chargingSite) as [ReturnType<typeof chargingSite>, ReturnType<typeof chargingSite>];
  const rules = registry.kind("feature", "charging_site")!.linking!;
  const link = proposeLink(linkable(live.feature), linkable(register.feature), rules)!;
  const [cluster] = canonicalClusters(
    [linkable(live.feature), linkable(register.feature)],
    [link],
    { instanceId: INSTANCE, rank: (f) => (f.id === live.feature["id"] ? 1 : 0) },
  );
  const components = canonicalComponents(registry, cluster!, [
    live.feature as never,
    register.feature as never,
  ]);
  const location = live.feature["location"] as never;
  const canonicalKey = (featureId: string, key: string) =>
    components.find((c) => c.members.some((m) => m.featureId === featureId && m.key === key))?.key;
  const resolveFeature: LandingContext["resolveFeature"] = (featureId, componentKey) => {
    const key = componentKey === undefined ? undefined : canonicalKey(featureId, componentKey);
    if (
      !cluster!.memberIds.includes(featureId) ||
      (componentKey !== undefined && key === undefined)
    )
      return undefined;
    return {
      featureId: cluster!.canonicalFeatureId,
      ...(key ? { componentKey: key } : {}),
      location,
    };
  };

  it("links the two records of one car park by position", () => {
    expect(link.status).toBe("accepted");
    expect(cluster!.memberIds).toHaveLength(2);
    expect(cluster!.survivorId).toBe(live.feature["id"]);
  });

  it("keeps all twenty charge points, because the register's ids share nothing with the feed's", () => {
    const evses = components.filter((c) => c.kind === "evse");
    expect(evses).toHaveLength(20);
    expect(evses.every((c) => c.members.length === 1)).toBe(true);
    expect(evses.filter((c) => c.key.startsWith("de-bw-ocpdb/"))).toHaveLength(10);
    expect(
      components.filter((c) => c.kind === "connector").every((c) => c.parentKey !== undefined),
    ).toBe(true);
  });

  const charging = "262397002";
  const broken = (reportedAt: string, keyId = KEY) =>
    landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: live.feature["id"] as string, componentKey: charging },
          property: "charging.evse_status",
          result: { type: "category", value: "out_of_order", vocabulary: "evse_status" },
          // In the car park, a few metres from the charge points.
          geometry: { type: "Point", coordinates: [8.40478, 49.00062] },
          reportedAt,
          nonce: nextNonce(),
        },
        keyId,
      },
      ctx("2026-10-01T07:00:00Z", resolveFeature),
    );

  it("lands a driver's report on the canonical charge point", () => {
    const landed = broken("2026-10-01T06:58:00Z");
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.draft["subject"]).toEqual({
      kind: "feature",
      featureId: cluster!.canonicalFeatureId,
      componentKey: charging,
    });
    expect(seal(landed.draft).ok).toBe(true);
  });

  it("refuses a report made from across town", () => {
    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: live.feature["id"] as string, componentKey: charging },
          property: "charging.evse_status",
          result: { type: "category", value: "out_of_order", vocabulary: "evse_status" },
          // At the Lorenzstraße charge points, 1.5 km away.
          geometry: { type: "Point", coordinates: [8.38377, 49.00106] },
          reportedAt: "2026-10-01T06:58:00Z",
          nonce: nextNonce(),
        },
        keyId: KEY,
      },
      ctx("2026-10-01T07:00:00Z", resolveFeature),
    );
    expect(landed).toMatchObject({ ok: false, issues: [{ code: "out_of_reach" }] });
  });

  it("refuses a report about a charge point neither source has", () => {
    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: live.feature["id"] as string, componentKey: "no-such-point" },
          property: "charging.evse_status",
          result: { type: "category", value: "out_of_order", vocabulary: "evse_status" },
          geometry: { type: "Point", coordinates: [8.40478, 49.00062] },
          reportedAt: "2026-10-01T06:58:00Z",
          nonce: nextNonce(),
        },
        keyId: KEY,
      },
      ctx("2026-10-01T07:00:00Z", resolveFeature),
    );
    expect(landed.ok).toBe(false);
  });

  const feedStatus = live.statuses.find(
    (s) => (s["subject"] as { componentKey: string }).componentKey === charging,
  )!;
  const candidates = (stale: boolean, state: "self_reported" | "negated"): FusionCandidate[] => {
    const landed = broken("2026-10-01T06:58:00Z");
    if (!landed.ok) throw new Error("did not land");
    return [
      { observation: feedStatus as unknown as FusableObservation, sourceTier: "aggregator", stale },
      {
        observation: sealed(landed.draft) as unknown as FusableObservation,
        evidence: { state },
        stale: false,
      },
    ];
  };
  const shown = (stale: boolean, state: "self_reported" | "negated") => {
    const fusion = fuse(
      registry,
      "charging.evse_status",
      candidates(stale, state),
      "2026-10-01T07:00:00Z",
    );
    return (fusion?.winner.observation.result as { value: string } | undefined)?.value;
  };

  it("shows the operator's fresh status over a driver's report", () => {
    expect((feedStatus["result"] as { value: string }).value).toBe("charging");
    expect(shown(false, "self_reported")).toBe("charging");
  });

  it("shows the driver's report once the feed has gone stale, unless others said it was wrong", () => {
    expect(shown(true, "self_reported")).toBe("out_of_order");
    expect(shown(true, "negated")).toBe("charging");
  });

  it("writes the fused row on the canonical charge point, credited to the feed", () => {
    const fusion = fuse(
      registry,
      "charging.evse_status",
      candidates(false, "self_reported"),
      "2026-10-01T07:00:00Z",
    )!;
    const fused = fusedObservation(registry, fusion, {
      subject: { kind: "feature", featureId: cluster!.canonicalFeatureId, componentKey: charging },
      location,
      instanceId: INSTANCE,
      now: "2026-10-01T07:00:00Z",
    });
    expect(fused.ok).toBe(true);
    if (!fused.ok) return;
    expect(fused.value["provenance"]).toMatchObject({
      sourceId: "@fused",
      attribution: { provider: "MobiData BW", license: "CC-BY-4.0" },
      mergedSources: [{ source: "de-bw-ocpdb", recordId: feedStatus["id"] }],
    });
    expect(seal(fused.value).ok).toBe(true);
  });
});

describe("a charge point the operator reports out of order", () => {
  const lorenz = (
    json("facilities", "ocpdb-charging-karlsruhe.json").items as OcpdbLocation[]
  ).find((l) => l.id === "309444")!;
  const { feature, statuses } = chargingSite(lorenz);
  const [status] = statuses;

  it("resolves a driver who says the same, within the report's lifetime", () => {
    const claim = (value: string, keyId: string) =>
      landClaim(
        registry,
        {
          claim: {
            claimClass: "observation",
            subject: { featureId: feature["id"] as string, componentKey: lorenz.evses[0]!.uid },
            property: "charging.evse_status",
            result: { type: "category", value, vocabulary: "evse_status" },
            geometry: {
              type: "Point",
              coordinates: [lorenz.coordinates.longitude, lorenz.coordinates.latitude],
            },
            reportedAt: "2026-09-22T12:30:00Z",
            nonce: nextNonce(),
          },
          keyId,
        },
        ctx("2026-09-22T12:31:00Z", (featureId, componentKey) =>
          featureId === feature["id"]
            ? {
                featureId,
                ...(componentKey ? { componentKey } : {}),
                location: feature["location"] as never,
              }
            : undefined,
        ),
      );
    expect((status!["result"] as { value: string }).value).toBe("out_of_order");
    expect((status!["phenomenonTime"] as { instant: string }).instant).toMatch(/^2026-09-22T/);
    const agreeing = claim("out_of_order", KEY);
    const disagreeing = claim("available", OTHER_KEY);
    expect(
      agreeing.ok && observationConfirms(registry, agreeing.draft as never, status as never),
    ).toBe(true);
    expect(
      disagreeing.ok && observationConfirms(registry, disagreeing.draft as never, status as never),
    ).toBe(false);
  });
});

const MINETUR_E5 = "Precio Gasolina 95 E5";

describe("a fuel price a driver reads off the pole", () => {
  const station = (
    json("facilities", "minetur-stations.json").ListaEESSPrecio as Record<string, string>[]
  ).find((s) => (s[MINETUR_E5] ?? "") !== "")!;
  const decimal = (value: string) => value.replace(",", ".");
  const published = decimal(station[MINETUR_E5]!);
  const id = `oc:feature:es-minetur:${station["IDEESS"]}`;
  const location = point(
    Number(decimal(station["Longitud (WGS84)"]!)),
    Number(decimal(station["Latitud"]!)),
  );
  const price = {
    property: "fuel.price",
    result: { type: "money" as const, amount: published, currency: "EUR", per: "L" },
    phenomenonTime: { instant: "2026-09-22T11:07:59Z" },
  };
  const report = (amount: string) => {
    const landed = landClaim(
      registry,
      {
        claim: {
          claimClass: "observation",
          subject: { featureId: id, componentKey: "e5" },
          property: "fuel.price",
          result: { type: "money", amount, currency: "EUR", per: "L" },
          geometry: location.geometry,
          reportedAt: "2026-09-22T12:00:00Z",
          nonce: nextNonce(),
        },
        keyId: KEY,
      },
      ctx("2026-09-22T12:01:00Z", (featureId, componentKey) =>
        featureId === id && componentKey === "e5"
          ? { featureId, componentKey, location: location as never }
          : undefined,
      ),
    );
    if (!landed.ok) throw new Error(JSON.stringify(landed.issues));
    return landed.draft as never;
  };
  const cents = (delta: number) => (Number(published) + delta).toFixed(3);

  it("agrees with the ministry's price within a cent", () => {
    expect(observationConfirms(registry, report(cents(0.009)), price)).toBe(true);
    expect(observationConfirms(registry, report(cents(-0.01)), price)).toBe(true);
  });

  it("does not agree two cents off", () => {
    expect(observationConfirms(registry, report(cents(0.02)), price)).toBe(false);
  });
});
