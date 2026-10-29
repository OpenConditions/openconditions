import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const equal = (a, b, message) => assert.deepEqual(a, b, message);
const childEnv = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"])
  delete childEnv[key];
function run(command, args, cwd, label = command) {
  try {
    return execFileSync(command, args, {
      cwd,
      env: childEnv,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    fail(`${label} failed: ${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
}

/** Only the regular-file USTAR output used by our pinned packer is accepted. No extraction. */
function packedFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const files = new Map();
  let at = 0;
  const text = (header, start, end) => header.subarray(start, end).toString().replace(/\0.*$/s, "");
  const octal = (value) => {
    if (!/^[0-7]+$/.test(value.trim())) fail("unsupported tar number");
    return Number.parseInt(value, 8);
  };
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) {
      if (!tar.subarray(at).every((b) => b === 0)) fail("unsupported tar trailer");
      return files;
    }
    const checksum = octal(text(header, 148, 156));
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== actual) fail("invalid tar checksum");
    const prefix = text(header, 345, 500);
    const name = (prefix ? `${prefix}/` : "") + text(header, 0, 100);
    if (!name.startsWith("package/") || name.split("/").includes("..") || name.includes("\\"))
      fail("unsafe packed path");
    const size = octal(text(header, 124, 136));
    const type = text(header, 156, 157);
    if (type !== "0" && type !== "" && type !== "5") fail("unsupported packed entry type");
    if (at + 512 + size > tar.length) fail("truncated packed file");
    if (type !== "5") {
      const path = name.slice(8);
      if (!path || files.has(path)) fail("duplicate packed path");
      files.set(path, tar.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  fail("truncated packed archive");
}

function boundary() {
  const contracts = json(join(root, "scripts/public-packages.json"));
  if (
    contracts.schemaVersion !== 1 ||
    contracts.packages.length !== 1 ||
    contracts.packages[0].name !== "@openconditions/ocpi"
  )
    fail("unsupported public allowlist");
  const contract = contracts.packages[0];
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true }).filter((p) =>
    p.isDirectory(),
  );
  for (const p of packages) {
    const m = json(join(root, "packages", p.name, "package.json"));
    if (m.name !== contract.name && m.private !== true)
      fail(`unqualified package must be private: ${m.name}`);
  }
  if (json(join(root, contract.directory, "package.json")).private !== false)
    fail("public candidate is private");
  return { contract, typescript: contracts.consumerTypeScript };
}

function validate(files, contract) {
  const manifestBytes = files.get("package.json");
  if (!manifestBytes) fail("missing packed file package.json");
  const m = JSON.parse(manifestBytes.toString());
  if (m.name !== contract.name) fail(`package not allowlisted: ${m.name}`);
  if (m.private !== false) fail("private or unspecified packed candidate");
  for (const name of contract.files) if (!files.has(name)) fail(`missing packed file ${name}`);
  for (const name of files.keys())
    if (!contract.files.includes(name)) fail(`unsupported packed output ${name}`);
  equal(m.exports, contract.exports, "unsupported packed exports");
  equal(
    [m.main, m.module, m.types],
    ["./dist/index.cjs", "./dist/index.js", "./dist/index.d.ts"],
    "unsupported entry metadata",
  );
  equal(m.dependencies, contract.dependencies, "unsupported runtime/type dependency");
  equal(m.optionalDependencies ?? {}, {}, "unsupported optional dependency");
  equal(m.peerDependencies ?? {}, {}, "unsupported peer dependency");
  const source = json(join(root, contract.directory, "package.json"));
  equal(m.version, source.version, "unsupported candidate version");
  equal(m.repository, source.repository, "unsupported repository metadata");
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const [name, version] of Object.entries(m[field] ?? {})) {
      if (typeof version !== "string" || /^(workspace:|file:|link:)/.test(version))
        fail(`unsupported dependency ${name}`);
      if (field !== "devDependencies" && name.startsWith("@openconditions/"))
        fail(`unqualified dependency ${name}`);
    }
  }
  for (const name of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"])
    if (m.scripts?.[name]) fail("unsupported packed lifecycle script");
  if (m.license !== "Apache-2.0" || sha256(files.get("LICENSE")) !== contract.licenseSha256)
    fail("packed license mismatch");
  if (
    m.engines?.node !== ">=24" ||
    m.type !== "module" ||
    m.repository?.directory !== "packages/ocpi"
  )
    fail("unsupported packed metadata");
  for (const [name, bytes] of files) {
    if (!name.startsWith("dist/")) continue;
    if (/@openconditions\/|__tests__|AGPL|conformance/.test(bytes.toString()))
      fail(`packed code boundary leak: ${name}`);
    if (name.endsWith(".map")) {
      const map = JSON.parse(bytes.toString());
      if (
        !Array.isArray(map.sources) ||
        map.sources.some((s) => !/^\.\.\/src\/(index|decode|digitraffic|ocpdb|types)\.ts$/.test(s))
      )
        fail("unsupported bundled source closure");
    }
  }
  return m;
}

// Static consumer programs. Candidate names/expectations are JSON data, never executable interpolation.
const runtimeProbe = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const contract = JSON.parse(readFileSync(new URL("./contract.json", import.meta.url)));
const api = process.argv[2] === "cjs" ? createRequire(import.meta.url)(contract.name) : await import(contract.name);
assert.deepEqual(Object.keys(api).sort(), contract.runtimeExports);
assert.equal(api.text(" x "), "x"); assert.equal(api.num("1,5"), 1.5); assert.equal(api.isRecord([]), false);
assert.equal(api.normaliseEmi3("de*abc*e123"), "DEABCE123");
const raw = { id: 7, coordinates: { latitude: "50", longitude: "6" }, last_updated: "2026-01-01T12:00:00", evses: [] };
const list = api.decodeOcpiList(Buffer.from(JSON.stringify({ status_code: 1000, data: [raw] })));
const location = api.normaliseLocation(list[0]);
assert.equal(location.id, "7"); assert.equal(location.last_updated, raw.last_updated);
assert.deepEqual(location.coordinates, { latitude: 50, longitude: 6 });
assert.throws(() => api.normaliseLocation({ id: "x" }), (e) => e instanceof api.OcpiDecodeError && e.reason === "no_geometry");
assert.throws(() => api.decodeOcpiList(Buffer.from("<html>")), api.OcpiDecodeError);
assert.throws(() => api.decodeOcpiList(Buffer.from('{"status_code":2001,"data":[]}')), api.OcpiDecodeError);
const tariff = api.normaliseTariff({ id: "T", currency: "eur", elements: [{ price_components: [{ type: "ENERGY", price: 0.5 }], restrictions: { unknown_rule: true } }] });
assert.equal(tariff.currency, "EUR"); assert.deepEqual(tariff.elements[0].restrictions.unreadable, ["unknown_rule"]);
assert.equal(api.connectorPowerKw({ id: "1", max_electric_power: 22000 }), 22);
assert.throws(() => api.normaliseTariff({ id: "x" }), api.OcpiDecodeError);
const feature = { properties: { id: "D", evses: [] }, geometry: { coordinates: [6, 50] } };
assert.equal(api.digitrafficLocation(feature).id, "D"); assert.equal(api.fromDigitraffic([feature]).length, 1);
let malformed = 0;
assert.equal(api.digitrafficStatuses(Buffer.from('{"statuses":[{"evseId":"E","status":"available"},{}]}'), () => malformed++).length, 1);
assert.equal(api.digitrafficTariffs(Buffer.from('{"tariffs":[{"id":"T","currency":"EUR","elements":[]}]}')).length, 1);
assert.equal(malformed, 1);
assert.deepEqual(api.ocpdbAssociations(Buffer.from('[{"id":"T","evses":[{"evse_uid":"E"}]}]')).get("E"), ["T"]);
assert.equal(api.ocpdbSources(Buffer.from('[{"uid":"S","name":"Source"}]')).get("S").name, "Source");
`;
const typeProbe = `import * as ocpi from "@openconditions/ocpi";
import { Buffer } from "node:buffer";
export const locations: ocpi.OcpiLocation[] = ocpi.decodeOcpiList<unknown>(Buffer.from("[]")).map(ocpi.normaliseLocation);
export type PublicTypes = [ocpi.RawRecord, ocpi.DigitrafficStatus, ocpi.OcpdbSource, ocpi.OcpiPrice, ocpi.OcpiDisplayText, ocpi.OcpiImage, ocpi.OcpiBusinessDetails, ocpi.OcpiGeoPoint, ocpi.OcpiAdditionalGeoLocation, ocpi.OcpiStatusSchedule, ocpi.OcpiEvseParking, ocpi.OcpiParking, ocpi.OcpiRegularHours, ocpi.OcpiExceptionalPeriod, ocpi.OcpiOpeningTimes, ocpi.OcpiConnector, ocpi.OcpiEvse, ocpi.OcpiLocation, ocpi.OcpiEnergySource, ocpi.OcpiEnvironmentalImpact, ocpi.OcpiEnergyMix, ocpi.OcpiPriceComponent, ocpi.OcpiRestrictions, ocpi.OcpiTariffElement, ocpi.OcpiTariff];
`;

const declarationProbe = `
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const contract = JSON.parse(readFileSync("contract.json", "utf8"));
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(parsed.fileNames, parsed.options);
const path = ts.resolveModuleName(contract.name, resolve("probe.mts"), parsed.options, ts.sys).resolvedModule.resolvedFileName;
const checker = program.getTypeChecker();
const symbol = checker.getSymbolAtLocation(program.getSourceFile(path));
assert.deepEqual(checker.getExportsOfModule(symbol).map(s => s.name).sort(), [...contract.runtimeExports, ...contract.typeExports].sort());
`;

function consumer(bytes, contract, typescript, readme) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "oc-public-consumer-"));
  if (!relative(root, dir).startsWith("..")) fail("consumer must be outside repository");
  try {
    writeFileSync(join(dir, "candidate.tgz"), bytes);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { [contract.name]: "file:./candidate.tgz" },
        devDependencies: { typescript, "@types/node": contract.dependencies["@types/node"] },
      }),
    );
    writeFileSync(join(dir, "empty.npmrc"), "");
    console.error("Checking external consumer");
    run(
      "pnpm",
      [
        "--ignore-workspace",
        "--userconfig",
        join(dir, "empty.npmrc"),
        "install",
        "--ignore-scripts",
        "--strict-peer-dependencies",
        "--prefer-offline",
        "--registry",
        "https://registry.npmjs.org",
      ],
      dir,
      "external install",
    );
    const installed = realpathSync(join(dir, "node_modules/@openconditions/ocpi"));
    if (!relative(dir, installed).startsWith("node_modules/"))
      fail("workspace link leaked into consumer");
    writeFileSync(join(dir, "contract.json"), JSON.stringify(contract));
    writeFileSync(join(dir, "probe.mjs"), runtimeProbe);
    for (const mode of ["esm", "cjs"])
      run(process.execPath, ["probe.mjs", mode], dir, `external ${mode}`);
    const examples = readme
      .split("```js\n")
      .slice(1)
      .map((part) => part.split("```")[0]);
    if (examples.length === 0) fail("packed README examples missing");
    for (const [index, example] of examples.entries()) {
      const file = `example-${index}.mjs`;
      writeFileSync(join(dir, file), example);
      run(process.execPath, [file], dir, "packed README example");
    }
    for (const extension of ["mts", "cts"])
      writeFileSync(join(dir, `probe.${extension}`), typeProbe);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: ["node"],
        },
        files: ["probe.mts", "probe.cts"],
      }),
    );
    run(
      process.execPath,
      [join(dir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
      dir,
      "external strict types",
    );
    writeFileSync(join(dir, "declarations.mjs"), declarationProbe);
    run(process.execPath, ["declarations.mjs"], dir, "external declaration exports");
    return {
      isolation: "outside monorepo; installed tarball copy; lifecycle scripts disabled",
      installedSha256: sha256(readFileSync(join(dir, "candidate.tgz"))),
      consumerLock: readFileSync(join(dir, "pnpm-lock.yaml"), "utf8"),
      consumerTools: {
        typescript: json(join(dir, "node_modules/typescript/package.json")).version,
        nodeTypes: json(join(dir, "node_modules/@types/node/package.json")).version,
      },
      consumer: ["esm", "cjs", "strict-types"],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!["--tarball", "--sha256", "--output"].includes(key) || !args[0] || options[key])
      fail(`unsupported argument ${key}`);
    options[key] = args.shift();
  }
  const { contract, typescript } = boundary();
  const manager = json(join(root, "package.json")).packageManager;
  equal(run("pnpm", ["--version"], root).trim(), manager.split("@")[1], "pinned pnpm required");
  let tarball;
  let output = options["--output"] ? resolve(options["--output"]) : undefined;
  if (output) mkdirSync(output, { recursive: true });
  if (options["--tarball"]) {
    if (!/^[a-f0-9]{64}$/.test(options["--sha256"] ?? "")) fail("supplied mode requires --sha256");
    tarball = resolve(options["--tarball"]);
  } else {
    if (options["--sha256"]) fail("--sha256 requires --tarball");
    output = output ?? mkdtempSync(join(tmpdir(), "oc-public-candidate-"));
    mkdirSync(output, { recursive: true });
    if (readdirSync(output).length !== 0) fail("pack output must be empty");
    run("pnpm", ["--filter", "@openconditions/ocpi...", "build"], root, "candidate build");
    run(
      "pnpm",
      ["--dir", contract.directory, "pack", "--pack-destination", output],
      root,
      "candidate pack",
    );
    const source = json(join(root, contract.directory, "package.json"));
    tarball = join(
      output,
      `${source.name.replace("@", "").replace("/", "-")}-${source.version}.tgz`,
    );
  }
  const inputPaths = [
    "package.json",
    "pnpm-lock.yaml",
    "scripts/public-packages.json",
    "packages/ocpi/package.json",
    "packages/ocpi/tsup.config.ts",
    "packages/ocpi/LICENSE",
    "packages/ocpi/NOTICE",
    "packages/ocpi/README.md",
    ...readdirSync(join(root, "packages/ocpi/src"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `packages/ocpi/src/${f}`),
  ];
  const inputHashes = Object.fromEntries(
    inputPaths.map((path) => [path, sha256(readFileSync(join(root, path)))]),
  );
  const bytes = readFileSync(tarball);
  const hash = sha256(bytes);
  if (options["--sha256"] && options["--sha256"] !== hash) fail("candidate hash mismatch");
  const files = packedFiles(bytes);
  const m = validate(files, contract);
  const proof = consumer(bytes, contract, typescript, files.get("README.md").toString());
  if (sha256(readFileSync(tarball)) !== hash) fail("candidate changed during qualification");
  equal(
    Object.fromEntries(inputPaths.map((path) => [path, sha256(readFileSync(join(root, path)))])),
    inputHashes,
    "qualification inputs changed",
  );
  const receipt = {
    inputHashes,
    name: m.name,
    version: m.version,
    mode: options["--tarball"] ? "supplied" : "pack",
    tarball,
    sha256: hash,
    files: [...files.keys()].sort(),
    runtimeExports: contract.runtimeExports,
    ...proof,
    source: run("git", ["rev-parse", "HEAD"], root).trim(),
    indexTree: run("git", ["write-tree"], root).trim(),
    workingTreeStatus: run("git", ["status", "--porcelain"], root),
    node: process.version,
    packageManager: manager,
    publicationAuthorized: false,
  };
  if (output)
    writeFileSync(join(output, "qualification.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
    });
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
