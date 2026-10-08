import type { SourceTable } from "@openconditions/model";

/** OICP `EVSEStatus` codes → OpenConditions values; occupied stays occupied. */
export const OICP_EVSE_STATUSES: SourceTable = {
  Available: "available",
  Occupied: "occupied",
  Reserved: "reserved",
  OutOfService: "out_of_order",
  Unknown: "unknown",
  EvseNotFound: "unknown",
};
