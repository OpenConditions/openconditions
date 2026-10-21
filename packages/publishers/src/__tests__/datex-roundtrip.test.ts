import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pinnedOrUnavailable, type SchemaFile, xsdErrors } from "@openconditions/conformance";
import {
  DATEX2_V3,
  MESSAGE_CONTAINER_SCHEMA,
} from "@openconditions/conformance/standards/datex2-v3";
import { readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { parseEvents, type RoadFeed, roadsDomain } from "@openconditions/roads";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExportDiagnostic } from "../export-diagnostics.js";
import { datexRecordsOf, situationsToDatex } from "../situation-datex.js";

type Rec = Record<string, unknown>;

/**
 * DATEX II round trip of every real situation fixture: the source is parsed
 * into situations (pass 1), exported with `situationsToDatex` at its own
 * publication time, validated against the pinned DATEX II v3.7 schemas, and
 * read back with the same parser (pass 2). Pass 2 must hold what pass 1 held,
 * except what the export generates itself (`GENERATED`) and what it cannot
 * express (`CANNOT_EXPRESS`, each with the fixtures it shows in). Either list
 * failing to match, an entry missing or an entry left over, fails the test:
 * a new loss shows up as an unlisted difference, a fix as a stale entry.
 */
const registry = buildRegistry([kernelModule, roadsModule]);
const FIXTURES = "../../../roads/src/__tests__/fixtures/";
const REPO_FEEDS = fileURLToPath(new URL("../../../../feeds", import.meta.url));

/** A road feed of the catalogue, read as a complete snapshot (the path that carries versions). */
function feed(id: string): RoadFeed {
  const { files } = readCatalogDir(REPO_FEEDS, [roadsDomain], { otherDomains: "ignore" });
  const found = files
    .flatMap((file) =>
      file.feeds.map((def) =>
        toCatalogFeed(def, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }),
      ),
    )
    .find((f) => f.id === id);
  if (!found) throw new Error(`no feed ${id}`);
  return { ...found, snapshot: { completeness: "complete" } } as RoadFeed;
}

/** Every DATEX situation fixture (v2, v3, the DGT profile) with the feed that reads it. */
const CASES: [name: string, feed: string, fixture: string][] = [
  ["dgt", "es-dgt-events", "dgt-es/situations.xml"],
  ["dir", "fr-dir-events", "dir-fr/situations.xml"],
  ["cita", "lu-cita-events", "cita-lu/situations.xml"],
  ["flanders", "be-flanders-events", "flanders-be/situations.xml"],
  ["hc", "hr-hc-events", "hc-hr/events.datex3.xml"],
  ["ndw-restrictions", "nl-ndw-events", "ndw/restrictions-v3.xml"],
  ["ndw", "nl-ndw-events", "ndw/actueel_beeld.xml"],
  ["vild", "nl-ndw-events", "vild/ndw-method2-points.xml"],
];

/**
 * What the export writes of its own and pass 2 therefore reads differently,
 * by design. These paths are not compared.
 */
const GENERATED: Record<string, string> = {
  "/id": "The export's situation id is the OpenConditions id, so pass 2 prefixes it again.",
  "/externalIds": "Pass 2's DATEX situation id is pass 1's OpenConditions id.",
  "/provenance/recordId": "The source-local id pass 2 reads is pass 1's OpenConditions id.",
  "/provenance/recordVersion":
    "Every exported record carries the situation's revision as its version.",
  "/canonicalId": "Derived from the id.",
  "/contentHash": "Derived from the whole record.",
  "/freshness": "The fetch time of each pass.",
  "/effects/*/sourceRecordRef version":
    "A record keeps its source id; its version is the situation's revision (compared without it).",
};

/**
 * Differences the export cannot avoid, keyed by the pass-1 path that changes
 * (indices as `*`, effects by kind), a withheld situation by its reason
 * (`withheld:<code>`), a situation with no record by its reason
 * (`missing:<code>`); each with why and the fixtures it shows in.
 */
const CANNOT_EXPRESS: Record<string, { reason: string; fixtures: string[] }> = {
  "withheld:vehicle_specific_effect": {
    reason:
      "The emitter has no mapping from the kernel's vehicle applicability to DATEX `forVehiclesWithCharacteristicsOf`; exporting the effect without it would widen it to every vehicle, so the situation is withheld.",
    fixtures: ["dgt", "dir", "ndw", "ndw-restrictions"],
  },
  "withheld:restriction_evidence": {
    reason:
      "Incomplete normalization or unknown applicability has no DATEX form: a DATEX measure states its vehicles or applies to all.",
    fixtures: ["dgt", "dir", "ndw"],
  },
  "missing:effect_ended": {
    reason:
      "The export is a snapshot at its instant: an effect already ended (its end before the publication time) has no record, and a situation of nothing else has none.",
    fixtures: ["dir"],
  },
  "/planned": {
    reason:
      "No DATEX element: the reader derives it from the leading record's class. Pass 1 led with a management record, the export leads with the nature record (MaintenanceWorks reads as planned).",
    fixtures: ["dgt", "flanders", "ndw", "vild"],
  },
  "/severity/source": {
    reason:
      "A severity the reader derived is written as the publication's own `severity`, so pass 2 reads it as declared.",
    fixtures: ["cita", "dgt", "flanders", "ndw"],
  },
  "/severity/declaredRaw": {
    reason: "The raw token pass 2 reads is the label the export wrote (see /severity/source).",
    fixtures: ["cita", "dgt", "flanders", "ndw"],
  },
  "/subtype": {
    reason:
      "Roadworks of no stated kind: DATEX `Roadworks` is abstract, and its MaintenanceWorks reads as maintenance.",
    fixtures: ["dgt", "flanders"],
  },
  "/location/tmc": {
    reason:
      "An Alert-C reference coded both ways (DATEX v2 `both`): the model's direction bit and DATEX v3's `alertCDirectionCoded` hold only positive or negative, and the reference cannot be written without one.",
    fixtures: ["dir"],
  },
  "/effects/contraflow/sourceRecordRef": {
    reason:
      "One DATEX record has one management type: a source record read as a lane restriction and a contraflow is written as two records, the second named after its effect.",
    fixtures: ["dir"],
  },
  "/effects/contraflow/id": {
    reason: "The effect id follows its record id (see /effects/contraflow/sourceRecordRef).",
    fixtures: ["dir"],
  },
  "/effects/delay/sourceRecordRef": {
    reason:
      "A delay travels as the supplement of the record it was read with; where that record is the nature record (which DATEX writes under the situation's id), it takes that id.",
    fixtures: ["flanders"],
  },
  "/effects/delay/id": {
    reason: "The effect id follows its record id (see /effects/delay/sourceRecordRef).",
    fixtures: ["flanders"],
  },
};

const IGNORED = new Set(Object.keys(GENERATED).filter((k) => !k.includes(" ")));
/** Degrees two coordinates may differ by and still be one place. */
const TOLERANCE = 1e-7;

/** Differences between two values, as normalised paths. */
function differences(a: unknown, b: unknown, path: string, out: Set<string>): void {
  const key = path.replace(/\/\d+/g, "/*");
  if (IGNORED.has(key)) return;
  if (typeof a === "number" && typeof b === "number" && path.includes("/coordinates")) {
    if (Math.abs(a - b) > TOLERANCE) out.add(key);
    return;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const objects = a !== null && b !== null && typeof a === "object" && typeof b === "object";
  if (!objects || Array.isArray(a) !== Array.isArray(b)) {
    out.add(key);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
    out.add(key);
    return;
  }
  const x = a as Rec;
  const y = b as Rec;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)]))
    differences(x[k], y[k], `${path}/${k}`, out);
}

/** A record reference without the version the assembler appends. */
const recordOf = (ref: unknown) => (typeof ref === "string" ? ref.replace(/\/\d+$/, "") : ref);

function effectsOf(s: Rec): Rec[] {
  const phases = ((s["details"] as Rec | undefined)?.["phases"] as Rec[] | undefined) ?? [];
  return [...(s["effects"] as Rec[]), ...phases.flatMap((p) => (p["effects"] as Rec[]) ?? [])];
}

/** Pass-1 effects paired with pass 2's: by source record and kind, else by kind in order. */
function pairs(first: Rec[], second: Rec[]): [Rec | undefined, Rec | undefined][] {
  const used = new Set<number>();
  const take = (match: (e: Rec) => boolean) => {
    const i = second.findIndex((e, j) => !used.has(j) && match(e));
    if (i >= 0) used.add(i);
    return i >= 0 ? second[i] : undefined;
  };
  const out: [Rec | undefined, Rec | undefined][] = first.map((e) => [
    e,
    take(
      (f) =>
        f["kind"] === e["kind"] &&
        recordOf(f["sourceRecordRef"]) === recordOf(e["sourceRecordRef"]),
    ) ?? take((f) => f["kind"] === e["kind"]),
  ]);
  for (const [j, f] of second.entries()) if (!used.has(j)) out.push([undefined, f]);
  return out;
}

/** What pass 2 changed of one pass-1 situation. */
function situationDifferences(first: Rec, second: Rec): Set<string> {
  const out = new Set<string>();
  const without = (s: Rec) => {
    const details = s["details"] as Rec | undefined;
    const { phases: _, ...rest } = details ?? {};
    return { ...s, effects: undefined, details: details && { ...rest } };
  };
  differences(without(first), without(second), "", out);
  for (const [e, f] of pairs(effectsOf(first), effectsOf(second))) {
    if (!e) out.add(`/effects/+${String(f!["kind"])}`);
    else if (!f) out.add(`/effects/-${String(e["kind"])}`);
    else {
      const comparable = (x: Rec) => ({ ...x, sourceRecordRef: recordOf(x["sourceRecordRef"]) });
      differences(comparable(e), comparable(f), `/effects/${String(e["kind"])}`, out);
    }
  }
  return new Set(
    [...out].map((p) =>
      p
        .replace(/^\/effects\/[a-z_]+\/location\/tmc$/, "/effects/*/location/tmc")
        .replace(/^\/effects\/[a-z_]+\/location$/, "/effects/*/location"),
    ),
  );
}

const seal = (draft: Rec) => {
  const sealed = sealRecord(registry, draft, {
    instanceId: "roundtrip.test",
    revision: 1,
    recordedAt: "2026-09-18T10:00:00.000Z",
  });
  if (!sealed.ok) throw new Error(`${String(draft["id"])}: ${JSON.stringify(sealed.issues)}`);
  return sealed.value as Rec;
};

describe("DATEX II round trip of the real situation fixtures", () => {
  let schemas: SchemaFile[] = [];
  let unavailable: string | undefined;
  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(DATEX2_V3);
    if ("files" in pinned) schemas = pinned.files;
    else unavailable = pinned.unavailable;
  }, 120_000);

  const observed = new Map<string, Set<string>>();
  const coverage: Record<string, Rec> = {};

  it.each(CASES)(
    "%s: exports schema-valid DATEX that reads back as pass 1",
    {
      timeout: 120_000,
    },
    async (name, feedId, fixture) => {
      const source = feed(feedId);
      const input = readFileSync(new URL(`${FIXTURES}${fixture}`, import.meta.url));
      const published = /publicationTime>([^<]+)</.exec(input.toString())?.[1];
      const at = new Date(published!);
      const fetchedAt = at.toISOString();
      const parsed = parseEvents(source, [input], { fetchedAt });
      const first = parsed.situations.map(seal);
      expect(first.length).toBeGreaterThan(0);

      const diagnostics: ExportDiagnostic[] = [];
      for (const s of first) datexRecordsOf(s, at, (d) => diagnostics.push(d));
      const xml = situationsToDatex(first, at, { timestamp: fetchedAt }, source.region);
      if (!unavailable) {
        expect(await xsdErrors(xml, schemas, MESSAGE_CONTAINER_SCHEMA, `${name}.xml`)).toEqual([]);
      }
      const second = parseEvents(source, [Buffer.from(xml)], { fetchedAt }).situations.map(seal);

      const note = (key: string) => {
        const fixtures = observed.get(key) ?? new Set();
        observed.set(key, fixtures.add(name));
      };
      const byOrigin = new Map(
        second.map((s) => [(s["externalIds"] as { id: string }[])[0]?.id, s] as const),
      );
      let exported = 0;
      for (const s of first) {
        const own = diagnostics.filter((d) => d.situationId === s["id"]);
        const withheld = own.filter((d) => d.disposition === "withheld");
        const back = byOrigin.get(s["id"] as string);
        byOrigin.delete(s["id"] as string);
        if (withheld.length > 0) {
          expect(back, String(s["id"])).toBeUndefined();
          for (const d of withheld) note(`withheld:${d.code}`);
        } else if (back === undefined) {
          for (const d of own) note(`missing:${d.code}`);
        } else {
          exported++;
          for (const key of situationDifferences(s, back)) note(key);
        }
      }
      // Pass 2 holds no situation pass 1 did not.
      expect([...byOrigin.keys()]).toEqual([]);
      coverage[name] = {
        sourceRecords: parsed.records?.inputCount,
        accepted: parsed.records?.accepted,
        situations: first.length,
        exported,
      };
    },
  );

  it("differs only where the export cannot express pass 1, and in every such place", () => {
    const seen = Object.fromEntries(
      [...observed].map(([key, fixtures]) => [key, [...fixtures].sort()]),
    );
    expect(seen).toEqual(
      Object.fromEntries(
        Object.entries(CANNOT_EXPRESS).map(([key, { fixtures }]) => [key, [...fixtures].sort()]),
      ),
    );
  });

  it("covers every record of every fixture pass 1 accepted", () => {
    expect(coverage).toMatchInlineSnapshot(`
      {
        "cita": {
          "accepted": 7,
          "exported": 5,
          "situations": 5,
          "sourceRecords": 7,
        },
        "dgt": {
          "accepted": 9,
          "exported": 4,
          "situations": 6,
          "sourceRecords": 9,
        },
        "dir": {
          "accepted": 8,
          "exported": 2,
          "situations": 5,
          "sourceRecords": 8,
        },
        "flanders": {
          "accepted": 4,
          "exported": 4,
          "situations": 4,
          "sourceRecords": 4,
        },
        "hc": {
          "accepted": 3,
          "exported": 3,
          "situations": 3,
          "sourceRecords": 3,
        },
        "ndw": {
          "accepted": 853,
          "exported": 394,
          "situations": 435,
          "sourceRecords": 853,
        },
        "ndw-restrictions": {
          "accepted": 6,
          "exported": 1,
          "situations": 4,
          "sourceRecords": 6,
        },
        "vild": {
          "accepted": 9,
          "exported": 5,
          "situations": 5,
          "sourceRecords": 9,
        },
      }
    `);
  });
});
