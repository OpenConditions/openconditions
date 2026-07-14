import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Metadata, MetadataKind } from "@tufjs/models";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { signRegistry } from "../tuf/repo.js";
import { generateTufSigner, tufSignerFromKeyPair } from "../tuf/signing.js";
import {
  TEST_ROOT_MARKER,
  TestRootInProductionError,
  verifyRegistryMetadata,
} from "../tuf/verify.js";
import {
  buildRepo,
  makeRepoKeys,
  pastDate,
  rolesFrom,
  sampleEntry,
  tempDir,
  writeRegistryDir,
} from "./tuf-fixture.js";

describe("signRegistry", () => {
  it("writes a complete TUF metadata repository over the registry", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de"), sampleEntry("openmapx-nl")]);
    const repo = await buildRepo({ registryDir });
    expect(repo.targetFiles.sort()).toEqual(["openmapx-de.yaml", "openmapx-nl.yaml"]);
    for (const file of ["1.root.json", "timestamp.json", "snapshot.json", "targets.json"]) {
      expect(() => readFileSync(join(repo.metadataDir, file))).not.toThrow();
    }
    const root = JSON.parse(readFileSync(join(repo.metadataDir, "1.root.json"), "utf8")) as {
      signed: Record<string, unknown>;
    };
    expect(root.signed[TEST_ROOT_MARKER]).toBe(true);
    expect(root.signed["consistent_snapshot"]).toBe(false);
  });

  it("is deterministic: identical inputs produce byte-identical metadata", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys();
    const now = "2026-07-01T00:00:00.000Z";
    const a = await buildRepo({ registryDir, keys, now });
    const b = await buildRepo({ registryDir, keys, now });
    for (const file of ["1.root.json", "timestamp.json", "snapshot.json", "targets.json"]) {
      expect(readFileSync(join(a.metadataDir, file), "utf8")).toBe(
        readFileSync(join(b.metadataDir, file), "utf8")
      );
    }
  });

  it("refuses to produce anything but a marked TEST root", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys();
    await expect(
      signRegistry({
        registryDir,
        repoDir: tempDir("oc-tuf-repo-"),
        roles: rolesFrom(keys),
        testRoot: false as unknown as true,
      })
    ).rejects.toThrow(/test root/i);
  });

  it("rejects a registry file whose name does not match its id", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    writeFileSync(join(registryDir, "impostor.yaml"), stringify(sampleEntry("openmapx-fr")));
    await expect(buildRepo({ registryDir })).rejects.toThrow(/impostor\.yaml/);
  });
});

describe("verifyRegistryMetadata", () => {
  it("accepts a valid repository and returns the parsed registry entries", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de"), sampleEntry("openmapx-nl")]);
    const repo = await buildRepo({ registryDir });
    const entries = await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, {
      cacheDir: tempDir("oc-tuf-cache-"),
    });
    expect(entries.map((entry) => entry.id)).toEqual(["openmapx-de", "openmapx-nl"]);
    expect(entries[0]?.trustTier).toBe(1);
  });

  it("accepts a valid update to a previously synced repository", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    const cacheDir = tempDir("oc-tuf-cache-");
    await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir });

    const rotated = sampleEntry("openmapx-de");
    const updatedDir = writeRegistryDir([rotated, sampleEntry("openmapx-nl")]);
    await buildRepo({
      registryDir: updatedDir,
      repoDir: repo.repoDir,
      keys: repo.keys,
      version: 2,
    });
    const entries = await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir });
    expect(entries.map((entry) => entry.id)).toEqual(["openmapx-de", "openmapx-nl"]);
    expect(entries[0]?.keys).toEqual((rotated as { keys: string[] }).keys);
  });

  it("REJECTS a rollback: a lower version than the client has already seen", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys();
    const v2 = await buildRepo({ registryDir, keys, version: 2 });
    const cacheDir = tempDir("oc-tuf-cache-");
    await verifyRegistryMetadata(v2.repoDir, v2.rootBytes, { cacheDir });

    const v1 = await buildRepo({ registryDir, keys, version: 1 });
    await expect(verifyRegistryMetadata(v1.repoDir, v2.rootBytes, { cacheDir })).rejects.toThrow(
      /less than current version/
    );
  });

  it("REJECTS a freeze: a timestamp kept past its expiry", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir, expires: { timestamp: pastDate() } });
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/timestamp\.json is expired/);
  });

  it("REJECTS expired root metadata", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir, expires: { root: pastDate() } });
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/root\.json is expired/);
  });

  it("REJECTS expired targets metadata", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir, expires: { targets: pastDate() } });
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/expired/i);
  });

  it("REJECTS a mix-and-match: targets from one release under another release's snapshot", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys();
    const v1 = await buildRepo({ registryDir, keys, version: 1 });
    const keptTargets = join(tempDir("oc-tuf-mix-"), "targets.json");
    copyFileSync(join(v1.metadataDir, "targets.json"), keptTargets);

    const changedDir = writeRegistryDir([sampleEntry("openmapx-de"), sampleEntry("openmapx-nl")]);
    const v2 = await buildRepo({ registryDir: changedDir, repoDir: v1.repoDir, keys, version: 2 });
    copyFileSync(keptTargets, join(v2.metadataDir, "targets.json"));

    await expect(
      verifyRegistryMetadata(v2.repoDir, v2.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/mismatch|expected length/i);
  });

  it("REJECTS a same-length tampered targets file via the snapshot hash", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    const targetsPath = join(repo.metadataDir, "targets.json");
    const original = readFileSync(targetsPath, "utf8");
    const tampered = original.includes("openmapx-de.yaml")
      ? original.replace("openmapx-de.yaml", "openmapx-ee.yaml")
      : original;
    expect(tampered).not.toBe(original);
    expect(tampered.length).toBe(original.length);
    writeFileSync(targetsPath, tampered);

    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/expected hash/i);
  });

  it("REJECTS metadata signed by a key the root never authorized", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });

    const rogue = await generateTufSigner();
    const timestampPath = join(repo.metadataDir, "timestamp.json");
    const timestamp = Metadata.fromJSON(
      MetadataKind.Timestamp,
      JSON.parse(readFileSync(timestampPath, "utf8"))
    );
    timestamp.sign(rogue.sign, false);
    writeFileSync(timestampPath, JSON.stringify(timestamp.toJSON()));

    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/signed by 0\/1/);
  });

  it("REJECTS targets metadata signed by a key the root never authorized for targets", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys();
    const rogue = await generateTufSigner();
    const roles = rolesFrom(keys, {
      targets: { keys: [keys.targets[0]!.key], threshold: 1, signers: [rogue] },
    });
    const repo = await buildRepo({ registryDir, keys, roles });

    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/signed by 0\/1/);
  });

  it("REJECTS a signature set below the role threshold", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys();
    const second = await generateTufSigner();
    const roles = rolesFrom(keys, {
      targets: {
        keys: [keys.targets[0]!.key, second.key],
        threshold: 2,
        signers: [keys.targets[0]!],
      },
    });
    const repo = await buildRepo({ registryDir, keys, roles });
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
    ).rejects.toThrow(/signed by 1\/2/);
  });

  it("ACCEPTS a key rotation signed under both the old and new root thresholds", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys(3);
    const [a, b, c] = keys.root as [
      (typeof keys.root)[0],
      (typeof keys.root)[0],
      (typeof keys.root)[0],
    ];
    const rolesV1 = rolesFrom(keys, {
      root: { keys: [a.key, b.key, c.key], threshold: 2, signers: [a, b] },
    });
    const v1 = await buildRepo({ registryDir, keys, roles: rolesV1 });
    const cacheDir = tempDir("oc-tuf-cache-");
    await verifyRegistryMetadata(v1.repoDir, v1.rootBytes, { cacheDir });

    const d = await generateTufSigner();
    const newTargets = await generateTufSigner();
    const rolesV2 = rolesFrom(keys, {
      root: { keys: [b.key, c.key, d.key], threshold: 2, signers: [b, c] },
      targets: { keys: [newTargets.key], threshold: 1, signers: [newTargets] },
    });
    await buildRepo({
      registryDir,
      repoDir: v1.repoDir,
      keys,
      roles: rolesV2,
      version: 2,
      rootVersion: 2,
    });

    const entries = await verifyRegistryMetadata(v1.repoDir, v1.rootBytes, { cacheDir });
    expect(entries.map((entry) => entry.id)).toEqual(["openmapx-de"]);
    const trustedRoot = JSON.parse(readFileSync(join(cacheDir, "root.json"), "utf8")) as {
      signed: { version: number };
    };
    expect(trustedRoot.signed.version).toBe(2);
  });

  it("REJECTS a root rotation not signed under the old root threshold", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const keys = await makeRepoKeys(3);
    const [a, b, c] = keys.root as [
      (typeof keys.root)[0],
      (typeof keys.root)[0],
      (typeof keys.root)[0],
    ];
    const rolesV1 = rolesFrom(keys, {
      root: { keys: [a.key, b.key, c.key], threshold: 2, signers: [a, b] },
    });
    const v1 = await buildRepo({ registryDir, keys, roles: rolesV1 });
    const cacheDir = tempDir("oc-tuf-cache-");
    await verifyRegistryMetadata(v1.repoDir, v1.rootBytes, { cacheDir });

    const d = await generateTufSigner();
    const e = await generateTufSigner();
    const rolesV2 = rolesFrom(keys, {
      root: { keys: [c.key, d.key, e.key], threshold: 2, signers: [d, e] },
    });
    await buildRepo({
      registryDir,
      repoDir: v1.repoDir,
      keys,
      roles: rolesV2,
      version: 2,
      rootVersion: 2,
    });

    await expect(verifyRegistryMetadata(v1.repoDir, v1.rootBytes, { cacheDir })).rejects.toThrow(
      /signed by/
    );
  });

  it("fails closed: refuses the TEST root when NODE_ENV is production", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, {
        cacheDir: tempDir("oc-tuf-cache-"),
        env: "production",
      })
    ).rejects.toThrow(TestRootInProductionError);
  });

  it("fails closed: refuses the TEST root when NODE_ENV is unset", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await expect(
        verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir: tempDir("oc-tuf-cache-") })
      ).rejects.toThrow(TestRootInProductionError);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("fails closed: refuses the TEST root under an unknown NODE_ENV", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, {
        cacheDir: tempDir("oc-tuf-cache-"),
        env: "staging",
      })
    ).rejects.toThrow(TestRootInProductionError);
  });

  it("accepts the TEST root under an explicit test or development env", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    for (const env of ["test", "development"] as const) {
      const entries = await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, {
        cacheDir: tempDir("oc-tuf-cache-"),
        env,
      });
      expect(entries).toHaveLength(1);
    }
  });

  it("accepts the TEST root with an explicit allowTestRoot opt-in regardless of env", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    const entries = await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, {
      cacheDir: tempDir("oc-tuf-cache-"),
      env: "production",
      allowTestRoot: true,
    });
    expect(entries).toHaveLength(1);
  });

  it("refuses a test root already persisted in the cache when moving to production", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    const cacheDir = tempDir("oc-tuf-cache-");
    await verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir, env: "test" });
    await expect(
      verifyRegistryMetadata(repo.repoDir, repo.rootBytes, { cacheDir, env: "production" })
    ).rejects.toThrow(TestRootInProductionError);
  });
});

describe("tufSignerFromKeyPair", () => {
  it("reuses T1 WebCrypto Ed25519 material, including non-extractable private keys", async () => {
    const pair = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey)
    );
    const nonExtractable = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      pkcs8 as BufferSource,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    const publicKeyRaw = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("raw", pair.publicKey)
    );
    const signer = tufSignerFromKeyPair({ publicKeyRaw, privateKey: nonExtractable });
    const data = Buffer.from("signed payload");
    const signature = signer.sign(data);
    expect(signature.keyID).toBe(signer.keyId);
    const verified = await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      pair.publicKey,
      Buffer.from(signature.sig, "hex") as BufferSource,
      data as BufferSource
    );
    expect(verified).toBe(true);
  });
});
