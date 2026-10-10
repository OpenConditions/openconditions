import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase } from "./database.integration.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("a transaction whose connection the server closes", () => {
  test("rejects, and the client keeps serving rather than crashing on its rollback", async () => {
    const client = postgres(db.url, { max: 2, onnotice: () => {} });
    const transaction = client.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      setTimeout(() => {
        void db.sql`SELECT pg_terminate_backend(${row!.pid})`.then(() => undefined);
      }, 200);
      await tx`SELECT pg_sleep(5)`;
    });
    await expect(transaction).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
    // The rollback the transaction sends on its way out must not reach a gone socket.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [after] = await client<{ ok: number }[]>`SELECT 1 AS ok`;
    expect(after?.ok).toBe(1);
  }, 30_000);
});
