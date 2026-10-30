import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { checkReleaseInputs } from "./check-release-inputs.mjs";

const semver = createRequire(import.meta.resolve("@changesets/cli/package.json"))("semver");
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const versions = input.history.map((tag) => semver.valid(tag));
if (!versions.length || versions.some((version) => !version))
  throw Error("unsupported or absent native version history");
const previousVersion = versions.sort(semver.rcompare)[0];
if (!semver.valid(input.version) || !semver.gt(input.version, previousVersion))
  throw Error("version must be unused and later than native history");
console.log(JSON.stringify(checkReleaseInputs({ ...input, previousVersion })));
