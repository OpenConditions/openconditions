import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers";
import { expect, vi } from "vitest";

export type OwnedDatabase = { container: StartedTestContainer; id?: string };

export function captureDatabaseStart(owned: OwnedDatabase[]): () => void {
  const start = GenericContainer.prototype.start;
  let active = true;
  const restore = () => {
    if (active) {
      receipt.mockRestore();
      active = false;
    }
  };
  const receipt = vi.spyOn(GenericContainer.prototype, "start").mockImplementation(async function (
    this: GenericContainer,
  ) {
    // Restore before the real start can create nested infrastructure containers.
    restore();
    const container = await start.call(this);
    const record: OwnedDatabase = { container };
    owned.push(record);
    const id = container.getId();
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid owned database ID receipt");
    record.id = id;
    console.info("OWNED_DATABASE_PROFILE_STARTED", id);
    return container;
  });
  return restore;
}

export async function cleanupProfileDatabase(
  db: { close(): Promise<void> } | undefined,
  owned: OwnedDatabase[],
): Promise<void> {
  const failures: unknown[] = [];
  try {
    if (db) await db.close();
    else {
      for (const { container } of owned) {
        try {
          await container.stop();
        } catch (error) {
          failures.push(error);
        }
      }
    }
  } catch (error) {
    failures.push(error);
  }
  for (const record of owned) {
    try {
      if (typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id)) {
        throw new Error("Owned database ID receipt unavailable; absence not established");
      }
      const client = await getContainerRuntimeClient();
      await expect(
        client.container.inspect(client.container.getById(record.id)),
      ).rejects.toMatchObject({ statusCode: 404 });
      console.info("OWNED_DATABASE_PROFILE_ABSENT", record.id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Disposable profile cleanup failed");
}
