import parseExpression from "spdx-expression-parse";
import licenses from "spdx-license-list";
import { z } from "zod";

const text = z.string().min(1).max(1_000);
const credentialParameters = new Set([
  "access_token",
  "api_key",
  "apikey",
  "client_secret",
  "credential",
  "key",
  "password",
  "secret",
  "sig",
  "signature",
  "token",
  "x-amz-signature",
  "x-goog-signature",
]);
const url = z
  .url()
  .max(2_048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      ![...parsed.searchParams.keys()].some((key) => credentialParameters.has(key.toLowerCase()))
    );
  });
const expression = text.refine((value) => {
  if ((value.match(/\(/g)?.length ?? 0) > 32) return false;
  try {
    const pending = [parseExpression(value)];
    while (pending.length) {
      const node = pending.pop()!;
      if ("license" in node) {
        if (!Object.hasOwn(licenses, node.license) || node.license === "CC-PDM-1.0") return false;
      } else pending.push(node.left, node.right);
    }
    return true;
  } catch {
    return false;
  }
}, "Invalid standard licence expression");

/** Captured display metadata. Permission decisions continue to use reviewed policy IDs. */
export const LicenseDescriptor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("spdx"), expression, url: url.optional() }),
  z.strictObject({
    kind: z.literal("custom"),
    id: text.regex(/^LicenseRef-[A-Za-z0-9.-]+$/),
    namespace: text.regex(/^[A-Za-z0-9][A-Za-z0-9:./_-]{0,255}$/),
    name: text,
    url: url.optional(),
    version: text.optional(),
  }),
  z.strictObject({ kind: z.literal("unknown"), raw: text.optional(), url: url.optional() }),
  z.strictObject({ kind: z.literal("per-item"), raw: text.optional(), url: url.optional() }),
  z.strictObject({ kind: z.literal("public-domain"), name: text, url: url.optional() }),
  z.strictObject({ kind: z.literal("status"), id: z.literal("CC-PDM-1.0"), url: url.optional() }),
]);
export const Licensing = z.strictObject({
  version: z.literal(1),
  declarations: z
    .array(
      z
        .strictObject({ text: text.optional(), url: url.optional() })
        .refine((value) => value.text !== undefined || value.url !== undefined),
    )
    .max(64)
    .optional(),
  bindings: z
    .array(
      z.strictObject({
        scope: z.enum(["data", "imagery", "style", "software", "service"]),
        subject: text,
        license: LicenseDescriptor,
        notice: z.string().min(1).max(16_000).optional(),
        conditions: z.array(text).max(32).optional(),
      }),
    )
    .max(64),
});
export type Licensing = z.infer<typeof Licensing>;

export type LicenseDescriptor = z.infer<typeof LicenseDescriptor>;
