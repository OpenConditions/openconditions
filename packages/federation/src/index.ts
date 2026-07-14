export {
  ED25519_PUBLIC_KEY_BYTES,
  base58btcDecode,
  base58btcEncode,
  multibaseFromRawEd25519,
  rawEd25519FromMultibase,
} from "./multibase.js";
export {
  INSTANCE_KEY_VALIDITY_MONTHS,
  ROTATION_OVERLAP_DAYS,
  ensureInstanceKey,
  generateInstanceKey,
  loadActiveKeys,
  rotateInstanceKey,
} from "./keys.js";
export type { InstanceKey } from "./keys.js";
export {
  ACTIVITY_JSON,
  ACTOR_WELL_KNOWN_PATH,
  PEERS_WELL_KNOWN_PATH,
  buildActorDocument,
  parseActorConfig,
} from "./actor.js";
export type {
  ActorCapabilities,
  ActorConfig,
  ActorCoverage,
  ActorDocument,
  ActorPublicKey,
} from "./actor.js";
export { loadPeers, verifyActorAgainstPin } from "./peers.js";
export type { PeerRecord, PinVerification } from "./peers.js";
export { checkMtls } from "./mtls.js";
export type { MtlsContext, MtlsResult } from "./mtls.js";
export { CapabilityNegotiationError, negotiateCapabilities } from "./capabilities.js";
export type { NegotiableCapabilities, NegotiatedCapabilities } from "./capabilities.js";
export { DEFAULT_MIN_EVIDENCE_TIER, EVIDENCE_TIERS, applyFederationFilter } from "./filter.js";
export type { FederationFilter } from "./filter.js";
export {
  OUTBOX_CURSOR_START,
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_MAX_LIMIT,
  decodeOutboxCursor,
  encodeOutboxCursor,
  outboxEtag,
  readOutbox,
} from "./outbox.js";
export type {
  OutboxCursor,
  OutboxEntry,
  OutboxOperation,
  OutboxPage,
  OutboxQuery,
} from "./outbox.js";
export {
  CLOCK_SKEW_SEC,
  EXPIRES_WINDOW_SEC,
  FEDERATION_REASON_HEADER,
  FEDERATION_TAG,
  InMemoryNonceStore,
  NONCE_TTL_SEC,
  federationFailureHeaders,
  signMessage,
  verifyMessage,
} from "./http-signature.js";
export type {
  FederationFailureReason,
  NonceStore,
  SignParams,
  VerifyParams,
  VerifyResult,
} from "./http-signature.js";
export { authenticatePeerRequest } from "./peer-auth.js";
export type { PeerAuthContext, PeerAuthRequest, PeerAuthResult } from "./peer-auth.js";
export {
  DELIVERY_MODES,
  SubscriptionValidationError,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
  validateSubscriptionShape,
} from "./subscriptions.js";
export type {
  CreateSubscriptionInput,
  DeliveryMode,
  FederationSubscription,
  SubscriptionStatus,
  SubscriptionValidationCode,
  UpdateSubscriptionInput,
} from "./subscriptions.js";
export {
  PRIORITY_EVENT_TYPES,
  PUSH_FAILURE_THRESHOLD,
  deliverWebhook,
  isPriorityEntry,
  runWebhookDeliveryCycle,
} from "./push.js";
export type { DeliverWebhookOptions, DeliverWebhookOutcome, WebhookCycleResult } from "./push.js";
export {
  RATE_DOWNGRADE_COOLDOWN_SEC,
  RATE_DOWNGRADE_WINDOWS,
  RATE_MAX_PAGE_SIZE,
  RATE_WINDOW_MS,
  createInMemoryRateLimiter,
  ratePolicyForTier,
} from "./rate.js";
export type { PeerRatePolicy, RateCheckResult, RateLimiter, RateLimiterOptions } from "./rate.js";
export {
  computePeerHealth,
  getPeerHealth,
  recordAvailability,
  recordPeerFailure,
  setEffectiveTierUntil,
} from "./peer-health.js";
export type { PeerHealth, PeerHealthFailure, PeerHealthRow } from "./peer-health.js";
export { parseRegistryEntry, registryEntryFileName, registryToPeerRecords } from "./registry.js";
export type { RegistryEntry, RegistryOperator } from "./registry.js";
export { REGISTRY_SYNC_INTERVAL_HOURS, mergePeerRecords, syncRegistry } from "./registry-sync.js";
export type { RegistrySyncOptions, RegistrySyncResult } from "./registry-sync.js";
export {
  generateTufSigner,
  tufKeyIdFromPublicKeyHex,
  tufSignerFromKeyPair,
} from "./tuf/signing.js";
export type { TufSigner } from "./tuf/signing.js";
export { DEFAULT_EXPIRY_DAYS, TUF_SPEC_VERSION, signRegistry } from "./tuf/repo.js";
export type {
  SignRegistryOptions,
  SignedRegistry,
  TufRoleConfig,
  TufRoleName,
} from "./tuf/repo.js";
export {
  TEST_ROOT_ALLOWED_ENVS,
  TEST_ROOT_MARKER,
  TestRootInProductionError,
  repoSourceFromDir,
  verifyRegistryMetadata,
} from "./tuf/verify.js";
export type { RegistryRepoSource, VerifyRegistryOptions } from "./tuf/verify.js";
export { blockPeer, isPeerBlocked, listBlockedPeers, unblockPeer } from "./peer-blocklist.js";
export type { BlockedPeer, BlockPeerInput } from "./peer-blocklist.js";
export { detectAnomaly, peerWindowStats } from "./anomaly.js";
export type {
  AnomalyResult,
  DetectAnomalyOptions,
  PeerBaseline,
  PeerWindowStats,
  RawPeerWindow,
} from "./anomaly.js";
