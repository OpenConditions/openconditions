import { drainSkipped, type SkipCounts } from "@openconditions/ingest-framework";
import { parseDatexSituations } from "../../datex.js";
import { parseDatexMeasuredData } from "../../measuredData.js";
import type { RoadEvent, UnresolvedRoadEvent } from "../../model.js";
import type { SourceDescriptor } from "../../types.js";

/**
 * Minimal DATEX II situation documents of one record, in the shape each
 * version's schema gives them, for running the real parser over one value.
 */
export const DATEX_TEST_SOURCE: SourceDescriptor = {
  id: "xx-datex-records",
  country: "NL",
  attribution: "test",
  license: "CC0-1.0",
};

export type DatexVersion = "v2" | "v3";

export interface RecordSpec {
  /** The record's `xsi:type`; omitted when `null`. */
  recordClass: string | null;
  /** Elements of the record's own class, written in the situation namespace. */
  body?: string;
  validityStatus?: string;
  probability?: string;
  severity?: string;
  causeType?: string;
  /** Replaces the `modelBaseVersion` the document declares. */
  modelBaseVersion?: string;
  /** Omits the record's `id`. */
  noId?: boolean;
  /** Omits the record's coordinates. */
  noGeometry?: boolean;
}

/** The element `name` with `value`, prefixed for the version, or nothing. */
const leaf = (prefix: string, name: string, value: string | undefined) =>
  value === undefined ? "" : `<${prefix}${name}>${value}</${prefix}${name}>`;

export function datexDocument(version: DatexVersion, spec: RecordSpec): string {
  const type =
    spec.recordClass === null
      ? ""
      : ` xsi:type="${version === "v3" ? "sit:" : ""}${spec.recordClass}"`;
  const id = spec.noId ? "" : ` id="R1"`;
  if (version === "v3") {
    const body = (spec.body ?? "").replaceAll("<:", "<sit:").replaceAll("</:", "</sit:");
    const location = spec.noGeometry
      ? ""
      : `<sit:locationReference xsi:type="loc:PointLocation"><loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>52.37</loc:latitude><loc:longitude>4.89</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates></sit:locationReference>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="sit:SituationPublication" lang="en" modelBaseVersion="${spec.modelBaseVersion ?? "3"}">
  <com:publicationTime>2026-09-18T09:00:00Z</com:publicationTime>
  <com:publicationCreator><com:country>nl</com:country><com:nationalIdentifier>TEST</com:nationalIdentifier></com:publicationCreator>
  <sit:situation id="S1">
    ${leaf("sit:", "overallSeverity", spec.severity)}
    <sit:headerInformation><com:informationStatus>real</com:informationStatus></sit:headerInformation>
    <sit:situationRecord${type}${id} version="1">
      <sit:situationRecordCreationTime>2026-09-18T08:00:00Z</sit:situationRecordCreationTime>
      <sit:situationRecordVersionTime>2026-09-18T08:00:00Z</sit:situationRecordVersionTime>
      <sit:probabilityOfOccurrence>${spec.probability ?? "certain"}</sit:probabilityOfOccurrence>
      <sit:validity>
        <com:validityStatus>${spec.validityStatus ?? "definedByValidityTimeSpec"}</com:validityStatus>
        <com:validityTimeSpecification><com:overallStartTime>2026-09-18T08:00:00Z</com:overallStartTime></com:validityTimeSpecification>
      </sit:validity>
      ${spec.causeType === undefined ? "" : `<sit:cause><sit:causeType>${spec.causeType}</sit:causeType></sit:cause>`}
      ${location}
      ${body}
    </sit:situationRecord>
  </sit:situation>
</d2:payload>`;
  }
  const body = (spec.body ?? "").replaceAll("<:", "<").replaceAll("</:", "</");
  const location = spec.noGeometry
    ? ""
    : `<groupOfLocations xsi:type="Point"><pointByCoordinates><pointCoordinates><latitude>52.37</latitude><longitude>4.89</longitude></pointCoordinates></pointByCoordinates></groupOfLocations>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="${spec.modelBaseVersion ?? "2"}">
  <exchange><supplierIdentification><country>nl</country><nationalIdentifier>TEST</nationalIdentifier></supplierIdentification></exchange>
  <payloadPublication xsi:type="SituationPublication" lang="en">
    <publicationTime>2026-09-18T09:00:00Z</publicationTime>
    <publicationCreator><country>nl</country><nationalIdentifier>TEST</nationalIdentifier></publicationCreator>
    <situation id="S1" version="1">
      ${leaf("", "overallSeverity", spec.severity)}
      <headerInformation><confidentiality>noRestriction</confidentiality><informationStatus>real</informationStatus></headerInformation>
      <situationRecord${type}${id} version="1">
        <situationRecordCreationTime>2026-09-18T08:00:00Z</situationRecordCreationTime>
        <situationRecordVersionTime>2026-09-18T08:00:00Z</situationRecordVersionTime>
        <probabilityOfOccurrence>${spec.probability ?? "certain"}</probabilityOfOccurrence>
        <validity>
          <validityStatus>${spec.validityStatus ?? "definedByValidityTimeSpec"}</validityStatus>
          <validityTimeSpecification><overallStartTime>2026-09-18T08:00:00Z</overallStartTime></validityTimeSpecification>
        </validity>
        ${spec.causeType === undefined ? "" : `<cause xsi:type="NonManagedCause"><causeType>${spec.causeType}</causeType></cause>`}
        ${location}
        ${body}
      </situationRecord>
    </situation>
  </payloadPublication>
</d2LogicalModel>`;
}

/** The real parser over one record, with the skips it recorded. */
export function parseRecord(
  version: DatexVersion,
  spec: RecordSpec,
): { events: (RoadEvent | UnresolvedRoadEvent)[]; event?: RoadEvent; skipped: SkipCounts } {
  drainSkipped(DATEX_TEST_SOURCE.id);
  const events = parseDatexSituations(datexDocument(version, spec), DATEX_TEST_SOURCE);
  const skipped = drainSkipped(DATEX_TEST_SOURCE.id);
  return { events, event: events[0] as RoadEvent | undefined, skipped };
}

/** One measured value of a measured-data site: its `BasicData` type and content. */
export interface MeasuredValueSpec {
  type: string;
  /** Elements of the type, written in the version's namespace (`<:speed>` style). */
  body: string;
}

/**
 * A MeasuredDataPublication of one site, with the site's geometry inline,
 * each value at its own index: v2 `measuredValue/measuredValue/basicData`,
 * v3 `physicalQuantity/physicalQuantity/basicData`.
 */
export function measuredDocument(
  version: DatexVersion,
  values: readonly MeasuredValueSpec[],
  opts: { modelBaseVersion?: string; noGeometry?: boolean } = {},
): string {
  const p = version === "v3" ? "roa:" : "";
  const fill = (xml: string) => xml.replaceAll("<:", `<${p}`).replaceAll("</:", `</${p}`);
  const geometry = opts.noGeometry
    ? ""
    : fill(
        `<:locationReference><:gmlLineString><:posList>52.37 4.89 52.38 4.90</:posList></:gmlLineString></:locationReference>`,
      );
  const outer = version === "v3" ? "physicalQuantity" : "measuredValue";
  const indexed = values
    .map((v, i) =>
      fill(
        `<:${outer} index="${i + 1}"><:${outer}${version === "v3" ? ' xsi:type="roa:SinglePhysicalQuantity"' : ""}><:basicData xsi:type="${p}${v.type}">${v.body}</:basicData></:${outer}></:${outer}>`,
      ),
    )
    .join("");
  const site = fill(
    `<:siteMeasurements><:measurementSiteReference id="S1" version="1" targetClass="MeasurementSiteRecord"/><:measurementTimeDefault>2026-09-18T08:00:00Z</:measurementTimeDefault>${indexed}${geometry}</:siteMeasurements>`,
  );
  if (version === "v3") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:roa="http://datex2.eu/schema/3/roadTrafficData" xmlns:com="http://datex2.eu/schema/3/common" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="roa:MeasuredDataPublication" lang="en" modelBaseVersion="${opts.modelBaseVersion ?? "3"}">
  <com:publicationTime>2026-09-18T08:01:00Z</com:publicationTime>
  ${site}
</d2:payload>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="${opts.modelBaseVersion ?? "2"}">
  <payloadPublication xsi:type="MeasuredDataPublication" lang="en">
    <publicationTime>2026-09-18T08:01:00Z</publicationTime>
    ${site}
  </payloadPublication>
</d2LogicalModel>`;
}

/** The measured-data parser over one document, with the skips it recorded. */
export function parseMeasured(
  version: DatexVersion,
  values: readonly MeasuredValueSpec[],
  opts: { modelBaseVersion?: string; noGeometry?: boolean } = {},
) {
  drainSkipped(DATEX_TEST_SOURCE.id);
  const parsed = parseDatexMeasuredData(
    measuredDocument(version, values, opts),
    DATEX_TEST_SOURCE,
    undefined,
    { now: "2026-09-18T08:02:00Z", cadenceSec: 60 },
  );
  return { ...parsed, reading: parsed.readings[0], skipped: drainSkipped(DATEX_TEST_SOURCE.id) };
}
