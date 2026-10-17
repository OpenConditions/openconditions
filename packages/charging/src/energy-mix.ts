import { OCPI_ENERGY_IMPACTS, OCPI_ENERGY_SOURCES } from "@openconditions/model-charging";
import type { OcpiEnergyMix } from "@openconditions/ocpi";
import { clean, own } from "./records.js";

/** An energy mix as a parser reads it, before `energyMixDraft` checks it. */
export interface EnergyMixInput {
  isGreen?: boolean;
  supplierName?: string;
  productName?: string;
  sources?: { source: string; pct: number }[];
  impacts?: { category: "nuclear_waste" | "carbon_dioxide"; gPerKwh: number }[];
}

/**
 * An energy mix as the model's `EnergyMix` holds it: blank names, shares
 * outside 0 to 100 and negative impacts left out. Undefined when it says
 * nothing.
 */
export function energyMixDraft(
  mix: EnergyMixInput | undefined,
): Record<string, unknown> | undefined {
  if (mix === undefined) return undefined;
  const supplierName = clean(mix.supplierName);
  const productName = clean(mix.productName);
  const sources = (mix.sources ?? []).filter((s) => s.pct >= 0 && s.pct <= 100);
  const impacts = (mix.impacts ?? []).filter((i) => Number.isFinite(i.gPerKwh) && i.gPerKwh >= 0);
  const out = {
    ...(mix.isGreen === undefined ? {} : { isGreen: mix.isGreen }),
    ...(supplierName === undefined ? {} : { supplierName }),
    ...(productName === undefined ? {} : { productName }),
    ...(sources.length === 0 ? {} : { sources: sources.map((s) => ({ ...s })) }),
    ...(impacts.length === 0 ? {} : { impacts: impacts.map((i) => ({ ...i })) }),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * An OCPI energy mix (of a location or a tariff) as read: its sources and
 * impacts of a category OCPI defines, each other one counted in `unread`.
 */
export function ocpiEnergyMix(
  mix: OcpiEnergyMix | undefined,
  unread: () => void,
): EnergyMixInput | undefined {
  if (mix === undefined) return undefined;
  const sources = (mix.energy_sources ?? []).flatMap((s) => {
    const source = own(OCPI_ENERGY_SOURCES, s.source);
    if (source === undefined) unread();
    return source === undefined ? [] : [{ source, pct: s.percentage }];
  });
  const impacts = (mix.environ_impact ?? []).flatMap((i) => {
    const category = own(OCPI_ENERGY_IMPACTS, i.category);
    if (category === undefined) unread();
    return category === undefined
      ? []
      : [{ category: category as "nuclear_waste" | "carbon_dioxide", gPerKwh: i.amount }];
  });
  return {
    ...(mix.is_green_energy === undefined ? {} : { isGreen: mix.is_green_energy }),
    ...(mix.supplier_name === undefined ? {} : { supplierName: mix.supplier_name }),
    ...(mix.energy_product_name === undefined ? {} : { productName: mix.energy_product_name }),
    ...(sources.length === 0 ? {} : { sources }),
    ...(impacts.length === 0 ? {} : { impacts }),
  };
}
