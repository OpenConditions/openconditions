import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

it.each([undefined, "pg16", "pg18"])(
  "selects %s outside Vitest in a real Node process",
  (profile) => {
    const env = { ...process.env };
    if (profile === undefined) delete env["OC_TEST_POSTGIS_PROFILE"];
    else env["OC_TEST_POSTGIS_PROFILE"] = profile;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { postgisProfile, POSTGIS_IMAGES } from '@openconditions/test-database/profile';
    const profile = postgisProfile();
    console.log(JSON.stringify({ profile, image: POSTGIS_IMAGES[profile] }));
  `,
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const selected = JSON.parse(result.stdout);
    expect(selected.profile).toBe(profile ?? "pg16");
    expect(selected.image).toBe(
      profile === "pg18"
        ? "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8"
        : "postgis/postgis:16-3.4",
    );
  },
);

it.each(["", "PG18", "pg18 ", "unsupported"])(
  "rejects %s before a process reaches startup",
  (profile) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { postgisProfile } from '@openconditions/test-database/profile';
    postgisProfile();
    console.log('would-start-container');
  `,
      ],
      { cwd: root, env: { ...process.env, OC_TEST_POSTGIS_PROFILE: profile }, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported OC_TEST_POSTGIS_PROFILE");
    expect(result.stdout).not.toContain("would-start-container");
  },
);
