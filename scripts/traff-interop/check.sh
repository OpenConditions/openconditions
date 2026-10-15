#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
interop_tmp=$(mktemp -d "${TMPDIR:-/tmp}/oc-traff-interop.XXXXXX")
trap 'rm -rf "$interop_tmp"' EXIT
mkdir -p "$interop_tmp/jars" "$interop_tmp/classes" "$interop_tmp/feeds"

# Pinned independent reader and its declared runtime dependencies; never install into the workspace.
git clone --quiet https://gitlab.com/traffxml/libtraff.git "$interop_tmp/libtraff"
git -C "$interop_tmp/libtraff" checkout --quiet ae6e2ae72c6950949864306d64dabd8091bd0f15
curl --fail --silent --show-error --location \
  https://repo.maven.apache.org/maven2/org/simpleframework/simple-xml/2.7.1/simple-xml-2.7.1.jar \
  -o "$interop_tmp/jars/simple-xml.jar"
curl --fail --silent --show-error --location \
  https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/1.7.12/slf4j-api-1.7.12.jar \
  -o "$interop_tmp/jars/slf4j-api.jar"
node --input-type=module - "$interop_tmp" <<'JS'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
for (const [name, expected] of [
  ["simple-xml", "7a43d2d5e488e0dac57a6de0284df4413a4733365239649309c4b693f4e429f9"],
  ["slf4j-api", "0aee9a77a4940d72932b0d0d9557793f872e66a03f598e473f45e7efecdccf99"],
]) {
  const actual = createHash("sha256").update(readFileSync(`${process.argv[2]}/jars/${name}.jar`)).digest("hex");
  if (actual !== expected) throw new Error(`${name}: dependency digest mismatch`);
}
JS
find "$interop_tmp/libtraff/src" -name '*.java' -exec printf '"%s"\n' {} \; > "$interop_tmp/sources.txt"
java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}"
"${java_bin}javac" -cp "$interop_tmp/jars/*" -d "$interop_tmp/classes" \
  @"$interop_tmp/sources.txt" scripts/traff-interop/CheckTraff.java
pnpm exec tsx scripts/traff-interop/fixtures.ts "$interop_tmp/feeds"
"${java_bin}java" -cp "$interop_tmp/classes:$interop_tmp/jars/*" CheckTraff "$interop_tmp/feeds"
