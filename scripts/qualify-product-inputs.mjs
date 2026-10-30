import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseInputs } from "./check-release-inputs.mjs";

const semver = createRequire(import.meta.resolve("@changesets/cli/package.json"))("semver");
export function previousVersionForHistory(version, history) {
  const versions = history.map((tag) => semver.valid(tag));
  if (!versions.length || versions.some((value) => !value))
    throw Error("unsupported or absent native version history");
  const previousVersion = versions.sort(semver.rcompare)[0];
  if (semver.valid(version) !== version || !semver.gt(version, previousVersion))
    throw Error("version must be unused and later than native history");
  return previousVersion;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  console.log(
    JSON.stringify(
      checkReleaseInputs({
        ...input,
        previousVersion: previousVersionForHistory(input.version, input.history),
      }),
    ),
  );
}
