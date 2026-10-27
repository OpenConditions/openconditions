import type postgres from "postgres";

export type PostgisProfile = "pg16" | "pg18";

/** The image each explicit test profile runs; ordinary CI remains PG16. */
export const POSTGIS_IMAGES: Record<PostgisProfile, string> = {
  pg16: "postgis/postgis:16-3.4",
  pg18: "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8",
};

/** Read before constructing a container, preserving PG16 when unset. */
export function postgisProfile(): PostgisProfile {
  const profile = process.env["OC_TEST_POSTGIS_PROFILE"] ?? "pg16";
  if (profile !== "pg16" && profile !== "pg18") {
    throw new Error(`Unsupported OC_TEST_POSTGIS_PROFILE: ${profile}`);
  }
  return profile;
}

export function runsProfile(serverVersionNum: unknown, profile: PostgisProfile): boolean {
  return (
    typeof serverVersionNum === "string" &&
    /^\d+$/.test(serverVersionNum) &&
    Number.isSafeInteger(Number(serverVersionNum)) &&
    Math.floor(Number(serverVersionNum) / 10000) === (profile === "pg18" ? 18 : 16)
  );
}

/** Verify this owned server before migrations or test transactions, then record its identity. */
export async function assertPostgisProfile(
  sql: postgres.Sql,
  profile: PostgisProfile,
  owner: { fixture: string; containerId: string },
): Promise<void> {
  const [{ server_version_num } = {}] = await sql`SHOW server_version_num`;
  if (!runsProfile(server_version_num, profile)) {
    throw new Error(`Unexpected PostgreSQL version for ${profile}: ${String(server_version_num)}`);
  }
  console.info(
    "POSTGIS_PROFILE_VERIFIED",
    JSON.stringify({
      ...owner,
      profile,
      requestedImage: POSTGIS_IMAGES[profile],
      server_version_num,
    }),
  );
}
