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
/** Actual credited originator, with the same bounded safe URL contract. */
export const AttributionPublisher = z.strictObject({ name: text, url: url.optional() });
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
/** Portable producer-reviewed presentation metadata; not permission policy. */
export const AttributionPolicy = z
  .strictObject({
    placement: z.enum(["visible", "details"]),
    surfaces: z
      .array(z.enum(["map", "content", "image"]))
      .min(1)
      .max(3)
      .refine((items) => new Set(items).size === items.length),
    basis: z.enum(["licence", "provider-terms", "recommendation", "unresolved"]),
    reviewedAt: z.iso.date(),
    evidenceUrls: z.array(url).min(1).max(8),
    reason: z.string().min(1).max(2_000),
    compactText: z.string().min(1).max(2_000).optional(),
    logo: z.enum(["openweather", "mapillary", "maptiler", "tdx"]).optional(),
    prominence: z.literal("normal").optional(),
    includePublisher: z.literal(true).optional(),
  })
  .refine(
    (value) =>
      (value.basis !== "unresolved" || value.compactText === undefined) &&
      (value.placement !== "details" ||
        (value.basis !== "unresolved" &&
          value.compactText === undefined &&
          value.logo === undefined &&
          value.prominence === undefined &&
          value.includePublisher === undefined)),
  );
export type AttributionPolicy = z.infer<typeof AttributionPolicy>;

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
        attribution: AttributionPolicy.optional(),
      }),
    )
    .max(64),
});
export type Licensing = z.infer<typeof Licensing>;

export type LicenseDescriptor = z.infer<typeof LicenseDescriptor>;

/** Preserve an independently captured terms link as evidence without inventing a grant. */
export function creditLicensingOf(captured: {
  licensing?: Licensing;
  license?: string;
  licenseUrl?: string;
}): Licensing | undefined {
  const { licensing, license, licenseUrl } = captured;
  if (
    !licenseUrl ||
    licensing?.declarations?.some((d) => d.url === licenseUrl) ||
    licensing?.bindings.some((b) => b.license.url === licenseUrl)
  )
    return licensing;
  const declarations = [...(licensing?.declarations ?? [])];
  const matched =
    license === undefined
      ? -1
      : declarations.findIndex((d) => d.text === license && d.url === undefined);
  if (matched >= 0) declarations[matched] = { ...declarations[matched], url: licenseUrl };
  else {
    if (license !== undefined && license.length > 1000)
      throw new RangeError("captured licence declaration exceeds portable text capacity");
    declarations.push({ ...(license === undefined ? {} : { text: license }), url: licenseUrl });
  }
  if (declarations.length > 64)
    throw new RangeError("captured licence URL exceeds portable declaration capacity");
  return { ...(licensing ?? { version: 1 as const, bindings: [] }), declarations };
}
