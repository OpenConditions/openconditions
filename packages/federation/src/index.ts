export type {
  ActorCapabilities,
  ActorConfig,
  ActorCoverage,
  ActorDocument,
  ActorPublicKey,
} from "./actor.js";
export {
  ACTIVITY_JSON,
  ACTOR_WELL_KNOWN_PATH,
  buildActorDocument,
  PEERS_WELL_KNOWN_PATH,
  parseActorConfig,
} from "./actor.js";
export type {
  AnomalyResult,
  DetectAnomalyOptions,
  PeerBaseline,
  PeerWindowStats,
  RawPeerWindow,
} from "./anomaly.js";
export { detectAnomaly, peerWindowStats } from "./anomaly.js";
export type { NegotiableCapabilities, NegotiatedCapabilities } from "./capabilities.js";
export { CapabilityNegotiationError, negotiateCapabilities } from "./capabilities.js";
export type { FederationFilter } from "./filter.js";
export { applyFederationFilter, DEFAULT_MIN_EVIDENCE_TIER, EVIDENCE_TIERS } from "./filter.js";
export type {
  FederationFailureReason,
  NonceStore,
  SignParams,
  VerifyParams,
  VerifyResult,
} from "./http-signature.js";
export {
  CLOCK_SKEW_SEC,
  EXPIRES_WINDOW_SEC,
  FEDERATION_REASON_HEADER,
  FEDERATION_TAG,
  federationFailureHeaders,
  InMemoryNonceStore,
  NONCE_TTL_SEC,
  signMessage,
  verifyMessage,
} from "./http-signature.js";
export type { InstanceKey } from "./keys.js";
export {
  ensureInstanceKey,
  generateInstanceKey,
  INSTANCE_KEY_VALIDITY_MONTHS,
  loadActiveKeys,
  ROTATION_OVERLAP_DAYS,
  rotateInstanceKey,
} from "./keys.js";
export type { MtlsContext, MtlsResult } from "./mtls.js";
export { checkMtls } from "./mtls.js";
export {
  base58btcDecode,
  base58btcEncode,
  ED25519_PUBLIC_KEY_BYTES,
  multibaseFromRawEd25519,
  rawEd25519FromMultibase,
} from "./multibase.js";
export type {
  OutboxCursor,
  OutboxEntry,
  OutboxOperation,
  OutboxPage,
  OutboxQuery,
} from "./outbox.js";
export {
  decodeOutboxCursor,
  encodeOutboxCursor,
  OUTBOX_CURSOR_START,
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_MAX_LIMIT,
  outboxEtag,
  readOutbox,
} from "./outbox.js";
export type { PruneOutboxOptions, PruneOutboxResult } from "./outbox-retention.js";
export {
  DEFAULT_OUTBOX_PRUNE_BATCH_SIZE,
  DEFAULT_OUTBOX_RETENTION_SEC,
  OUTBOX_PRUNE_INTERVAL_HOURS,
  OUTBOX_RETENTION_SAFETY_MARGIN_SEC,
  OUTBOX_RETENTION_TIER1_FLOOR_SEC,
  pruneOutbox,
} from "./outbox-retention.js";
export type { PeerAuthContext, PeerAuthRequest, PeerAuthResult } from "./peer-auth.js";
export { authenticatePeerRequest } from "./peer-auth.js";
export type { BlockedPeer, BlockPeerInput } from "./peer-blocklist.js";
export { blockPeer, isPeerBlocked, listBlockedPeers, unblockPeer } from "./peer-blocklist.js";
export type { PeerHealth, PeerHealthFailure, PeerHealthRow } from "./peer-health.js";
export {
  computePeerHealth,
  getPeerHealth,
  recordAvailability,
  recordPeerFailure,
  setEffectiveTierUntil,
} from "./peer-health.js";
export type { PeerRecord, PinVerification } from "./peers.js";
export { loadPeers, verifyActorAgainstPin } from "./peers.js";
export type { DeliverWebhookOptions, DeliverWebhookOutcome, WebhookCycleResult } from "./push.js";
export {
  deliverWebhook,
  isPriorityEntry,
  PRIORITY_EVENT_TYPES,
  PUSH_FAILURE_THRESHOLD,
  runWebhookDeliveryCycle,
} from "./push.js";
export type { PeerRatePolicy, RateCheckResult, RateLimiter, RateLimiterOptions } from "./rate.js";
export {
  createInMemoryRateLimiter,
  RATE_DOWNGRADE_COOLDOWN_SEC,
  RATE_DOWNGRADE_WINDOWS,
  RATE_MAX_PAGE_SIZE,
  RATE_WINDOW_MS,
  ratePolicyForTier,
} from "./rate.js";
export type { RegistryEntry, RegistryOperator } from "./registry.js";
export { parseRegistryEntry, registryEntryFileName, registryToPeerRecords } from "./registry.js";
export type { RegistrySyncOptions, RegistrySyncResult } from "./registry-sync.js";
export { mergePeerRecords, REGISTRY_SYNC_INTERVAL_HOURS, syncRegistry } from "./registry-sync.js";
export type {
  CreateSubscriptionInput,
  DeliveryMode,
  FederationSubscription,
  SubscriptionStatus,
  SubscriptionValidationCode,
  UpdateSubscriptionInput,
} from "./subscriptions.js";
export {
  createSubscription,
  DELIVERY_MODES,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  SubscriptionValidationError,
  updateSubscription,
  validateSubscriptionShape,
} from "./subscriptions.js";
export type {
  SignedRegistry,
  SignRegistryOptions,
  TufRoleConfig,
  TufRoleName,
} from "./tuf/repo.js";
export { DEFAULT_EXPIRY_DAYS, signRegistry, TUF_SPEC_VERSION } from "./tuf/repo.js";
export type { TufSigner } from "./tuf/signing.js";
export {
  generateTufSigner,
  tufKeyIdFromPublicKeyHex,
  tufSignerFromKeyPair,
} from "./tuf/signing.js";
export type { RegistryRepoSource, VerifyRegistryOptions } from "./tuf/verify.js";
export {
  repoSourceFromDir,
  TEST_ROOT_ALLOWED_ENVS,
  TEST_ROOT_MARKER,
  TestRootInProductionError,
  verifyRegistryMetadata,
} from "./tuf/verify.js";
