/**
 * @openconditions/probe-spike — NON-PRODUCTION feasibility spike.
 *
 * Proves the DAP/VDAF probe-submission crypto invariants against a maintained
 * VDAF implementation (DAP draft-09 / VDAF draft-08 via @divviup). This package
 * is private and isolated: no production service may depend on it, so the
 * draft-09/08 dependency never enters a production tree. See README.md.
 */

export {
  aggregateBatch,
  freshVerifyKey,
  type PreparedReport,
  prepareReport,
  type ShardedReport,
  shardStructured,
} from "./aggregation.js";
export { type EncodeBenchmarkResult, runEncodeBenchmark } from "./benchmark.js";
export { PUBLIC_METADATA_DISCLOSURE, type PublicMetadataDisclosure } from "./disclosure.js";
export {
  type BoundedSumCall,
  BudgetLedger,
  buildReleaseManifest,
  controlProjection,
  type DpMechanism,
  listPartitions,
  type MechanismCall,
  type MechanismControlProjection,
  OverlappingWindowError,
  type Partition,
  partitionKey,
  plannedPartitions,
  RecordingDpMechanism,
  type RecordingMechanismConfig,
  type ReleasedRow,
  type ReleaseFaults,
  type ReleaseManifest,
  type ReleaseManifestConfig,
  type ReleaseParams,
  type ReleaseResult,
  ReleaseStore,
  type ReleaseWindow,
  releaseWithDp,
  type SelectPartitionCall,
  SPEED_PUBLIC_LOWER,
  SPEED_PUBLIC_UPPER,
  type SpeedTuple,
  type SuppressedCell,
  type UnitBudget,
  type UnitSpend,
  windowForTimestamp,
} from "./dp/index.js";
export {
  cellCount,
  type EncodedReport,
  encodeCoarsePartition,
  encodePrivateSegment,
  histogramChunkLength,
  histogramForRegion,
  measurementCell,
  type ProbeMeasurement,
  type RegionSpec,
  reportByteSize,
  SPEED_MAX,
  SPEED_MIN,
  SUM_SPEED_BITS,
  speedToBucket,
  sumForSpeed,
} from "./encoding.js";
export {
  type AggregatorEndpoint,
  type AggregatorTopology,
  assertHelperIndependentForProduction,
  isSameOperator,
  SameOperatorHelperError,
} from "./helperIndependence.js";
export {
  type AcceptanceRefusal,
  acceptProbeReport,
  batchKey,
  type ContributionContext,
  ensureBatchSchema,
  PROBE_TOKENS_PER_EPOCH,
  type ProbeAcceptance,
  type ProbeSubmission,
  type TokenRedeemer,
} from "./submissionGate.js";
