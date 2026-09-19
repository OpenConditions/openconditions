import { z } from "zod";
import { Schedule } from "../schedule/schedule.js";
import { Iso8601 } from "./scalars.js";

export const VALIDITY_STATUSES = [
  "planned",
  "active",
  "suspended",
  "ended",
  "cancelled",
  "unknown",
] as const;
export const ENDED_REASONS = [
  "source_ended",
  "withdrawn_from_feed",
  "expired",
  "superseded",
  "cancelled",
  "stale",
] as const;

/**
 * `start`/`end` are the source's declared bounds; `estimatedEnd` a source
 * estimate. `status` is the source's declared lifecycle; whether the record is
 * in effect at an instant is always computed at the edge from start/end/
 * periods/exceptions (`isValidityInEffectAt`), never read from `status`. Each
 * Schedule carries its own `scheduleTimezone`.
 */
export const Validity = z
  .strictObject({
    status: z.enum(VALIDITY_STATUSES),
    start: Iso8601.optional(),
    end: Iso8601.optional(),
    estimatedEnd: Iso8601.optional(),
    startVerified: z.boolean().optional(),
    endVerified: z.boolean().optional(),
    periods: z.array(Schedule).min(1).optional(),
    exceptions: z.array(Schedule).min(1).optional(),
    endedReason: z.enum(ENDED_REASONS).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.start !== undefined && v.end !== undefined && Date.parse(v.start) > Date.parse(v.end)) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "end precedes start" });
    }
  });

export type Validity = z.infer<typeof Validity>;
