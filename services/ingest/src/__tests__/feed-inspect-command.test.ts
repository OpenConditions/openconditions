import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFeedInspectCommand } from "../ops/feed-inspect-command.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("feed inspection command", () => {
  it("runs without credentials, a database or network, and emits only JSON on stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-inspect-"));
    dirs.push(dir);
    const file = join(dir, "sample.json");
    await writeFile(
      file,
      '{"value":[{"Type":"Roadwork","Latitude":1.35,"Longitude":103.9,"Message":"Example"}]}',
    );
    const out: string[] = [];
    const errors: string[] = [];
    const result = await runFeedInspectCommand(
      ["sg-lta-events", "--at", "2026-06-28T10:00:00Z", "--payload", file],
      (s) => out.push(s),
      (s) => errors.push(s),
    );
    expect(result).toBe(0);
    expect(errors).toEqual([]);
    const report = JSON.parse(out.join(""));
    expect(report.counts).toMatchObject({ parsed: 1, valid: 1 });
    expect(report.inputs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(
    [
      [],
      ["sg-lta-events", "--at", "2026-06-28T10:00:00Z"],
      ["sg-lta-events", "--wat"],
      ["unknown", "--at", "2026-06-28T10:00:00Z", "--payload", "/not/a/file"],
    ].map((args) => [args]),
  )("refuses invalid arguments without emitting a partial JSON report: %j", async (args) => {
    const out: string[] = [];
    const errors: string[] = [];
    expect(
      await runFeedInspectCommand(
        args,
        (s) => out.push(s),
        (s) => errors.push(s),
      ),
    ).not.toBe(0);
    expect(out).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("CLI process boundaries", () => {
  it("keeps parser diagnostics on stderr even when records are skipped", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const dir = await mkdtemp(join(tmpdir(), "oc-inspect-cli-"));
    dirs.push(dir);
    const file = join(dir, "sample.json");
    await writeFile(file, '{"value":[{"Type":"Roadwork","Message":"No geometry"}]}');
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "services/ingest/src/ops/feed-inspect-command.ts",
        "sg-lta-events",
        "--at",
        "2026-06-28T10:00:00Z",
        "--payload",
        file,
      ],
      {
        cwd: new URL("../../../..", import.meta.url),
        env: {
          ...process.env,
          OPENCONDITIONS_FEEDS_REMOTE_ENABLED: "true",
          OPENCONDITIONS_FEEDS_REMOTE_URL: "https://invalid.test/must-not-fetch",
        },
      },
    );
    expect(JSON.parse(result.stdout).counts.parsed).toBe(0);
    expect(result.stderr).toContain("skipped");
  }, 30_000);

  it("rejects an explicitly missing or non-directory catalogue mount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-inspect-mount-"));
    dirs.push(dir);
    const file = join(dir, "sample.json");
    await writeFile(file, '{"value":[]}');
    for (const mount of [join(dir, "missing"), file]) {
      const out: string[] = [];
      const errors: string[] = [];
      expect(
        await runFeedInspectCommand(
          [
            "sg-lta-events",
            "--at",
            "2026-06-28T10:00:00Z",
            "--payload",
            file,
            "--feeds-dir",
            mount,
          ],
          (s) => out.push(s),
          (s) => errors.push(s),
        ),
      ).toBe(1);
      expect(out).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it("lists IDs without export previews and rejects combining index with exact-ID selection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oc-inspect-index-"));
    dirs.push(dir);
    const file = join(dir, "sample.json");
    await writeFile(
      file,
      JSON.stringify({
        value: Array.from({ length: 101 }, (_, i) => ({
          Type: "Roadwork",
          Latitude: 1 + i * 0.01,
          Longitude: 103,
          Message: `Example ${i}`,
        })),
      }),
    );
    const args = ["sg-lta-events", "--at", "2026-06-28T10:00:00Z", "--payload", file, "--list"];
    const out: string[] = [];
    expect(
      await runFeedInspectCommand(
        args,
        (s) => out.push(s),
        () => {},
      ),
    ).toBe(0);
    const index = JSON.parse(out.join(""));
    expect(index.mode).toBe("index");
    expect(index.records).toHaveLength(101);
    expect(index.records[0].id).toMatch(/^oc:situation:sg-lta-events:/);
    expect(index.exports).toBeUndefined();
    expect(
      await runFeedInspectCommand(
        [...args, "--id", "x"],
        () => {},
        () => {},
      ),
    ).toBe(2);
  });
});
