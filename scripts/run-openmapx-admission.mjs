import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { communityServiceManifestProblems } = await import(pathToFileURL(process.argv[2]).href);
if (typeof communityServiceManifestProblems !== "function")
  throw Error("Missing actual admission export");
console.log(
  JSON.stringify(
    process.argv.slice(3).map((path) => ({
      path,
      problems: communityServiceManifestProblems(JSON.parse(readFileSync(path, "utf8"))),
    })),
  ),
);
