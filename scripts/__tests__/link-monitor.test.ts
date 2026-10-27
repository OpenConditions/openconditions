import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

// @ts-expect-error Node module is also loaded directly by github-script.
import { checkRegistry, publish, validate } from "../link-monitor.mjs";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/link-monitor/${name}.json`, import.meta.url), "utf8"),
  );
const endpoints = [
  "https://registry.npmjs.org/hyparquet-writer",
  "https://registry.npmjs.org/@divviup%2Fprio3",
  "https://registry.npmjs.org/@divviup%2Fvdaf",
];
const rows = () => endpoints.map((url) => ({ url, exit: 0, status: "200" }));
const inputs = (name = "healthy", exit = "0") => ({
  stats: fixture(name),
  exit,
  version: "lychee 0.24.2",
  registry: rows(),
});
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("classifies complete healthy, cached and broken-link results", () => {
  expect(validate(inputs()).unhealthy).toBe(false);
  expect(validate(inputs("cached")).body).toContain("cached: 1");
  const broken = validate(inputs("unhealthy", "2"));
  expect(broken.unhealthy).toBe(true);
  expect(broken.body).toContain("Rejected status code: 404");
});
test.each(["", "1", "3", "127"])("rejects checker execution exit %s", (exit) =>
  expect(() => validate(inputs("healthy", exit))).toThrow(/execution/),
);
test("rejects empty, partial, contradictory, missing diagnostic and wrong-version output", () => {
  for (const stats of [
    null,
    {},
    { ...fixture("healthy"), total: 0 },
    { ...fixture("healthy"), unknown: 1 },
    { ...fixture("healthy"), errors: 1 },
    { ...fixture("unhealthy"), error_map: {} },
  ])
    expect(() => validate({ ...inputs(), stats })).toThrow();
  expect(() => validate(inputs("unhealthy"))).toThrow(/exit/);
  expect(() => validate({ ...inputs(), version: "lychee 0.25.0" })).toThrow(/version/);
});
test("requires exactly the three fixed registry results; provider failures are unhealthy", () => {
  for (const registry of [
    [],
    rows().slice(1),
    [...rows(), rows()[0]],
    rows().map((row) => ({ ...row, url: "https://other.test" })),
  ])
    expect(() => validate({ ...inputs(), registry })).toThrow(/registry/);
  expect(
    validate({ ...inputs(), registry: rows().map((row) => ({ ...row, status: "503" })) }).unhealthy,
  ).toBe(true);
  expect(
    validate({ ...inputs(), registry: rows().map((row) => ({ ...row, exit: 28, status: "000" })) })
      .unhealthy,
  ).toBe(true);
  expect(() =>
    validate({ ...inputs(), registry: rows().map((row) => ({ ...row, exit: 2 })) }),
  ).toThrow(/registry/);
});
test("registry uses bounded direct curl calls without writer credentials and stops on tool failure", () => {
  const run = vi.fn(() => ({ status: 0, signal: null, stdout: "200", stderr: "" }));
  const result = checkRegistry({ GITHUB_TOKEN: "private", GH_TOKEN: "private", PATH: "/bin" }, run);
  expect(result).toEqual(rows());
  expect(run).toHaveBeenCalledTimes(3);
  for (const [command, args, options] of run.mock.calls as unknown as [
    string,
    string[],
    { env: Record<string, string> },
  ][]) {
    expect(command).toBe("curl");
    expect(args).toEqual(
      expect.arrayContaining(["--retry", "2", "--connect-timeout", "10", "--max-time", "30"]),
    );
    expect(options.env).toEqual({ PATH: "/bin" });
  }
  expect(() => checkRegistry({}, () => ({ status: 127, stderr: "missing" }))).toThrow(/tool/);
});
test.each([
  "missing",
  "malformed",
  "early-failure",
  "registry-missing",
  "summary-failure",
  "report-failure",
  "healthy",
  "unhealthy",
])("real validator CLI handles %s without silently passing missing evidence", (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "oc-links-"));
  dirs.push(dir);
  const output = join(dir, "lychee");
  mkdirSync(output);
  if (mode !== "missing")
    writeFileSync(
      join(output, "out.json"),
      mode === "malformed"
        ? "{"
        : JSON.stringify(fixture(mode === "unhealthy" ? "unhealthy" : "healthy")),
    );
  writeFileSync(join(output, "registry.json"), JSON.stringify(rows()));
  writeFileSync(join(output, "version.txt"), "lychee 0.24.2\n");
  if (mode === "registry-missing") rmSync(join(output, "registry.json"));
  if (mode === "report-failure") mkdirSync(join(output, "report.json"));
  const script = new URL("../link-monitor.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, "validate"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: mode === "summary-failure" ? dir : join(dir, "summary.md"),
      CHECKS_OUTCOME: mode === "early-failure" ? "failure" : "success",
      LYCHEE_EXIT_CODE: mode === "unhealthy" ? "2" : "0",
    },
  });
  expect(result.status).toBe(["healthy", "unhealthy"].includes(mode) ? 0 : 1);
  if (result.status === 0)
    expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8")).unhealthy).toBe(
      mode === "unhealthy",
    );
});

function client(body = "Human introduction\n\nOld diagnostic bytes\n") {
  let issue = {
    id: 1,
    number: 9,
    node_id: "issue9",
    title: "Broken links found by lychee",
    state: "open",
    body,
    updated_at: "one",
    user: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
  };
  const get = vi.fn(async () => ({ data: structuredClone(issue) }));
  const update = vi.fn(async (params: { body: string }) => {
    issue = { ...issue, body: params.body, updated_at: "two" };
    return { data: structuredClone(issue) };
  });
  const create = vi.fn(async (params: { body: string }) => {
    issue = { ...issue, body: params.body };
    return { data: structuredClone(issue) };
  });
  const listForRepo = vi.fn();
  const github = {
    rest: { issues: { get, update, create, listForRepo } },
    paginate: vi.fn(async () => [structuredClone(issue)]),
  };
  return { github, get, update, create };
}
const report = () => validate(inputs("unhealthy", "2"));
test("healthy recovery performs no issue API requests", async () => {
  const c = client();
  await publish(c.github, validate(inputs()));
  expect(c.github.paginate).not.toHaveBeenCalled();
});
test("updates only bot-owned fixed-title body, preserving legacy and outside text", async () => {
  const c = client();
  await publish(c.github, report());
  const first = c.update.mock.calls[0][0].body;
  expect(first).toContain("Human introduction\n\nOld diagnostic bytes\n");
  const second = client(`Before\n${first}\nAfter`);
  await publish(second.github, report());
  expect(second.update.mock.calls[0][0].body).toBe(`Before\n${first}\nAfter`);
  expect(Object.keys(c.update.mock.calls[0][0]).sort()).toEqual([
    "body",
    "issue_number",
    "owner",
    "repo",
  ]);
});
test("creates one report with documentation label, without state or comment writes", async () => {
  const c = client();
  c.github.paginate.mockResolvedValue([]);
  await publish(c.github, report());
  expect(c.create).toHaveBeenCalledOnce();
  expect(c.create.mock.calls[0][0]).toMatchObject({ labels: ["documentation"] });
});
test("refuses human-owned, duplicate and edited managed diagnostics", async () => {
  const human = client();
  human.github.paginate.mockResolvedValue([
    { ...(await human.get()).data, user: { login: "someone", id: 7, type: "User" } },
  ]);
  await expect(publish(human.github, report())).rejects.toThrow(/ownership/);
  const duplicate = client();
  const issue = (await duplicate.get()).data;
  duplicate.github.paginate.mockResolvedValue([issue, issue]);
  await expect(publish(duplicate.github, report())).rejects.toThrow(/ambiguous/);
  const initial = client();
  await publish(initial.github, report());
  const edited = client(initial.update.mock.calls[0][0].body.replace("404", "403"));
  await expect(publish(edited.github, report())).rejects.toThrow(/edited/);
  expect(edited.update).not.toHaveBeenCalled();
});
test("API errors, competing edits and unknown writes stop without retries or rollback", async () => {
  const denied = client();
  denied.github.paginate.mockRejectedValue(new Error("403"));
  await expect(publish(denied.github, report())).rejects.toThrow("403");
  expect(denied.update).not.toHaveBeenCalled();
  const changed = client();
  changed.get.mockImplementation(async () => ({
    data: { ...(await client().get()).data, body: "Changed" },
  }));
  await expect(publish(changed.github, report())).rejects.toThrow(/changed/);
  expect(changed.update).not.toHaveBeenCalled();
  const unknown = client();
  unknown.update.mockRejectedValue(new Error("connection lost"));
  await expect(publish(unknown.github, report())).rejects.toThrow("connection lost");
  expect(unknown.update).toHaveBeenCalledOnce();
  const readback = client();
  readback.get.mockRejectedValueOnce(new Error("GET failed"));
  await expect(publish(readback.github, report())).rejects.toThrow("GET failed");
});

test("rejects changed write responses and post-write readback failure without repeating a write", async () => {
  const drift = client();
  const before = (await drift.get()).data;
  drift.get
    .mockResolvedValueOnce({ data: before })
    .mockResolvedValueOnce({ data: { ...before, body: "Human edit" } });
  await expect(publish(drift.github, report())).rejects.toThrow(/readback/);
  expect(drift.update).toHaveBeenCalledOnce();
  const unavailable = client();
  unavailable.get
    .mockResolvedValueOnce({ data: (await client().get()).data })
    .mockRejectedValueOnce(new Error("readback unavailable"));
  await expect(publish(unavailable.github, report())).rejects.toThrow("readback unavailable");
  expect(unavailable.update).toHaveBeenCalledOnce();
  const wrong = client();
  wrong.update.mockResolvedValue({ data: { ...before, id: 77 } });
  await expect(publish(wrong.github, report())).rejects.toThrow(/uncertain/);
  expect(wrong.update).toHaveBeenCalledOnce();
});

test("real registry CLI strips reporting tokens before executing every curl child", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-links-child-"));
  dirs.push(dir);
  copyFileSync(new URL("./fixtures/link-monitor/curl.sh", import.meta.url), join(dir, "curl"));
  chmodSync(join(dir, "curl"), 0o700);
  const result = spawnSync(
    process.execPath,
    [new URL("../link-monitor.mjs", import.meta.url).pathname, "registry"],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: dir,
        GITHUB_TOKEN: "private",
        GH_TOKEN: "private",
        GITHUB_OUTPUT: "private",
        GITHUB_STEP_SUMMARY: "private",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "lychee/registry.json"), "utf8"))).toEqual(rows());
});
