import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { publicVerif } from "@cloudflare/privacypass-ts";
import { generateReporterKey } from "@openconditions/contrib-core";
import { runMigrations } from "@openconditions/core/server";
import { enrollReporter } from "../attester/enroll.js";
import { redemptionContext, type PublicContext } from "../issuer/context.js";
import { issueToken } from "../issuer/issue.js";
import {
  DEFAULT_ISSUER_NAME,
  generateIssuerKey,
  loadActiveIssuerKeys,
  overlappingTruncatedKeyIds,
} from "../issuer/keys.js";
import { TokenVerifier } from "../issuer/verify.js";

const { BlindRSAMode, Client, Issuer, Origin, TokenResponse, getPublicKeyBytes } = publicVerif;

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET = new TextEncoder().encode("issuer-key-collision-test-secret");

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 10 });
  await runMigrations(url);
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

type KeyPair = Awaited<ReturnType<typeof Issuer.generateKey>>;

async function genKeyPair(): Promise<KeyPair> {
  return Issuer.generateKey(BlindRSAMode.PSS, {
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  });
}

async function truncByteOf(pair: KeyPair): Promise<number> {
  const pub = await getPublicKeyBytes(pair.publicKey);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", pub as BufferSource)
  );
  return digest[digest.length - 1]!;
}

async function keyIdOf(pair: KeyPair): Promise<string> {
  const pub = await getPublicKeyBytes(pair.publicKey);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", pub as BufferSource)
  );
  return Buffer.from(digest).toString("hex");
}

/** Generate `n` keypairs whose truncated token-key-id bytes are pairwise distinct. */
async function distinctKeyPairs(n: number): Promise<KeyPair[]> {
  const out: KeyPair[] = [];
  const seen = new Set<number>();
  while (out.length < n) {
    const pair = await genKeyPair();
    const b = await truncByteOf(pair);
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(pair);
  }
  return out;
}

/** A keypair generator that hands back a scripted sequence and counts calls. */
function scriptedGenerator(sequence: KeyPair[]) {
  const state = { calls: 0 };
  const generate = async (): Promise<KeyPair> => {
    const pair = sequence[Math.min(state.calls, sequence.length - 1)]!;
    state.calls += 1;
    return pair;
  };
  return { generate, state };
}

/** Assemble `size` DISTINCT keypairs that all share one truncated token-key-id byte. */
async function collidingGroup(size: number): Promise<{ byte: number; pairs: KeyPair[] }> {
  const buckets = new Map<number, KeyPair[]>();
  for (let i = 0; i < 4000; i++) {
    const pair = await genKeyPair();
    const b = await truncByteOf(pair);
    const arr = buckets.get(b) ?? [];
    arr.push(pair);
    buckets.set(b, arr);
    if (arr.length >= size) return { byte: b, pairs: arr.slice(0, size) };
  }
  throw new Error(`could not assemble a colliding group of ${size}`);
}

/** `n` keypairs with pairwise-distinct truncated bytes, none in `avoid`. */
async function distinctSingles(n: number, avoid: Set<number>): Promise<KeyPair[]> {
  const out: KeyPair[] = [];
  const seen = new Set<number>(avoid);
  while (out.length < n) {
    const pair = await genKeyPair();
    const b = await truncByteOf(pair);
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(pair);
  }
  return out;
}

/**
 * A one-shot barrier that holds every arriver until either `n` have arrived
 * (all concurrent readers have passed the reserved-set read) or `timeoutMs`
 * elapses. The timeout is what keeps a correctly SERIALIZED implementation from
 * deadlocking: under the advisory lock only one call reaches the barrier at a
 * time, so it never fills — the timeout releases the first holder, and every
 * later arriver sees an already-resolved gate and proceeds immediately.
 */
function windowBarrier(n: number, timeoutMs: number) {
  let arrived = 0;
  let release!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (): Promise<void> => {
    arrived += 1;
    if (arrived >= n) {
      if (timer) clearTimeout(timer);
      release();
    } else if (timer === undefined) {
      timer = setTimeout(release, timeoutMs);
    }
    await gate;
  };
}

/**
 * Like `scriptedGenerator` but waits on `barrier` the FIRST time it is called
 * (i.e. right after generateIssuerKey has read the reserved set). This widens
 * the read→insert window deterministically — standing in for the real
 * RSA-keygen latency — so concurrent unserialized calls all observe a stale
 * reserved set. Retries (a serialized loser regenerating) do not re-block.
 */
function barrieredGenerator(sequence: KeyPair[], barrier: () => Promise<void>) {
  const state = { calls: 0 };
  const generate = async (): Promise<KeyPair> => {
    if (state.calls === 0) await barrier();
    const pair = sequence[Math.min(state.calls, sequence.length - 1)]!;
    state.calls += 1;
    return pair;
  };
  return { generate, state };
}

describe("truncated-key-id reserved-byte derivation", () => {
  it("the last hex byte of key_id equals loadActiveIssuerKeys' truncatedTokenKeyId", async () => {
    const { keyId } = await generateIssuerKey(sql, NOW);
    const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
    const key = keys.find((k) => k.keyId === keyId)!;
    expect(parseInt(keyId.slice(-2), 16)).toBe(key.truncatedTokenKeyId);
  }, 60_000);
});

describe("generateIssuerKey truncated-id collision avoidance", () => {
  it("regenerates when a candidate collides with an overlapping active key", async () => {
    const window = {
      notBefore: "2031-01-01T00:00:00.000Z",
      notAfter: "2031-04-01T00:00:00.000Z",
    };
    const [k1, k2] = await distinctKeyPairs(2);

    // Seed one active key in the window; it inserts cleanly (no collision yet).
    const seed = scriptedGenerator([k1!]);
    await generateIssuerKey(sql, NOW, { ...window, generateKeyPair: seed.generate });
    expect(seed.state.calls).toBe(1);

    // The next candidate collides (same keypair/byte) and MUST be regenerated.
    const colliding = scriptedGenerator([k1!, k2!]);
    const created = await generateIssuerKey(sql, NOW, {
      ...window,
      generateKeyPair: colliding.generate,
    });

    expect(colliding.state.calls).toBe(2); // first candidate rejected, retry accepted
    expect(created.keyId).toBe(await keyIdOf(k2!));

    // Both overlapping keys are stored with DISTINCT truncated bytes.
    const reserved = await overlappingTruncatedKeyIds(
      sql,
      new Date(window.notBefore),
      new Date(window.notAfter)
    );
    expect(reserved.size).toBe(2);
    expect(reserved.has(await truncByteOf(k1!))).toBe(true);
    expect(reserved.has(await truncByteOf(k2!))).toBe(true);
  }, 120_000);

  it("fails closed (throws) when no free truncated byte can be found", async () => {
    const window = {
      notBefore: "2032-01-01T00:00:00.000Z",
      notAfter: "2032-04-01T00:00:00.000Z",
    };
    const [k1] = await distinctKeyPairs(1);
    const seed = scriptedGenerator([k1!]);
    await generateIssuerKey(sql, NOW, { ...window, generateKeyPair: seed.generate });

    // Every candidate collides with the seeded key; bounded retries then throw.
    const stuck = scriptedGenerator([k1!]);
    await expect(
      generateIssuerKey(sql, NOW, {
        ...window,
        generateKeyPair: stuck.generate,
        maxKeyGenAttempts: 3,
      })
    ).rejects.toThrow(/truncated token key id/i);
    expect(stuck.state.calls).toBe(3);
  }, 120_000);

  it("only reserves bytes of windows that actually overlap", async () => {
    const past = {
      notBefore: "2033-01-01T00:00:00.000Z",
      notAfter: "2033-04-01T00:00:00.000Z",
    };
    const [k1] = await distinctKeyPairs(1);
    const seed = scriptedGenerator([k1!]);
    await generateIssuerKey(sql, NOW, { ...past, generateKeyPair: seed.generate });

    // A disjoint future window sees no reserved bytes from the past key.
    const disjoint = await overlappingTruncatedKeyIds(
      sql,
      new Date("2034-01-01T00:00:00.000Z"),
      new Date("2034-04-01T00:00:00.000Z")
    );
    expect(disjoint.has(await truncByteOf(k1!))).toBe(false);

    // An overlapping window does see it.
    const overlapping = await overlappingTruncatedKeyIds(
      sql,
      new Date("2033-03-01T00:00:00.000Z"),
      new Date("2033-06-01T00:00:00.000Z")
    );
    expect(overlapping.has(await truncByteOf(k1!))).toBe(true);
  }, 120_000);
});

describe("generateIssuerKey concurrent generation is serialized", () => {
  it("concurrent calls with default overlapping windows never share a truncated byte", async () => {
    await sql`TRUNCATE conditions.issuer_key`;

    const N = 8;
    const collideCount = 3;

    // A pool of DISTINCT keypairs that all carry the same truncated byte. If the
    // read-check-insert were not atomic, several concurrent calls would each read
    // an empty reserved set and insert one of these, landing multiple overlapping
    // keys on the same byte (distinct key_ids, so ON CONFLICT does NOT hide it).
    const { byte, pairs: colliders } = await collidingGroup(collideCount);
    // One distinct-byte fallback per call (colliders retry into theirs; the
    // non-colliding calls use theirs directly). All differ from `byte`.
    const singles = await distinctSingles(N, new Set([byte]));

    // All N calls pass their reserved-set read before any of them inserts.
    const barrier = windowBarrier(N, 2000);
    const generators: Array<() => Promise<KeyPair>> = [];
    for (let i = 0; i < collideCount; i++) {
      // First candidate collides on `byte`; a serialized loser retries into singles[i].
      generators.push(barrieredGenerator([colliders[i]!, singles[i]!], barrier).generate);
    }
    for (let i = collideCount; i < N; i++) {
      generators.push(barrieredGenerator([singles[i]!], barrier).generate);
    }

    const results = await Promise.all(
      generators.map((generate) => generateIssuerKey(sql, NOW, { generateKeyPair: generate }))
    );
    expect(results).toHaveLength(N);

    const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
    expect(keys).toHaveLength(N);
    // The whole point: every overlapping stored key has a DISTINCT truncated byte,
    // so issuance can never be ambiguous. Without the advisory lock the three
    // colliders would each keep `byte`, collapsing the set below N.
    expect(new Set(keys.map((k) => k.truncatedTokenKeyId)).size).toBe(N);
  }, 180_000);
});

describe("overlapping keys with distinct bytes issue + redeem correctly", () => {
  it("a token blinded against the OLDER of two overlapping keys still issues and redeems", async () => {
    await sql`TRUNCATE conditions.issuer_key`;
    const older = await generateIssuerKey(sql, NOW, {
      notBefore: "2026-05-01T00:00:00.000Z",
      notAfter: "2026-08-01T00:00:00.000Z",
    });
    await generateIssuerKey(sql, NOW);

    const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
    expect(keys).toHaveLength(2);
    // The generation-time invariant: no two overlapping keys share a truncated byte.
    expect(new Set(keys.map((k) => k.truncatedTokenKeyId)).size).toBe(2);
    const olderKey = keys.find((k) => k.keyId === older.keyId)!;

    const reporter = await generateReporterKey();
    await enrollReporter(sql, reporter.publicJwk, { keyId: reporter.keyId }, NOW, {
      grantSecret: GRANT_SECRET,
      log: noopLog,
    });

    const ctx: PublicContext = { purpose: "report", taskId: "collision", epoch: "2026-07-12" };
    const client = new Client(BlindRSAMode.PSS);
    const origin = new Origin(BlindRSAMode.PSS);
    const challenge = origin.createTokenChallenge(
      DEFAULT_ISSUER_NAME,
      await redemptionContext(ctx)
    );
    const request = await client.createTokenRequest(challenge, olderKey.publicKeyBytes);
    const result = await issueToken(sql, reporter.keyId, "2026-07-12", request.serialize(), ctx, {
      log: noopLog,
      now: NOW,
    });
    expect(result.issued).toBe(true);
    const token = await client.finalize(
      TokenResponse.deserialize((result as { tokenResponse: Uint8Array }).tokenResponse)
    );

    const verifier = new TokenVerifier({ issuerName: DEFAULT_ISSUER_NAME, log: noopLog });
    await expect(verifier.verify(sql, token.serialize(), ctx, NOW)).resolves.toBe(true);
  }, 180_000);
});
