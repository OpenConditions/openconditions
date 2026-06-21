// monorepo-wired: verified in OpenMapX monorepo (apps/web), not compiled here.
// This file requires @openmapx/core createOverlayStore (zustand-based) which
// is unavailable in the standalone openconditions repo.
//
// When wired into the OpenMapX monorepo:
//   import { createOverlayStore } from "@openmapx/core";
//   export const useRoadConditionsStore = createOverlayStore({
//     overlayId: "road-conditions",
//     extra: {},
//   });

export {};
