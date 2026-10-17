import { assertCovered, type CoverageSpec, pinnedOrUnavailable } from "@openconditions/conformance";
import {
  IRVE_DYNAMIC_SCHEMA,
  IRVE_STATIC_SCHEMA,
  IRVE_V2,
} from "@openconditions/conformance/standards/irve-v2";
import {
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chargingDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/charging-feed.js";
import {
  booleanValues,
  csvRecords,
  enumOf,
  fieldOf,
  type TableError,
  type TableSchema,
  validateTable,
} from "./helpers/table-schema.js";

const FEED_ID = "fr-irve-charging";
const FETCHED = "2026-10-06T02:45:56Z";
const RECENT = "2026-10-06T01:00:00Z";

type Row = Record<string, string>;
type Component = {
  key: string;
  parentKey?: string;
  kind: string;
  details: Record<string, unknown>;
};

function parse(payloads: FeedPayloads): ParseOutput {
  return chargingDomain.formats["irve"]!.parse(
    catalogFeed(FEED_ID),
    payloads,
    parseContext(FETCHED),
  );
}

const quote = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
const csv = (header: readonly string[], rows: readonly Row[]) =>
  `${[header, ...rows.map((r) => header.map((h) => r[h] ?? ""))].map((cells) => cells.map(quote).join(",")).join("\n")}\n`;

const [STATIC_HEADER = [], ...STATIC_ROWS] = csvRecords(
  fixture("irve-static.csv").toString("utf8"),
);
const rowOf = (cells: readonly string[]): Row =>
  Object.fromEntries(STATIC_HEADER.map((h, i) => [h, cells[i] ?? ""]));
/** The fixture's Acelec point FR073ERJ5G5279: a Type 2 socket, every optional column filled. */
const BASE: Row = rowOf(STATIC_ROWS.find((r) => r.includes("FR073ERJ5G5279"))!);
const PDC = BASE["id_pdc_itinerance"]!;

const staticCsv = (...rows: Row[]) => Buffer.from(csv(STATIC_HEADER, rows));
const one = (over: Row = {}) => parse({ main: [staticCsv({ ...BASE, ...over })] });
const site = (out: ParseOutput) => out.features[0];
const components = (draft: RecordDraft | undefined) => (draft?.["components"] ?? []) as Component[];
const evse = (out: ParseOutput) => components(site(out)).find((c) => c.kind === "evse");
const connectors = (out: ParseOutput): Record<string, unknown>[] =>
  components(site(out))
    .filter((c) => c.kind === "connector")
    .map((c) => ({ id: c.key.split("/")[1], ...c.details }));
const details = (out: ParseOutput) => (site(out)?.["details"] ?? {}) as Record<string, unknown>;
const access = (out: ParseOutput) => (site(out)?.["access"] ?? {}) as Record<string, unknown>;

const DYNAMIC_HEADER = [
  "id_pdc_itinerance",
  "etat_pdc",
  "occupation_pdc",
  "horodatage",
  "etat_prise_type_2",
  "etat_prise_type_combo_ccs",
  "etat_prise_type_chademo",
  "etat_prise_type_ef",
];
/** The base point with every plug the dynamic schema gives a state of. */
const ALL_PLUGS: Row = {
  prise_type_ef: "true",
  prise_type_2: "true",
  prise_type_combo_ccs: "true",
  prise_type_chademo: "true",
};
const STATUS_BASE: Row = {
  id_pdc_itinerance: PDC,
  etat_pdc: "en_service",
  occupation_pdc: "libre",
  horodatage: RECENT,
};
function withStatus(over: Row = {}, staticOver: Row = ALL_PLUGS): ParseOutput {
  return parse({
    main: [staticCsv({ ...BASE, ...staticOver })],
    status: [Buffer.from(csv(DYNAMIC_HEADER, [{ ...STATUS_BASE, ...over }]))],
  });
}
/** Each reading's value by the component it is of. */
const readings = (out: ParseOutput) =>
  Object.fromEntries(
    out.observations.map((o) => [
      (o["subject"] as { componentKey: string }).componentKey,
      (o["result"] as { value: string }).value,
    ]),
  );

/** Whether a parse recorded no unread value: the value was read, as true, false or a mapped term. */
const noneUnread = () => drainSkipped(FEED_ID)["unknown_value"] === undefined;

let statique: TableSchema;
let dynamique: TableSchema;
let unavailable: string | undefined;

beforeAll(async () => {
  const pinned = await pinnedOrUnavailable(IRVE_V2);
  if ("unavailable" in pinned) {
    unavailable = pinned.unavailable;
    return;
  }
  const schema = (name: string) =>
    JSON.parse(pinned.files.find((f) => f.fileName === name)!.contents) as TableSchema;
  statique = schema(IRVE_STATIC_SCHEMA);
  dynamique = schema(IRVE_DYNAMIC_SCHEMA);
}, 120_000);

beforeEach(() => {
  drainSkipped(FEED_ID);
});

/**
 * The columns data.gouv.fr's consolidation adds after the schema's own: its
 * provenance and the position and commune it checked. The schema's fields
 * precede them in the schema's order.
 */
const CONSOLIDATION_COLUMNS = [
  "last_modified",
  "datagouv_dataset_id",
  "datagouv_resource_id",
  "datagouv_organization_or_owner",
  "created_at",
  "consolidated_longitude",
  "consolidated_latitude",
  "consolidated_code_postal",
  "consolidated_commune",
  "consolidated_is_lon_lat_correct",
  "consolidated_is_code_insee_verified",
  "consolidated_is_code_insee_modified",
];

/**
 * Where the captured files depart from the schemas, each with why. The
 * dynamic file writes its `horodatage` with a space between date and time,
 * as Python's `str(datetime)` does, on 113,665 of the 125,362 rows of the
 * 2026-10-17 file: Table Schema's default datetime format is ISO 8601
 * (`YYYY-MM-DDThh:mm:ssZ`), and the schema's own example is
 * `2023-01-30T10:27:50+01:00`. Validata, whose dateutil parser takes any
 * separator, passes them.
 */
const DYNAMIC_DEVIATIONS: TableError[] = [1, 2].map((row) => ({
  row,
  field: "horodatage",
  message: expect.stringContaining("is no ISO 8601 datetime") as unknown as string,
}));

describe("IRVE fixtures against the IRVE 2.3.1 Table Schemas", () => {
  it("the static capture holds every schema field in order, valid row by row", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const report = validateTable(statique, fixture("irve-static.csv").toString("utf8"));
    expect(report.rows).toBe(7);
    expect(report.extraColumns).toEqual(CONSOLIDATION_COLUMNS);
    expect(report.errors).toEqual([]);
  });

  it("the dynamic capture is valid but for the space in its timestamps, which the parser reads", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const report = validateTable(dynamique, fixture("irve-dynamic.csv").toString("utf8"));
    expect(report.extraColumns).toEqual([]);
    expect(report.errors).toEqual(DYNAMIC_DEVIATIONS);
    const out = parse({
      main: [fixture("irve-static.csv")],
      status: [fixture("irve-dynamic.csv")],
    });
    const at = Object.fromEntries(
      out.observations.map((o) => [
        (o["subject"] as { componentKey: string }).componentKey,
        (o["phenomenonTime"] as { instant: string }).instant,
      ]),
    );
    expect(at["FRBFCEVDIUF1"]).toBe("2026-10-05T16:55:37.034Z");
    expect(at["FRBFCEVDIUF2"]).toBe("2026-10-06T02:01:51.861Z");
  });

  it("the validator holds a row to each constraint the schemas use", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const errors = (over: Row) =>
      validateTable(statique, csv(STATIC_HEADER, [{ ...BASE, ...over }])).errors.map(
        (e) => `${e.field}: ${e.message}`,
      );
    expect(errors({})).toEqual([]);
    expect(errors({ implantation_station: "Parking souterrain" })).toEqual([
      expect.stringMatching(/^implantation_station: "Parking souterrain" is not one of/),
    ]);
    expect(errors({ siren_amenageur: "30119246" })).toEqual([
      expect.stringMatching(/^siren_amenageur: "30119246" does not match/),
    ]);
    expect(errors({ id_pdc_itinerance: "fr073erj5g5279" })).toEqual([
      expect.stringMatching(/^id_pdc_itinerance: .* does not match/),
    ]);
    expect(errors({ horaires: "du lundi au vendredi" })).toEqual([
      expect.stringMatching(/^horaires: .* does not match/),
    ]);
    expect(errors({ nom_enseigne: "" })).toEqual(["nom_enseigne: required but missing"]);
    expect(errors({ prise_type_2: "oui" })).toEqual([
      expect.stringMatching(/^prise_type_2: "oui" is no boolean/),
    ]);
    expect(errors({ puissance_nominale: "-1" })).toEqual(["puissance_nominale: -1 is below 0"]);
    expect(errors({ nbre_pdc: "2.5" })).toEqual(['nbre_pdc: "2.5" is no integer']);
    expect(errors({ coordonneesXY: "[48.84, 182.79]" })).toEqual([
      expect.stringMatching(/^coordonneesXY: .* is no geopoint array/),
    ]);
    expect(errors({ date_maj: "21/07/2022" })).toEqual([
      expect.stringMatching(/^date_maj: .* is no date of %Y-%m-%d/),
    ]);
    expect(errors({ contact_operateur: "acelec" })).toEqual([
      expect.stringMatching(/^contact_operateur: .* is no email address/),
    ]);
    const keyed: TableSchema = { ...statique, primaryKey: ["id_pdc_itinerance"] };
    expect(validateTable(keyed, csv(STATIC_HEADER, [BASE, BASE])).errors).toEqual([
      { row: 2, field: "id_pdc_itinerance", message: "primary key repeats row 1" },
    ]);
    // The schemas declare no key: the consolidation repeats a point under its station.
    expect(statique.primaryKey ?? statique.uniqueKeys).toBeUndefined();
    expect(dynamique.primaryKey ?? dynamique.uniqueKeys).toBeUndefined();
  });
});

/**
 * Every value the schemas enumerate, each run through the parser on a row
 * carrying it, and held to what the schema's description says it means.
 */
describe("IRVE enumerations through the parser", () => {
  const PARKING: Record<string, [string, string[]]> = {
    Voirie: ["on_street", []],
    "Parking public": ["parking_lot", []],
    "Parking privé à usage public": ["parking_lot", []],
    // "Ex : hôtel, commerce": OCPI's CUSTOMERS, "for customers/guests only".
    "Parking privé réservé à la clientèle": ["parking_lot", ["customers"]],
    "Station dédiée à la recharge rapide": ["other", []],
  };
  const AUDIENCE: Record<string, string> = {
    "Accès libre": "public",
    "Accès réservé": "restricted",
  };
  /** "Signalisé et réservé PMR" is accessible and a reserved bay; the rest say only whether accessible. */
  const ACCESSIBLE: Record<string, [boolean, string[]]> = {
    "Réservé PMR": [true, ["disabled"]],
    "Accessible mais non réservé PMR": [true, []],
    "Non accessible": [false, []],
  };
  /** With `occupation_pdc` libre: a point whose working state is unknown is as its occupancy says. */
  const STATE: Record<string, string> = {
    en_service: "available",
    hors_service: "out_of_order",
    inconnu: "available",
  };
  const OCCUPANCY: Record<string, string> = {
    libre: "available",
    occupe: "occupied",
    reserve: "reserved",
    inconnu: "unknown",
  };
  /** With the point in service and occupied: a working plug is as busy as its point. */
  const PLUG: Record<string, string> = {
    fonctionnel: "occupied",
    hors_service: "out_of_order",
    inconnu: "unknown",
  };
  const plug = (field: string): CoverageSpec => ({
    handled: (v) => {
      const id = field.replace("etat_prise_type_", "");
      const out = withStatus({ occupation_pdc: "occupe", [field]: v });
      return (
        noneUnread() &&
        readings(out)[`${PDC}/${id}`] === PLUG[v] &&
        readings(out)[PDC] === "occupied"
      );
    },
  });

  const COVERAGE: Record<string, { schema: () => TableSchema; spec: CoverageSpec }> = {
    implantation_station: {
      schema: () => statique,
      spec: {
        handled: (v) => {
          const out = one({ implantation_station: v });
          const [parking, restrictions] = PARKING[v] ?? [];
          return (
            noneUnread() &&
            details(out)["parkingType"] === parking &&
            JSON.stringify(evse(out)?.details["parkingRestrictions"] ?? []) ===
              JSON.stringify(restrictions)
          );
        },
      },
    },
    condition_acces: {
      schema: () => statique,
      spec: {
        handled: (v) => {
          const out = one({ condition_acces: v });
          return noneUnread() && access(out)["audience"] === AUDIENCE[v];
        },
      },
    },
    accessibilite_pmr: {
      schema: () => statique,
      spec: {
        handled: (v) => {
          const out = one({ accessibilite_pmr: v });
          const [accessible, restrictions] = ACCESSIBLE[v] ?? [];
          return (
            noneUnread() &&
            accessible !== undefined &&
            evse(out)?.details["wheelchairAccessible"] === accessible &&
            JSON.stringify(evse(out)?.details["parkingRestrictions"] ?? []) ===
              JSON.stringify(restrictions)
          );
        },
        unsupported: { "Accessibilité inconnue": "says nothing" },
      },
    },
    raccordement: {
      schema: () => statique,
      spec: {
        handled: (v) =>
          JSON.stringify(one({ raccordement: v }).features) !==
          JSON.stringify(one({ raccordement: "" }).features),
        unsupported: {
          Direct:
            "the station's own delivery point on the grid is the distribution network's arrangement, which the model does not describe",
          Indirect:
            "a delivery point shared with other uses is the distribution network's arrangement, which the model does not describe",
        },
      },
    },
    etat_pdc: {
      schema: () => dynamique,
      spec: {
        handled: (v) => {
          const out = withStatus({ etat_pdc: v });
          return noneUnread() && readings(out)[PDC] === STATE[v];
        },
      },
    },
    occupation_pdc: {
      schema: () => dynamique,
      spec: {
        handled: (v) => {
          const out = withStatus({ occupation_pdc: v });
          return noneUnread() && readings(out)[PDC] === OCCUPANCY[v];
        },
      },
    },
    etat_prise_type_2: { schema: () => dynamique, spec: plug("etat_prise_type_2") },
    etat_prise_type_combo_ccs: { schema: () => dynamique, spec: plug("etat_prise_type_combo_ccs") },
    etat_prise_type_chademo: { schema: () => dynamique, spec: plug("etat_prise_type_chademo") },
    etat_prise_type_ef: { schema: () => dynamique, spec: plug("etat_prise_type_ef") },
  };

  it("every enumerated field of both schemas is covered here", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const enumerated = [...statique.fields, ...dynamique.fields]
      .filter((f) => enumOf(f).length > 0)
      .map((f) => f.name);
    expect(enumerated.sort()).toEqual(Object.keys(COVERAGE).sort());
  });

  it.for(Object.keys(COVERAGE))(
    "%s: every value is read as the schema means it",
    (name, { skip }) => {
      if (unavailable) skip(unavailable);
      const { schema, spec } = COVERAGE[name]!;
      assertCovered(name, enumOf(fieldOf(schema(), name)), spec);
    },
  );

  it("an empty plug state, the schema's mark of a plug the point lacks, gives no reading", () => {
    const out = withStatus({ etat_prise_type_2: "hors_service" });
    expect(readings(out)).toEqual({ [PDC]: "available", [`${PDC}/2`]: "out_of_order" });
    // A plug the static file does not list gets no reading, whatever the dynamic one says of it.
    const t2Only = withStatus(
      { etat_prise_type_chademo: "hors_service" },
      { prise_type_2: "true" },
    );
    expect(readings(t2Only)).toEqual({ [PDC]: "available" });
    // A plug that works on a point out of service cannot be used.
    const down = withStatus({
      etat_pdc: "hors_service",
      etat_prise_type_2: "fonctionnel",
      etat_prise_type_ef: "inconnu",
    });
    expect(readings(down)).toEqual({
      [PDC]: "out_of_order",
      [`${PDC}/2`]: "out_of_order",
      [`${PDC}/ef`]: "out_of_order",
    });
  });
});

/**
 * Every boolean column, each of Table Schema's true and false values run
 * through the parser: true and false must land as the description says, and
 * no value may be passed over unread.
 */
describe("IRVE booleans through the parser", () => {
  const plugPresent = (id: string) => (out: ParseOutput, on: boolean) =>
    connectors(out).some((c) => c.id === id) === on;
  const paying = (method: string) => (out: ParseOutput, on: boolean) =>
    ((access(out)["payment"] as string[] | undefined) ?? []).includes(method) === on;
  const restricted = (to: string) => (out: ParseOutput, on: boolean) =>
    ((evse(out)?.details["parkingRestrictions"] as string[] | undefined) ?? []).includes(to) === on;
  /** The base point has a Type 2 plug only, without saying whether its cable is attached. */
  const BOOLEANS: Record<string, ((out: ParseOutput, on: boolean) => boolean) | string> = {
    prise_type_ef: plugPresent("ef"),
    prise_type_2: plugPresent("2"),
    prise_type_combo_ccs: plugPresent("combo_ccs"),
    prise_type_chademo: plugPresent("chademo"),
    prise_type_autre: plugPresent("autre"),
    gratuit: paying("free"),
    paiement_cb: paying("credit_card"),
    paiement_autre: paying("other"),
    // "Paiement à l'acte (sans identification ni abonnement)": ad hoc charging.
    paiement_acte: (out, on) => details(out)["adHocCharging"] === on,
    reservation: (out, on) =>
      ((evse(out)?.details["capabilities"] as string[] | undefined) ?? []).includes(
        "RESERVABLE",
      ) === on,
    station_deux_roues: restricted("motorcycles"),
    cable_t2_attache: (out, on) =>
      connectors(out).find((c) => c.id === "2")?.["format"] === (on ? "cable" : "socket"),
  };

  it("every boolean field of the static schema is covered here", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const booleans = statique.fields.filter((f) => f.type === "boolean").map((f) => f.name);
    expect(booleans.sort()).toEqual(Object.keys(BOOLEANS).sort());
  });

  it.for(Object.keys(BOOLEANS))(
    "%s: each true and false value lands as meant",
    (name, { skip }) => {
      if (unavailable) skip(unavailable);
      const values = booleanValues(fieldOf(statique, name));
      const check = BOOLEANS[name]!;
      const all = [...values.true, ...values.false];
      if (typeof check === "string") {
        // Unread: the column changes nothing the parser publishes.
        const blank = JSON.stringify(one({ [name]: "" }).features);
        assertCovered(name, all, {
          handled: (v) => JSON.stringify(one({ [name]: v }).features) !== blank,
          unsupported: Object.fromEntries(all.map((v) => [v, check])),
        });
        return;
      }
      assertCovered(name, all, {
        handled: (v) => {
          const out = one({ [name]: v });
          return noneUnread() && check(out, values.true.includes(v));
        },
      });
    },
  );
});

describe("IRVE organisations and commune", () => {
  it("the owner's SIREN and address, the operator's address and telephone, the INSEE commune", () => {
    const out = one({
      siren_amenageur: "130025265",
      contact_amenageur: "contact@societe-amenageur.com",
      contact_operateur: "contact@societe-operateur.com",
      telephone_operateur: "0111111111",
      code_insee_commune: "21231",
    });
    expect(site(out)).toMatchObject({
      owner: {
        role: "owner",
        ids: [{ scheme: "siren", id: "130025265" }],
        email: "contact@societe-amenageur.com",
      },
      operator: {
        role: "operator",
        email: "contact@societe-operateur.com",
        phone: "0111111111",
      },
      location: { admin: { country: "FR", geocodes: [{ scheme: "insee", code: "21231" }] } },
    });
    // Off the schema's patterns, the number and the code say nothing.
    const off = one({ siren_amenageur: "30119246", code_insee_commune: "2A1" });
    expect(site(off)?.["owner"]).not.toHaveProperty("ids");
    expect(site(off)?.["location"]).not.toHaveProperty("admin.geocodes");
  });
});

describe("IRVE opening hours", () => {
  it("the schema's own example and 24/7 read as OSM hours; other text stays the publisher's", ({
    skip,
  }) => {
    if (unavailable) skip(unavailable);
    const example = fieldOf(statique, "horaires") as { example?: string };
    const hours = (v: string) => site(one({ horaires: v }))?.["openingHours"];
    expect(example.example).toBe("Mo-Fr 08:00-12:00,Mo-Fr 14:00-18:00,Th 08:00-18:00");
    // Thursday's spans overlap, as the example writes them; OSM reads their union, 08:00-18:00.
    expect(hours(example.example!)).toMatchObject({
      osm: "Mo-We,Fr 08:00-12:00,14:00-18:00; Th 08:00-12:00,08:00-18:00,14:00-18:00",
    });
    expect(hours("24/7")).toMatchObject({ osm: "24/7" });
    const odd = one({ horaires: "Lundi 08:00-18:00" });
    expect(site(odd)?.["openingHours"]).toBeUndefined();
    expect(details(odd)["openingHoursText"]).toEqual([{ lang: "fr", text: "Lundi 08:00-18:00" }]);
  });
});

/**
 * Every field of both schemas is read or listed here as unread with the
 * reason. Read is proven by the parser: changing a read field to another
 * valid value changes what it publishes, and changing an unread one does not.
 */
describe("IRVE field coverage", () => {
  const UNREAD: Record<string, string> = {
    id_station_local:
      "unique only among its publisher's stations, not across the national consolidation; a station outside roaming is keyed by its position",
    nbre_pdc: "the station's charge points are its rows; their count adds nothing",
    restriction_gabarit:
      "free text without a grammar (`inconnu`, `Hauteur maximale 2m`); the model holds no vehicle size limit",
    raccordement: "the grid connection is the distribution network's arrangement, not the site's",
    num_pdl: "the grid delivery point number is the distribution network's",
    date_mise_en_service: "the model holds no commissioning date of a site",
    date_maj: "the model holds no publisher update date of a site",
  };
  /** Another valid value of each static field than the base row's. */
  const STATIC_ALT: Row = {
    nom_amenageur: "Société X",
    siren_amenageur: "130025265",
    contact_amenageur: "contact@societe-amenageur.com",
    nom_operateur: "Société Y",
    contact_operateur: "contact@societe-operateur.com",
    telephone_operateur: "0111111111",
    nom_enseigne: "Réseau de recharge ABC",
    id_station_itinerance: "FRA68P68021001",
    id_station_local: "01F2KMMRZVQ5FQY882PCJQAPQ0",
    nom_station: "Picpus",
    implantation_station: "Voirie",
    adresse_station: "1 avenue de la Paix 75001 Paris",
    code_insee_commune: "21231",
    coordonneesXY: "[7.48710500,48.345345]",
    nbre_pdc: "3",
    id_pdc_itinerance: "FRA68E680210015",
    id_pdc_local: "01F2KNFARDSJG7KEH1YHG4033M",
    puissance_nominale: "50",
    prise_type_ef: "true",
    prise_type_2: "false",
    prise_type_combo_ccs: "true",
    prise_type_chademo: "true",
    prise_type_autre: "true",
    gratuit: "true",
    paiement_acte: "false",
    paiement_cb: "false",
    paiement_autre: "false",
    tarification: "0,40€ / kwh pour les non abonnés.",
    condition_acces: "Accès réservé",
    reservation: "true",
    horaires: "24/7",
    accessibilite_pmr: "Réservé PMR",
    restriction_gabarit: "Hauteur maximale 2m",
    station_deux_roues: "true",
    raccordement: "Direct",
    num_pdl: "12345678912345",
    date_mise_en_service: "2021-12-30",
    observations: "Recharge uniquement disponible pendant les horaires d'ouverture",
    date_maj: "2021-12-30",
    cable_t2_attache: "true",
  };
  const DYNAMIC_ALT: Row = {
    id_pdc_itinerance: "FRA68E680210015",
    etat_pdc: "hors_service",
    occupation_pdc: "occupe",
    horodatage: "2026-10-06T02:00:00Z",
    etat_prise_type_2: "hors_service",
    etat_prise_type_combo_ccs: "hors_service",
    etat_prise_type_chademo: "hors_service",
    etat_prise_type_ef: "hors_service",
  };
  const DYNAMIC_FILLED: Row = {
    ...STATUS_BASE,
    etat_prise_type_2: "fonctionnel",
    etat_prise_type_combo_ccs: "fonctionnel",
    etat_prise_type_chademo: "fonctionnel",
    etat_prise_type_ef: "fonctionnel",
  };
  const published = (out: ParseOutput) => JSON.stringify([out.features, out.observations]);

  it("the alternative values differ from the base row's and are valid", ({ skip }) => {
    if (unavailable) skip(unavailable);
    expect(Object.keys(STATIC_ALT).sort()).toEqual(statique.fields.map((f) => f.name).sort());
    expect(Object.keys(DYNAMIC_ALT).sort()).toEqual(dynamique.fields.map((f) => f.name).sort());
    for (const [name, value] of Object.entries(STATIC_ALT)) {
      expect(value, name).not.toBe(BASE[name]);
      expect(
        validateTable(statique, csv(STATIC_HEADER, [{ ...BASE, [name]: value }])).errors,
        name,
      ).toEqual([]);
    }
    for (const [name, value] of Object.entries(DYNAMIC_ALT)) {
      expect(value, name).not.toBe(DYNAMIC_FILLED[name]);
      expect(
        validateTable(dynamique, csv(DYNAMIC_HEADER, [{ ...DYNAMIC_FILLED, [name]: value }]))
          .errors,
        name,
      ).toEqual([]);
    }
  });

  it("each static field is read exactly when it is not listed as unread", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const base = published(one());
    const read = statique.fields
      .map((f) => f.name)
      .filter((name) => published(one({ [name]: STATIC_ALT[name]! })) !== base);
    const unread = statique.fields.map((f) => f.name).filter((name) => !read.includes(name));
    expect(unread.sort()).toEqual(Object.keys(UNREAD).sort());
  });

  it("each dynamic field is read", ({ skip }) => {
    if (unavailable) skip(unavailable);
    const status = (row: Row) =>
      published(
        parse({
          main: [staticCsv({ ...BASE, ...ALL_PLUGS })],
          status: [Buffer.from(csv(DYNAMIC_HEADER, [row]))],
        }),
      );
    const base = status(DYNAMIC_FILLED);
    const unread = dynamique.fields
      .map((f) => f.name)
      .filter((name) => status({ ...DYNAMIC_FILLED, [name]: DYNAMIC_ALT[name]! }) === base);
    expect(unread).toEqual([]);
  });
});
