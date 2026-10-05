import { type LinkableFeature, proposeLink } from "@openconditions/model";
import { PARKING_KINDS } from "@openconditions/model-parking";
import { describe, expect, test } from "vitest";
import {
  availableDraft,
  occupancyDrafts,
  occupiedDraft,
  type ParkingFeed,
  rateDraft,
  type SiteInput,
  siteDraft,
  statusDraft,
  trendDraft,
} from "../site.js";
import { baselFeed, bnlsFeed, parseContext, viennaFeed } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T03:12:30Z";
const AT = "2026-10-05T03:12:00Z";
const ctx = parseContext(FETCHED);
const RULES = PARKING_KINDS.find((k) => k.code === "parking_site")!.linking!;

const SITE: SiteInput = {
  stationId: "226",
  point: [16.3762062, 48.20498313],
  name: "Weihburggasse",
  lang: "de",
  type: "off_street",
};

describe("siteDraft", () => {
  test("a site is a parking_site feature that seals", () => {
    const site = siteDraft(viennaFeed(), SITE, FETCHED);
    expect(site).toMatchObject({
      id: "oc:feature:at-9-vienna-parking:226",
      class: "feature",
      kind: "parking_site",
      type: "off_street",
      lifecycle: "operational",
      name: [{ lang: "de", text: "Weihburggasse" }],
      location: { geometry: { type: "Point", coordinates: [16.3762062, 48.20498313] } },
      provenance: { sourceId: "at-9-vienna-parking", sourceFormat: "geojson", recordId: "226" },
      freshness: { fetchedAt: FETCHED },
    });
    expect(sealFailures([site])).toEqual([]);
  });

  test("a site with disabled spaces but no count gets an area without capacity", () => {
    const site = siteDraft(
      viennaFeed(),
      { ...SITE, areas: [{ vehicleType: "car", userGroup: "disabled" }] },
      FETCHED,
    );
    expect(site["components"]).toEqual([
      {
        key: "car:disabled",
        kind: "parking_area",
        details: { kind: "parking_area", v: 1, vehicleType: "car", userGroup: "disabled" },
      },
    ]);
    expect(sealFailures([site])).toEqual([]);
  });

  test("an area's count is its capacity; an impossible count leaves it out", () => {
    const site = siteDraft(
      viennaFeed(),
      {
        ...SITE,
        areas: [
          { vehicleType: "car", userGroup: "disabled", capacity: 15 },
          { vehicleType: "car", userGroup: "ev_charging", capacity: -999 },
        ],
      },
      FETCHED,
    );
    expect(site["components"]).toEqual([
      expect.objectContaining({
        key: "car:disabled",
        details: expect.objectContaining({ capacity: 15 }),
      }),
      {
        key: "car:ev_charging",
        kind: "parking_area",
        details: { kind: "parking_area", v: 1, vehicleType: "car", userGroup: "ev_charging" },
      },
    ]);
  });

  test("every site carries its provider id, with the upstream source for aggregators", () => {
    expect(siteDraft(viennaFeed(), SITE, FETCHED)["externalIds"]).toEqual([
      { scheme: "provider", id: "226", authority: "at-9-vienna-parking" },
    ]);
    const aggregated = siteDraft(
      bnlsFeed(),
      {
        ...SITE,
        stationId: "06027-P-001",
        providerAuthority: "fr-bnls-parking/niceazurparking",
        externalIds: [{ scheme: "osm:way", id: "42" }],
        upstream: [{ publisher: "Nice Azur Parking", recordId: "P1", license: "ODbL-1.0" }],
      },
      FETCHED,
    );
    expect(aggregated["externalIds"]).toEqual([
      { scheme: "provider", id: "06027-P-001", authority: "fr-bnls-parking/niceazurparking" },
      { scheme: "osm:way", id: "42" },
    ]);
    expect(aggregated["provenance"]).toMatchObject({
      upstream: [{ publisher: "Nice Azur Parking", recordId: "P1", license: "ODbL-1.0" }],
    });
  });

  test("two sites of one source never link, however close and alike", () => {
    const a = siteDraft(viennaFeed(), SITE, FETCHED) as unknown as LinkableFeature;
    const b = siteDraft(
      viennaFeed(),
      { ...SITE, stationId: "227", point: [16.3763, 48.205] },
      FETCHED,
    ) as unknown as LinkableFeature;
    expect(proposeLink(a, b, RULES)).toBeUndefined();
  });

  test("a free site pays nothing; audience is only what the source states", () => {
    const free = siteDraft(viennaFeed(), { ...SITE, free: true }, FETCHED);
    expect(free["access"]).toEqual({ audience: "unknown", payment: ["free"] });
    const stated = siteDraft(viennaFeed(), { ...SITE, audience: "public" }, FETCHED);
    expect(stated["access"]).toEqual({ audience: "public" });
    expect(siteDraft(viennaFeed(), SITE, FETCHED)["access"]).toBeUndefined();
    expect(sealFailures([free, stated])).toEqual([]);
  });

  test("the address carries the feed's country; text, hours, tariff and website go to details", () => {
    const site = siteDraft(
      viennaFeed(),
      {
        ...SITE,
        address: { street: "Hegelgasse 1", postalCode: "1010", city: "Wien" },
        openingHoursOsm: "24/7",
        openingHoursText: "rund um die Uhr",
        tariffText: "EUR 5 pro Stunde",
        website: "http://wipark.com",
        operator: "WIPARK Garagen GmbH",
        heightLimitM: 2.1,
        capacityTotal: 300,
        layout: "underground",
        usage: ["park_and_ride", "not_a_usage"],
        amenities: ["toilets"],
        notes: "Einfahrt über Hegelgasse",
      },
      FETCHED,
    );
    expect(site).toMatchObject({
      location: {
        address: { street: "Hegelgasse 1", postalCode: "1010", city: "Wien", country: "AT" },
        admin: { country: "AT" },
      },
      openingHours: { osm: "24/7", twentyFourSeven: true },
      operator: { role: "operator", name: [{ lang: "de", text: "WIPARK Garagen GmbH" }] },
      description: [{ lang: "de", text: "Einfahrt über Hegelgasse" }],
      amenities: ["toilets"],
      details: {
        kind: "parking_site",
        v: 1,
        layout: "underground",
        capacityTotal: 300,
        heightLimit: { value: 2.1, unit: "m" },
        usage: ["park_and_ride"],
        website: "http://wipark.com",
        tariffText: [{ lang: "de", text: "EUR 5 pro Stunde" }],
        openingHoursText: [{ lang: "de", text: "rund um die Uhr" }],
      },
    });
    expect(sealFailures([site])).toEqual([]);
  });

  test("a site without a stated type is off-street", () => {
    const { type: _type, ...untyped } = SITE;
    expect(siteDraft(viennaFeed(), untyped, FETCHED)["type"]).toBe("off_street");
  });

  test("an on-demand feed's site states when it expires", () => {
    const feed: ParkingFeed = {
      ...viennaFeed(),
      accessMode: "on_demand",
      onDemand: { cellDeg: 0.05, ttlSec: 21600, maxCellsPerRead: 16, probe: [8.4, 49.01] },
    };
    expect(siteDraft(feed, SITE, FETCHED)["freshness"]).toEqual({
      fetchedAt: FETCHED,
      expiresAt: "2026-10-05T09:12:30Z",
    });
  });
});

describe("readings", () => {
  test("an available count is a count reading on the site or an area", () => {
    const site = availableDraft(baselFeed(), { stationId: "city", at: AT, count: 1057 }, ctx)!;
    expect(site).toMatchObject({
      class: "observation",
      property: "parking.available",
      subject: { kind: "feature", featureId: "oc:feature:ch-bs-basel-parking:city" },
      result: { type: "count", value: 1057 },
      phenomenonTime: { instant: AT },
      temporality: "live",
    });
    expect(site["id"]).toMatch(/^oc:observation:ch-bs-basel-parking:/);
    const area = availableDraft(
      baselFeed(),
      { stationId: "city", at: AT, count: 3, area: { vehicleType: "car", userGroup: "disabled" } },
      ctx,
    )!;
    expect(area["subject"]).toEqual({
      kind: "feature",
      featureId: "oc:feature:ch-bs-basel-parking:city",
      componentKey: "car:disabled",
    });
    expect(sealFailures([site, area])).toEqual([]);
  });

  test("an occupied count above capacity, a negative count and -1 produce no reading", () => {
    expect(availableDraft(baselFeed(), { stationId: "1", at: AT, count: -1 }, ctx)).toBeUndefined();
    expect(availableDraft(baselFeed(), { stationId: "1", at: AT, count: -7 }, ctx)).toBeUndefined();
    expect(
      availableDraft(baselFeed(), { stationId: "1", at: AT, count: 2.5 }, ctx),
    ).toBeUndefined();
    expect(occupiedDraft(baselFeed(), { stationId: "1", at: AT, count: -1 }, ctx)).toBeUndefined();
    // A free count above capacity is impossible; an occupied count above
    // capacity says the car park is over-full, so it is kept and leaves no room.
    expect(
      availableDraft(baselFeed(), { stationId: "1", at: AT, count: 168, capacity: 165 }, ctx),
    ).toBeUndefined();
    const overfull = occupancyDrafts(
      baselFeed(),
      { stationId: "1", at: AT },
      { occupied: 170, capacity: 165 },
      ctx,
    );
    expect(overfull.map((o) => [o["property"], (o["result"] as { value: number }).value])).toEqual([
      ["parking.available", 0],
      ["parking.occupied", 170],
    ]);
  });

  test("available is derived from capacity and occupied only when both are known", () => {
    const derived = occupancyDrafts(
      baselFeed(),
      { stationId: "1", at: AT },
      { occupied: 40, capacity: 100 },
      ctx,
    );
    expect(derived.map((o) => [o["property"], (o["result"] as { value: number }).value])).toEqual([
      ["parking.available", 60],
      ["parking.occupied", 40],
    ]);
    expect(
      occupancyDrafts(baselFeed(), { stationId: "1", at: AT }, { occupied: 40 }, ctx).map(
        (o) => o["property"],
      ),
    ).toEqual(["parking.occupied"]);
    expect(
      occupancyDrafts(
        baselFeed(),
        { stationId: "1", at: AT },
        { available: 168, capacity: 165 },
        ctx,
      ),
    ).toEqual([]);
    // An impossible free count is not replaced by one derived from the same publication.
    expect(
      occupancyDrafts(
        baselFeed(),
        { stationId: "1", at: AT },
        { available: 168, occupied: 0, capacity: 165 },
        ctx,
      ).map((o) => [o["property"], (o["result"] as { value: number }).value]),
    ).toEqual([["parking.occupied", 0]]);
    // A free count of 0 is a reading of 0.
    expect(
      occupancyDrafts(baselFeed(), { stationId: "1", at: AT }, { available: 0 }, ctx).map((o) => [
        o["property"],
        (o["result"] as { value: number }).value,
      ]),
    ).toEqual([["parking.available", 0]]);
  });

  test("a reading is valid for max(30 min, two status cadences)", () => {
    expect(
      statusDraft(baselFeed(), { stationId: "1", at: "2026-10-05T10:00:00Z", status: "open" }, {
        cadenceSec: 3600,
      } as never)!.validUntil,
    ).toBe("2026-10-05T12:00:00.000Z");
    expect(
      availableDraft(baselFeed(), { stationId: "1", at: "2026-10-05T10:00:00Z", count: 4 }, {
        cadenceSec: 300,
      } as never)!.validUntil,
    ).toBe("2026-10-05T10:30:00.000Z");
  });

  test("status and trend are category readings in their vocabularies", () => {
    const status = statusDraft(baselFeed(), { stationId: "city", at: AT, status: "closed" }, ctx)!;
    const trend = trendDraft(baselFeed(), { stationId: "city", at: AT, trend: "filling" }, ctx)!;
    expect(status["result"]).toEqual({
      type: "category",
      value: "closed",
      vocabulary: "parking_status",
    });
    expect(trend["result"]).toEqual({ type: "category", value: "filling", vocabulary: "trend" });
    expect(sealFailures([status, trend])).toEqual([]);
  });

  test("a reading with the site's point is located there", () => {
    const placed = availableDraft(
      baselFeed(),
      { stationId: "city", at: AT, count: 1, point: [7.58, 47.56] },
      ctx,
    )!;
    expect(placed["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [7.58, 47.56] },
    });
  });
});

describe("rateDraft", () => {
  test("each priced row is one flat element with its restrictions", () => {
    const rate = rateDraft(bnlsFeed(), "06027-P-001", 1, {
      currency: "EUR",
      rows: [
        { amount: 2, maxDuration: { value: 1, unit: "h" } },
        { amount: 27.2, maxDuration: { value: 24, unit: "h" }, userGroups: ["residents"] },
      ],
      text: "Tarif normal",
      lang: "fr",
      point: [7.145722, 43.668532],
      fetchedAt: FETCHED,
    })!;
    expect(rate).toMatchObject({
      id: "oc:offer:fr-bnls-parking:06027-P-001:1",
      class: "offer",
      kind: "parking_rate",
      subject: { class: "feature", id: "oc:feature:fr-bnls-parking:06027-P-001" },
      currency: "EUR",
      elements: [
        {
          components: [{ type: "flat", price: { amount: "2.00", currency: "EUR" } }],
          restrictions: { maxDuration: { value: 1, unit: "h" } },
        },
        {
          components: [{ type: "flat", price: { amount: "27.20", currency: "EUR" } }],
          restrictions: { maxDuration: { value: 24, unit: "h" }, userGroups: ["residents"] },
        },
      ],
      displayText: [{ lang: "fr", text: "Tarif normal" }],
      validity: { status: "active" },
    });
    expect(sealFailures([rate])).toEqual([]);
  });

  test("a parking_time row is a price per hour, billed in steps, between two durations", () => {
    const rate = rateDraft(bnlsFeed(), "06027-P-001", 1, {
      currency: "CHF",
      rows: [
        {
          component: "parking_time",
          amount: 0.5,
          stepSizeSec: 360,
          minDuration: { value: 0, unit: "min" },
          maxDuration: { value: 300, unit: "min" },
        },
        // A price per hour that is not a whole number of cents is kept.
        { component: "parking_time", amount: 5 / 7, stepSizeSec: 420 },
        { amount: 12, maxDuration: { value: 1, unit: "d" } },
      ],
      fetchedAt: FETCHED,
    })!;
    expect(rate["elements"]).toEqual([
      {
        components: [
          { type: "parking_time", price: { amount: "0.50", currency: "CHF" }, stepSize: 360 },
        ],
        restrictions: {
          minDuration: { value: 0, unit: "min" },
          maxDuration: { value: 300, unit: "min" },
        },
      },
      {
        components: [
          { type: "parking_time", price: { amount: "0.7143", currency: "CHF" }, stepSize: 420 },
        ],
      },
      {
        components: [{ type: "flat", price: { amount: "12.00", currency: "CHF" } }],
        restrictions: { maxDuration: { value: 1, unit: "d" } },
      },
    ]);
    expect(sealFailures([rate])).toEqual([]);
  });

  test("a rate with no priced row is no offer", () => {
    expect(
      rateDraft(bnlsFeed(), "1", 1, {
        currency: "EUR",
        rows: [{ amount: Number.NaN }],
        fetchedAt: FETCHED,
      }),
    ).toBeUndefined();
  });
});
