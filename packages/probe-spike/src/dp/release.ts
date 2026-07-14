/**
 * The differential-privacy RELEASE GLUE — the layer where real DP-integration
 * bugs live, and the ONLY thing this spike proves. The glue owns clamping,
 * contribution bounding (one tuple per privacy unit per cell), cross-partition
 * contribution bounding, per-unit budget (fail-closed), idempotent retry, and the
 * data-independent partition schedule. The actual noise + accounting stay behind
 * `DpMechanism` (a recording double in tests). The glue makes NO
 * differential-privacy guarantee — it proves GLUE correctness only.
 *
 * The single load-bearing design choice: the glue queries EVERY public partition
 * unconditionally (one `selectPartition` then one `boundedSum` per cell, in the
 * manifest's fixed order), so the mechanism call sequence and query count are a
 * pure function of the manifest — never of the data. Suppression filters the
 * OUTPUT ROWS, not the query schedule. This is what makes the grey-box
 * add/remove-one-device-epoch audit pass BY CONSTRUCTION: two neighboring
 * datasets drive byte-identical call sequences, parameters, and control-flow
 * traces; only the data-bearing payloads (`values`, `rawCount`) and the emitted
 * rows differ.
 */
import { BudgetLedger, type UnitBudget, type UnitSpend } from "./budget.js";
import type { DpMechanism } from "./mechanism.js";
import {
  listPartitions,
  partitionKey,
  windowForTimestamp,
  type Partition,
  type ReleaseManifest,
} from "./manifest.js";

/** Public speed bound floor — clamped BEFORE the mechanism is ever called. */
export const SPEED_PUBLIC_LOWER = 0;
/** Public speed bound ceiling — a speed of 999 reaches the mechanism as 200. */
export const SPEED_PUBLIC_UPPER = 200;

/**
 * One raw input tuple. `privacyUnitId` is the opaque device-key epoch identity
 * (the admitted keyId + epoch); the glue needs only the identity to enforce
 * one-tuple-per-unit-per-cell and per-unit budget — never the key material.
 * `speed` is raw and may be out of range or NaN.
 */
export interface SpeedTuple {
  privacyUnitId: string;
  segmentId: string;
  timestampMs: number;
  speed: number;
}

/**
 * A released cell. It deliberately carries NO exact contributor count / `k` /
 * `sample_count`: the raw count is never published and never used as a public
 * divisor.
 */
export interface ReleasedRow {
  segmentId: string;
  windowId: string;
  /** The mechanism's (stand-in) noisy sum. Not asserted to be private. */
  noisySum: number;
}

/** An auditable record that a partition was evaluated but withheld. */
export interface SuppressedCell {
  segmentId: string;
  windowId: string;
}

export interface ReleaseResult {
  version: string;
  rows: ReleasedRow[];
  suppressed: SuppressedCell[];
  /** ε reported spent by the mechanism across the release (the library's number). */
  epsilonSpent: number;
  /** δ reported spent by the mechanism across the release. */
  deltaSpent: number;
  /** True when served from the durable committed marker (a retry). */
  retried: boolean;
  /** Ordered, data-independent control-flow trace of this release. */
  controlTrace: readonly string[];
}

export interface ReleaseParams {
  speedLower: number;
  speedUpper: number;
  epsilonSum: number;
  epsilonSelect: number;
  deltaSelect: number;
  /** Cross-partition contribution bound: max cells one unit may influence. */
  maxPartitionsPerUnit: number;
  /** Per-privacy-unit budget ceiling (basic sequential composition floor). */
  budget: UnitBudget;
}

/**
 * Test-only fault injection. Every flag DISABLES one safeguard so a guard test
 * can prove the safeguard is load-bearing: with the fault set, the corresponding
 * invariant assertion must trip. Production never sets any of these.
 */
export interface ReleaseFaults {
  /** Skip clamping — lets an out-of-range / NaN value reach the mechanism. */
  skipClamp?: boolean;
  /** Skip the one-tuple-per-unit-per-cell bound. */
  skipContributionBound?: boolean;
  /** Skip the cross-partition contribution bound. */
  skipPartitionBound?: boolean;
  /** Skip the per-unit budget check (never fail closed). */
  skipBudget?: boolean;
  /** Ignore the durable committed marker — re-samples fresh noise on retry. */
  ignoreRetryMarker?: boolean;
  /** Scale ε by the raw count — a data-dependent noise scale. */
  dataDependentEpsilon?: boolean;
  /** Scale the selection ε by the raw count — a data-dependent threshold. */
  dataDependentThreshold?: boolean;
  /**
   * Iterate only partitions that have data instead of the fixed manifest grid —
   * the canonical data-dependent LOOP-COUNT bug. Under this fault the query count
   * and control-flow trace depend on which cells are non-empty, so a neighboring
   * dataset that populates a previously-empty cell diverges.
   */
  skipEmptyPartitions?: boolean;
}

/**
 * The durable "released" marker + committed result store. Idempotent retry reads
 * from here: a second release for the same manifest version returns the already
 * committed result and re-invokes NOTHING. In production this is a transactional
 * table; here it is an in-process map, which is enough to prove the glue never
 * samples fresh noise or spends budget twice on retry.
 */
export class ReleaseStore {
  private readonly committed = new Map<string, ReleaseResult>();

  get(version: string): ReleaseResult | undefined {
    return this.committed.get(version);
  }

  has(version: string): boolean {
    return this.committed.has(version);
  }

  commit(version: string, result: ReleaseResult): void {
    this.committed.set(version, result);
  }
}

interface CellTuple {
  privacyUnitId: string;
  clampedSpeed: number;
}

function clampSpeed(raw: number, lower: number, upper: number): number {
  if (!Number.isFinite(raw)) return lower;
  return Math.min(upper, Math.max(lower, raw));
}

/**
 * Groups raw tuples into the fixed partition grid: clamps every speed, drops
 * tuples outside the public segment domain or every window, applies the
 * one-per-unit-per-cell bound, then the cross-partition bound, then the
 * fail-closed per-unit budget. Returns clamped/bounded values keyed by partition
 * plus the per-unit charge to commit. All control flow here is partition-level or
 * unit-level bookkeeping — it never emits into the control trace, so adding one
 * device epoch changes only payloads, not structure.
 */
function shapeContributions(
  dataset: readonly SpeedTuple[],
  manifest: ReleaseManifest,
  params: ReleaseParams,
  ledger: BudgetLedger,
  faults: ReleaseFaults
): { byPartition: Map<string, CellTuple[]>; charges: Map<string, UnitSpend> } {
  const segmentDomain = new Set(manifest.segmentIds);
  const perCellCost: UnitSpend = {
    epsilon: params.epsilonSum + params.epsilonSelect,
    delta: params.deltaSelect,
  };

  // 1. Clamp + assign to a partition; drop anything off the fixed grid.
  const assigned: { key: string; privacyUnitId: string; clampedSpeed: number }[] = [];
  for (const tuple of dataset) {
    if (!segmentDomain.has(tuple.segmentId)) continue;
    const window = windowForTimestamp(manifest, tuple.timestampMs);
    if (!window) continue;
    const clampedSpeed = faults.skipClamp
      ? tuple.speed
      : clampSpeed(tuple.speed, params.speedLower, params.speedUpper);
    const key = partitionKey({ segmentId: tuple.segmentId, windowId: window.windowId });
    assigned.push({ key, privacyUnitId: tuple.privacyUnitId, clampedSpeed });
  }

  // 2. One tuple per unit per cell (deterministic representative).
  const perCellUnitPick = new Map<string, Map<string, number>>();
  const deduped: { key: string; privacyUnitId: string; clampedSpeed: number }[] = [];
  const stable = [...assigned].sort(
    (a, b) =>
      a.key.localeCompare(b.key) ||
      a.privacyUnitId.localeCompare(b.privacyUnitId) ||
      a.clampedSpeed - b.clampedSpeed
  );
  for (const item of stable) {
    if (!faults.skipContributionBound) {
      let units = perCellUnitPick.get(item.key);
      if (!units) {
        units = new Map();
        perCellUnitPick.set(item.key, units);
      }
      if (units.has(item.privacyUnitId)) continue;
      units.set(item.privacyUnitId, item.clampedSpeed);
    }
    deduped.push(item);
  }

  // 3. Cross-partition bound: a unit influences at most maxPartitionsPerUnit cells.
  const unitCells = new Map<string, Set<string>>();
  for (const item of deduped) {
    let cells = unitCells.get(item.privacyUnitId);
    if (!cells) {
      cells = new Set();
      unitCells.set(item.privacyUnitId, cells);
    }
    cells.add(item.key);
  }
  const unitAllowedCells = new Map<string, Set<string>>();
  for (const [unit, cells] of unitCells) {
    const ordered = [...cells].sort();
    const kept = faults.skipPartitionBound
      ? ordered
      : ordered.slice(0, params.maxPartitionsPerUnit);
    unitAllowedCells.set(unit, new Set(kept));
  }

  // 4. Fail-closed per-unit budget over the cells the unit still influences.
  const charges = new Map<string, UnitSpend>();
  const unitAdmitted = new Map<string, boolean>();
  for (const [unit, allowed] of unitAllowedCells) {
    if (faults.skipBudget) {
      unitAdmitted.set(unit, true);
      continue;
    }
    const cost: UnitSpend = {
      epsilon: perCellCost.epsilon * allowed.size,
      delta: perCellCost.delta * allowed.size,
    };
    if (ledger.canAfford(unit, cost)) {
      charges.set(unit, cost);
      unitAdmitted.set(unit, true);
    } else {
      unitAdmitted.set(unit, false); // exhausted → suppressed, fail closed
    }
  }

  // 5. Materialize the surviving per-partition values.
  const byPartition = new Map<string, CellTuple[]>();
  for (const item of deduped) {
    const allowed = unitAllowedCells.get(item.privacyUnitId);
    if (!allowed || !allowed.has(item.key)) continue;
    if (unitAdmitted.get(item.privacyUnitId) === false) continue;
    let bucket = byPartition.get(item.key);
    if (!bucket) {
      bucket = [];
      byPartition.set(item.key, bucket);
    }
    bucket.push({ privacyUnitId: item.privacyUnitId, clampedSpeed: item.clampedSpeed });
  }

  return { byPartition, charges };
}

/**
 * Runs one release over the fixed manifest. Idempotent per `manifest.version`.
 * The mechanism is queried once per public partition (select + sum,
 * unconditionally, in fixed order); rows are emitted only for partitions the
 * mechanism releases. On a retry (version already committed) it returns the
 * committed result and invokes the mechanism zero times, spending no budget.
 */
export function releaseWithDp(
  dataset: readonly SpeedTuple[],
  manifest: ReleaseManifest,
  params: ReleaseParams,
  mechanism: DpMechanism,
  ledger: BudgetLedger,
  store: ReleaseStore,
  faults: ReleaseFaults = {}
): ReleaseResult {
  if (!faults.ignoreRetryMarker && store.has(manifest.version)) {
    const committed = store.get(manifest.version)!;
    return { ...committed, retried: true };
  }

  const trace: string[] = [];
  trace.push(`begin version=${manifest.version}`);
  trace.push(`clamp-bounds lower=${params.speedLower} upper=${params.speedUpper}`);

  const { byPartition, charges } = shapeContributions(dataset, manifest, params, ledger, faults);

  // Correct glue iterates the fixed manifest grid unconditionally so the query
  // schedule is a pure function of the manifest. The skipEmptyPartitions fault
  // makes the loop data-dependent (only non-empty cells), which the grey-box
  // audit must catch on a neighboring dataset that fills a previously-empty cell.
  const grid = listPartitions(manifest);
  const partitions = faults.skipEmptyPartitions
    ? grid.filter((p) => (byPartition.get(partitionKey(p)) ?? []).length > 0)
    : grid;
  const rows: ReleasedRow[] = [];
  const suppressed: SuppressedCell[] = [];
  let epsilonSpent = 0;
  let deltaSpent = 0;

  for (const partition of partitions) {
    const key = partitionKey(partition);
    trace.push(`partition ${key}`);
    const cellTuples = byPartition.get(key) ?? [];
    const values = cellTuples.map((t) => t.clampedSpeed);
    const rawCount = values.length;

    trace.push("query select");
    // A data-dependent threshold surfaces as a selection ε that varies with the
    // raw count — visible in the mechanism's control projection, so the audit
    // catches it. (1 + rawCount) is sensitive at the 0→1 boundary a neighbor hits.
    const selectEpsilon = faults.dataDependentThreshold
      ? params.epsilonSelect * (1 + rawCount)
      : params.epsilonSelect;
    const selection = mechanism.selectPartition(rawCount, selectEpsilon, params.deltaSelect);
    epsilonSpent += selection.epsilonSpent;
    deltaSpent += selection.deltaSpent;

    const sumEpsilon = faults.dataDependentEpsilon
      ? params.epsilonSum * (1 + rawCount)
      : params.epsilonSum;
    trace.push("query sum");
    const sum = mechanism.boundedSum(values, params.speedLower, params.speedUpper, sumEpsilon);
    epsilonSpent += sum.epsilonSpent;

    if (selection.released) {
      rows.push({
        segmentId: partition.segmentId,
        windowId: partition.windowId,
        noisySum: sum.value,
      });
    } else {
      suppressed.push({ segmentId: partition.segmentId, windowId: partition.windowId });
    }
  }

  for (const [unit, cost] of charges) {
    ledger.charge(unit, cost);
  }

  trace.push("commit");
  const result: ReleaseResult = {
    version: manifest.version,
    rows,
    suppressed,
    epsilonSpent,
    deltaSpent,
    retried: false,
    controlTrace: trace,
  };
  store.commit(manifest.version, result);
  return result;
}

/** The public partition grid a release will query (for pre-audit inspection). */
export function plannedPartitions(manifest: ReleaseManifest): Partition[] {
  return listPartitions(manifest);
}
