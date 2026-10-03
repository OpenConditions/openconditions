import type { ChildFeed } from "@openconditions/ingest-framework";
import { z } from "zod";
import { roadsFeedShape } from "../feed-schema.js";

/**
 * A roads catalogue child as a resolver emits it and its snapshot stores it:
 * any roads feed field, plus the qualifier that names it, its name, its
 * endpoints and whether an operator approved it. Everything else is the
 * parent's.
 */
const roadChildSchema = z
  .object(roadsFeedShape)
  .partial()
  .extend({
    qualifier: roadsFeedShape.qualifier.unwrap(),
    name: roadsFeedShape.name,
    endpoints: roadsFeedShape.endpoints,
    selectionState: z.enum(["approved", "discovered"]),
  })
  .strict();

/** A resolver's children, checked; throws on a child that is not a roads child. */
export function roadChildren(raw: unknown): ChildFeed[] {
  return z.array(roadChildSchema).parse(raw) as ChildFeed[];
}
