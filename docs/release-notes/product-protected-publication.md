# Simple protected product releases

Affected versions: Future product releases using this workflow; no version is selected here.

Action: Use Actions → Product release: prepare a version and notes, review/merge its normal PR, inspect review results, then explicitly select publish and approve the native environment gate. Configure the maintainer approval environment and release immutability once before first publication.

Compatibility: Original tested images are promoted without rebuilding. Source/image identity, exact metadata paths, manifests, license/privacy boundaries and conflict checks remain. Existing latest/history consumers are unchanged; stable never advances implicitly.

Caveats: Tests cover bounded default-service installation/recovery and representative rights/privacy. Actual prior-deployment upgrades, optional federation/TUF, live providers and other platforms are not certified. Preview updates sequentially after a complete immutable release. Inspect partial native state before resuming an identical unexpired candidate. No App/PAT, passing readiness JSON or per-release administrative credential is required.
