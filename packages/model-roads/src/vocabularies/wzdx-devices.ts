/** WZDx 4.2 device feed vocabularies, verbatim from `schemas/4.2/DeviceFeed.json` (https://github.com/usdot-jpo-ode/wzdx). */
export const WZDX_DEVICES = {
  version: "4.2",
  fieldDeviceTypes: [
    "arrow-board",
    "camera",
    "dynamic-message-sign",
    "flashing-beacon",
    "hybrid-sign",
    "location-marker",
    "traffic-sensor",
    "traffic-signal",
  ],
  fieldDeviceStatuses: ["ok", "warning", "error", "unknown"],
} as const;
