import { generate } from "./canonical-package-version.mjs";

try {
  if (process.argv.slice(2).some((a) => a !== "--check"))
    throw Error("version-public-packages [--check]");
  console.log(JSON.stringify(generate(process.cwd(), process.argv.includes("--check"))));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
