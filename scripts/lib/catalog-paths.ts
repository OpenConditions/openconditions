import { fileURLToPath } from "node:url";

/** The repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The baked feed catalogue: `<domain>/<region>.jsonc` and `credentials.jsonc`. */
export const FEEDS_DIR = fileURLToPath(new URL("../../feeds", import.meta.url));

/** The generated JSON Schemas the catalogue files name in `$schema`. */
export const FEED_SCHEMA_DIR = fileURLToPath(new URL("../../feeds/schema", import.meta.url));
