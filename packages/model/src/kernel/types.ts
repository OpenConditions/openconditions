import type { z } from "zod";
import type { KernelBase } from "./build.js";

/** Static TS types of the vocabulary-dependent kernel schemas (extensible vocabularies are `string`). */
export type ExternalId = z.output<KernelBase["ExternalId"]>;
export type Organization = z.output<KernelBase["Organization"]>;
export type Address = z.output<KernelBase["Address"]>;
export type RoadRef = z.output<KernelBase["RoadRef"]>;
export type LocationRef = z.output<KernelBase["LocationRef"]>;
export type Provenance = z.output<KernelBase["Provenance"]>;
export type VehicleSelector = z.output<KernelBase["VehicleSelector"]>;
export type VehicleApplicability = z.output<KernelBase["VehicleApplicability"]>;
export type Issue = z.output<KernelBase["Issue"]>;
