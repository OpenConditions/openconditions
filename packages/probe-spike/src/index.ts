/**
 * @openconditions/probe-spike — NON-PRODUCTION feasibility spike.
 *
 * Proves the DAP/VDAF probe-submission crypto invariants against a maintained
 * VDAF implementation (DAP draft-09 / VDAF draft-08 via @divviup). This package
 * is private and isolated: no production service may depend on it, so the
 * draft-09/08 dependency never enters a production tree. See README.md.
 */
export {
  SPEED_MIN,
  SPEED_MAX,
  SUM_SPEED_BITS,
  type RegionSpec,
  type ProbeMeasurement,
  type EncodedReport,
  histogramChunkLength,
  cellCount,
  speedToBucket,
  measurementCell,
  histogramForRegion,
  sumForSpeed,
  encodePrivateSegment,
  encodeCoarsePartition,
  reportByteSize,
} from "./encoding.js";
export {
  type ShardedReport,
  type PreparedReport,
  shardStructured,
  prepareReport,
  aggregateBatch,
  freshVerifyKey,
} from "./aggregation.js";
export { type PublicMetadataDisclosure, PUBLIC_METADATA_DISCLOSURE } from "./disclosure.js";
export {
  type AggregatorEndpoint,
  type AggregatorTopology,
  SameOperatorHelperError,
  isSameOperator,
  assertHelperIndependentForProduction,
} from "./helperIndependence.js";
export {
  type ContributionContext,
  type TokenRedeemer,
  type ProbeSubmission,
  type AcceptanceRefusal,
  type ProbeAcceptance,
  PROBE_TOKENS_PER_EPOCH,
  ensureBatchSchema,
  batchKey,
  acceptProbeReport,
} from "./submissionGate.js";
export { type EncodeBenchmarkResult, runEncodeBenchmark } from "./benchmark.js";
