import { describe, expect, test } from "vitest";
import { HOLD_GZIP_BYTES, heldBuffer, heldBuffers, heldBytes, holdPayload } from "../held.js";

describe("held payloads", () => {
  test("a payload up to 1 MiB is kept as fetched", async () => {
    const buffer = Buffer.alloc(HOLD_GZIP_BYTES, "a");
    const held = await holdPayload(buffer);
    expect(held).toEqual({ data: buffer, gzipped: false, bytes: HOLD_GZIP_BYTES });
    expect(held.data).toBe(buffer);
    expect(await heldBuffer(held)).toBe(buffer);
  });

  test("a larger payload is kept gzipped and read back as fetched", async () => {
    const buffer = Buffer.from("id,status\n".repeat(200_000));
    const held = await holdPayload(buffer);
    expect(held.gzipped).toBe(true);
    expect(held.bytes).toBe(buffer.length);
    expect(held.data.length).toBeLessThan(buffer.length / 10);
    expect((await heldBuffer(held)).equals(buffer)).toBe(true);
  });

  test("a role's payloads read back in order and count their fetched bytes", async () => {
    const big = Buffer.from("x".repeat(2 * HOLD_GZIP_BYTES));
    const small = Buffer.from("[]");
    const held = [await holdPayload(big), await holdPayload(small)];
    expect(heldBytes(held)).toBe(big.length + small.length);
    const back = await heldBuffers(held);
    expect(back.map((b) => b.length)).toEqual([big.length, small.length]);
    expect(back[1]).toBe(small);
  });
});
