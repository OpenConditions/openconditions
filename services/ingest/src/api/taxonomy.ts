import type { Mappings, Registry } from "@openconditions/model";

/**
 * The running registry as a client reads it: domains, kinds with their types
 * and subtypes, properties with their result, effects, vocabularies with
 * their values, and the external vocabularies something crosswalks to.
 * Descriptions are the registry's own; nothing here is a second source of
 * truth.
 */
export function taxonomyOf(registry: Registry) {
  const targets = new Set<string>();
  const collect = (mappings: Mappings | undefined) => {
    for (const target of Object.keys(mappings ?? {})) targets.add(target);
  };
  const kinds = registry.kinds().map((k) => {
    collect(k.mappings);
    for (const m of Object.values(k.typeMappings ?? {})) collect(m);
    return {
      class: k.class,
      code: k.code,
      ...(k.domain ? { domain: k.domain } : {}),
      version: k.version,
      description: k.description,
      ...(k.labels ? { labels: k.labels } : {}),
      types: k.types ?? {},
    };
  });
  const vocabularies = registry.vocabularies().map((v) => {
    for (const m of Object.values(v.valueMappings)) collect(m);
    return { code: v.code, description: v.description, values: v.values };
  });
  const properties = registry.properties().map((p) => {
    collect(p.mappings);
    return {
      code: p.code,
      domain: p.domain,
      version: p.version,
      description: p.description,
      result: p.result,
    };
  });
  return {
    kernelVersion: registry.kernelVersion,
    modules: registry.modules,
    domains: registry.domains().map((d) => ({ code: d.code, description: d.description })),
    kinds,
    properties,
    effects: registry.effects().map((e) => ({
      code: e.code,
      version: e.version,
      description: e.description,
    })),
    vocabularies,
    crosswalkTargets: [...targets].sort(),
  };
}
