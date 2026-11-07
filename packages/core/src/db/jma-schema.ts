import { sql } from "drizzle-orm";
import { bigint, check, jsonb, primaryKey, text } from "drizzle-orm/pg-core";
import { conditionsSchema } from "./columns.js";

/** Shared by all JMA sources and workers using one explicitly identified egress IP. */
export const jmaBudget = conditionsSchema.table(
  "jma_budget",
  {
    egress: text("egress").notNull(),
    day: text("day").notNull(),
    used: bigint("used", { mode: "number" }).notNull().default(0),
    reserved: bigint("reserved", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.egress, t.day] }),
    check("jma_budget_nonnegative", sql`${t.used} >= 0 AND ${t.reserved} >= 0`),
  ],
);

/** Durable bodies avoid repeated file downloads even when later publication rolls back. */
export const jmaDownload = conditionsSchema.table("jma_download", {
  url: text("url").primaryKey(),
  value: jsonb("value").notNull(),
});

/** Lifecycle clocks, area tombstones and poll cursors share the canonical publication transaction. */
export const jmaState = conditionsSchema.table("jma_state", {
  source: text("source").primaryKey(),
  value: jsonb("value").notNull(),
});
