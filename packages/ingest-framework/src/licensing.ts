import { type LicenseDescriptor, Licensing } from "@openconditions/model";
import { licenseInfo } from "./catalog/licenses.js";

/** Capture reviewed source metadata before storage; custom definitions are self-contained. */
export function captureLicensing(source: {
  id: string;
  name?: string;
  license: string;
  licenseUrl?: string;
  terms?: { notice?: string; note?: string };
}): Licensing {
  const info = licenseInfo(source.license);
  const url = source.licenseUrl ?? info?.url;
  const link = url ? { url } : {};
  const license: LicenseDescriptor =
    source.license === "NOASSERTION" || !info
      ? { kind: "unknown", raw: source.license, ...link }
      : source.license.startsWith("LicenseRef-")
        ? {
            kind: "custom",
            namespace: "openconditions:licences",
            id: info.id,
            name: info.name,
            ...link,
          }
        : { kind: "spdx", expression: info.id, ...link };
  return Licensing.parse({
    version: 1,
    declarations: [
      { text: source.license, ...(source.licenseUrl ? { url: source.licenseUrl } : {}) },
    ],
    bindings: [
      {
        scope: "data",
        subject: source.name ?? source.id,
        license,
        ...(source.terms?.notice ? { notice: source.terms.notice } : {}),
        ...(source.terms?.note ? { conditions: [source.terms.note] } : {}),
      },
    ],
  });
}
