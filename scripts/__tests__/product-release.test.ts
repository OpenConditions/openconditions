import { chmodSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { put } from "./docker-context-fixtures.js";
import { setupRelease } from "./product-release-fixtures.js";

it("validates exact metadata while explicitly declining context/producer authority", () => {
  const f = setupRelease(),
    r = f.check();
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout).contexts).toBe("NOT_CHECKED");
});
it.each([
  "container/environment",
  "configSchema",
  "provides",
  "ownsSchema",
  "container/image",
  "version",
  "container/digest",
])("rejects forbidden field/value %s", (key) => {
  const f = setupRelease(),
    p = "services/ingest/service.json",
    d = JSON.parse(readFileSync(join(f.repo, p), "utf8"));
  const bits = key.split("/");
  let o = d;
  for (const b of bits.slice(0, -1)) o = o[b];
  o[bits.at(-1)!] = "forbidden";
  put(f.repo, p, JSON.stringify(d));
  const r = f.check();
  expect(r.status).toBe(1);
});
it.each([
  "package.json",
  "pnpm-lock.yaml",
  "feeds/roads/de.jsonc",
  "services/ingest/Dockerfile",
  ".dockerignore",
])("rejects nonmetadata change %s", (p) => {
  const f = setupRelease();
  put(f.repo, p, readFileSync(join(f.repo, p), "utf8") + "\n");
  expect(f.check().status).toBe(1);
});
it.each(["unknown", "producer", "images", "source", "duplicate", "platform", "artifact", "order"])(
  "rejects malformed candidate/binding %s",
  (kind) => {
    const f = setupRelease(),
      d = structuredClone(f.candidate);
    if (kind === "unknown") Reflect.set(d, "extra", 1);
    if (kind === "producer") d.producer.runId = 2;
    if (kind === "images") delete d.images.federation;
    if (kind === "source") d.images.ingest.buildSourceSha = "0".repeat(40);
    if (kind === "platform") d.images.ingest.platforms = ["linux/arm64"];
    if (kind === "artifact") d.images.ingest.sbomArtifactId = 0;
    if (kind === "order") {
      const p = "extension.json",
        e = JSON.parse(readFileSync(join(f.repo, p), "utf8"));
      e.services.reverse();
      put(f.repo, p, JSON.stringify(e));
    }
    put(
      f.repo,
      `docs/release-notes/${f.version}.json`,
      kind === "duplicate"
        ? JSON.stringify(d).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')
        : JSON.stringify(d),
    );
    expect(f.check().status).toBe(1);
  },
);
it.each(["mode", "symlink"])("rejects %s descriptor", (kind) => {
  const f = setupRelease(),
    p = join(f.repo, "extension.json");
  if (kind === "mode") chmodSync(p, 0o755);
  else {
    rmSync(p);
    symlinkSync("services/ingest/service.json", p);
  }
  expect(f.check().status).toBe(1);
});
it.each(["platform", "membership", "ref"])("rejects extension %s drift", (kind) => {
  const f = setupRelease(),
    p = "extension.json",
    e = JSON.parse(readFileSync(join(f.repo, p), "utf8"));
  if (kind === "platform") e.platform = "2.0";
  if (kind === "membership") e.services.push(e.services[0]);
  if (kind === "ref") e.services[0].ref = "main";
  put(f.repo, p, JSON.stringify(e));
  expect(f.check().status).toBe(1);
});
