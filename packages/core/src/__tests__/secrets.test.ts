import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type SealedSecret,
  type SecretPlace,
  SecretsKey,
  SecretsKeyError,
  secretsKeyFromEnv,
  WrongSecretsKeyError,
} from "../crypto/secrets.js";

const HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER_HEX = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const PLACE: SecretPlace = { table: "oauth_grant", column: "refresh_token", row: "eumetsat" };

const flipped = (bytes: Uint8Array, index = 0): Buffer => {
  const copy = Buffer.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
};

describe("SecretsKey", () => {
  it("opens what it sealed, at the place it sealed it", () => {
    const key = SecretsKey.parse(HEX);
    const sealed = key.seal("refresh-token-value", PLACE);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(key.openText(sealed, PLACE)).toBe("refresh-token-value");
    const bytes = randomBytes(48);
    expect(key.open(key.seal(bytes, PLACE), PLACE).equals(bytes)).toBe(true);
  });

  it("uses a fresh IV for every seal", () => {
    const key = SecretsKey.parse(HEX);
    const a = key.seal("same", PLACE);
    const b = key.seal("same", PLACE);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("never holds the plaintext in what it stores", () => {
    const sealed = SecretsKey.parse(HEX).seal("refresh-token-value", PLACE);
    const stored = Buffer.concat([sealed.ciphertext, sealed.iv, sealed.tag]);
    expect(stored.includes(Buffer.from("refresh-token-value"))).toBe(false);
  });

  describe("refuses a tampered value as a wrong key, naming where it is stored", () => {
    const key = SecretsKey.parse(HEX);
    const sealed = key.seal("refresh-token-value", PLACE);
    const wrong = /wrong key: .*conditions\.oauth_grant\.refresh_token of the row eumetsat/;
    const cases: [string, SealedSecret, SecretPlace][] = [
      ["ciphertext", { ...sealed, ciphertext: flipped(sealed.ciphertext) }, PLACE],
      ["IV", { ...sealed, iv: flipped(sealed.iv) }, PLACE],
      ["tag", { ...sealed, tag: flipped(sealed.tag, 15) }, PLACE],
      ["row (additional data)", sealed, { ...PLACE, row: "acme" }],
      ["column (additional data)", sealed, { ...PLACE, column: "access_token" }],
      ["table (additional data)", sealed, { ...PLACE, table: "issuer_key" }],
    ];
    for (const [what, value, place] of cases) {
      it(what, () => {
        let thrown: unknown;
        try {
          key.open(value, place);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(WrongSecretsKeyError);
        expect((thrown as Error).message).toMatch(place === PLACE ? wrong : /^wrong key: /);
      });
    }
  });

  it("refuses a value sealed under another key, without revealing either", () => {
    const sealed = SecretsKey.parse(HEX).seal("refresh-token-value", PLACE);
    let message = "";
    try {
      SecretsKey.parse(OTHER_HEX).open(sealed, PLACE);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^wrong key: /);
    expect(message).not.toContain(HEX);
    expect(message).not.toContain(OTHER_HEX);
    expect(message).not.toContain("refresh-token-value");
  });

  it("checks the stored IV and tag lengths", () => {
    const key = SecretsKey.parse(HEX);
    const sealed = key.seal("value", PLACE);
    expect(() => key.open({ ...sealed, iv: sealed.iv.subarray(0, 11) }, PLACE)).toThrow(
      /conditions\.oauth_grant\.refresh_token of the row eumetsat is malformed: its IV is 11 bytes, not 12/,
    );
    expect(() =>
      key.open({ ...sealed, tag: Buffer.concat([sealed.tag, sealed.tag]) }, PLACE),
    ).toThrow(/malformed: its tag is 32 bytes, not 16/);
  });

  describe("refuses a malformed key without echoing it", () => {
    const cases: [string, string][] = [
      ["empty", ""],
      ["too short", HEX.slice(0, 62)],
      ["too long", `${HEX}00`],
      ["not hex", `${HEX.slice(0, 63)}g`],
      ["base64url of 32 bytes", Buffer.from(HEX, "hex").toString("base64url")],
    ];
    for (const [what, text] of cases) {
      it(what, () => {
        let message = "";
        try {
          SecretsKey.parse(text);
        } catch (error) {
          message = (error as Error).message;
          expect(error).toBeInstanceOf(SecretsKeyError);
        }
        expect(message).toMatch(/OPENCONDITIONS_SECRETS_KEY must be 64 hexadecimal characters/);
        expect(message).toContain("openssl rand -hex 32");
        if (text !== "") expect(message).not.toContain(text);
      });
    }
  });

  it("accepts upper-case hex and surrounding whitespace", () => {
    const sealed = SecretsKey.parse(HEX).seal("value", PLACE);
    expect(SecretsKey.parse(`  ${HEX.toUpperCase()}\n`).openText(sealed, PLACE)).toBe("value");
  });

  it("shows nothing of the key when printed or serialized", () => {
    const key = SecretsKey.parse(HEX);
    expect(JSON.stringify(key)).not.toContain("0011");
    expect(String(key)).not.toContain("0011");
    expect(inspect(key, { showHidden: true, depth: 5 })).not.toContain("0011");
  });
});

describe("secretsKeyFromEnv", () => {
  const fileHolding = (contents: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), "oc-secrets-key-")), "key");
    writeFileSync(file, contents);
    return file;
  };

  it("reads the key from OPENCONDITIONS_SECRETS_KEY_FILE, trimmed", () => {
    const sealed = SecretsKey.parse(HEX).seal("value", PLACE);
    const key = secretsKeyFromEnv({ OPENCONDITIONS_SECRETS_KEY_FILE: fileHolding(`${HEX}\n`) });
    expect(key.openText(sealed, PLACE)).toBe("value");
  });

  it("reads the key from OPENCONDITIONS_SECRETS_KEY", () => {
    const sealed = SecretsKey.parse(HEX).seal("value", PLACE);
    expect(secretsKeyFromEnv({ OPENCONDITIONS_SECRETS_KEY: HEX }).openText(sealed, PLACE)).toBe(
      "value",
    );
  });

  it("refuses a missing key, naming the file variable and how to make one", () => {
    expect(() => secretsKeyFromEnv({})).toThrow(
      /OPENCONDITIONS_SECRETS_KEY is required: set OPENCONDITIONS_SECRETS_KEY_FILE to a file holding it .*openssl rand -hex 32/,
    );
  });

  it("refuses a key file that is missing or empty, naming the path", () => {
    const missing = join(tmpdir(), "oc-secrets-key-missing", "key");
    expect(() => secretsKeyFromEnv({ OPENCONDITIONS_SECRETS_KEY_FILE: missing })).toThrow(
      `OPENCONDITIONS_SECRETS_KEY_FILE (${missing}) could not be read: ENOENT`,
    );
    const empty = fileHolding("\n");
    expect(() => secretsKeyFromEnv({ OPENCONDITIONS_SECRETS_KEY_FILE: empty })).toThrow(
      `OPENCONDITIONS_SECRETS_KEY_FILE (${empty}) is empty`,
    );
  });

  it("refuses a malformed key file", () => {
    expect(() =>
      secretsKeyFromEnv({ OPENCONDITIONS_SECRETS_KEY_FILE: fileHolding("not-a-key") }),
    ).toThrow(/must be 64 hexadecimal characters/);
  });
});
