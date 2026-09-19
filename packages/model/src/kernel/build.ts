import { Schedule } from "../schedule/schedule.js";
import { effectBaseShape, issueSchema } from "./effect.js";
import { AlertCRef, DirectionRef, LaneRef, LinearRef, locationSchemas } from "./location.js";
import {
  Attribution,
  EvidenceSummary,
  Freshness,
  MergedSource,
  OriginHop,
  provenanceSchema,
  Relation,
  RoutingRights,
  Tombstone,
} from "./provenance.js";
import { Result } from "./result.js";
import {
  Geometry,
  LocalizedText,
  Money,
  PointGeometry,
  Quantity,
  RecordRef,
  Text,
  valueObjectSchemas,
} from "./scalars.js";
import { Validity } from "./validity.js";
import { vehicleSchemas } from "./vehicle.js";
import type { Vocab } from "./vocab.js";

/**
 * Every kernel value-object schema, built against one vocabulary resolver.
 * Effect variants receive this object in their shape factories; kind details
 * receive it plus the registry's assembled `Effect` union (`Kernel`), so domain
 * schemas reuse the kernel's value objects with the registry's closed vocabularies.
 */
export function buildKernelBase(vocab: Vocab) {
  const vo = valueObjectSchemas(vocab);
  const loc = locationSchemas(vocab, vo);
  const vehicle = vehicleSchemas(vocab);
  return {
    vocab,
    LocalizedText,
    Text,
    Quantity,
    Money,
    RecordRef,
    Geometry,
    PointGeometry,
    ...vo,
    DirectionRef,
    LaneRef,
    LinearRef,
    AlertCRef,
    ...loc,
    Schedule,
    Validity,
    Attribution,
    RoutingRights,
    OriginHop,
    MergedSource,
    Freshness,
    Relation,
    EvidenceSummary,
    Tombstone,
    Provenance: provenanceSchema(vocab, "stored"),
    ProvenanceDraft: provenanceSchema(vocab, "draft"),
    ...vehicle,
    Issue: issueSchema(vocab),
    effectBaseShape: effectBaseShape(vocab, loc, vehicle),
    Result,
  };
}

export type KernelBase = ReturnType<typeof buildKernelBase>;
