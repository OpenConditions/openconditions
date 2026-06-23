import type { GeoJsonGeometry } from "@openconditions/core";
import type { OpenLrLocation } from "./decode.js";

export type { GeoJsonGeometry };

/** Contract for a map-matching client that resolves an OpenLR location to geometry. */
export interface MapMatchClient {
  /**
   * Resolve an OpenLR location to a GeoJSON geometry via the remote resolver.
   *
   * Returns null when the resolver finds no match (HTTP 404) or when the
   * location cannot be projected onto the road network.
   */
  resolve(loc: OpenLrLocation): Promise<GeoJsonGeometry | null>;
}

interface ResolveSuccessBody {
  geometry: GeoJsonGeometry;
  confidence: number;
}

/**
 * Create an HTTP client that delegates map-matching to the openlr-resolver
 * service at `baseUrl`.
 *
 * Wire contract: POST <baseUrl>/resolve
 *   body: { location: OpenLrLocation }
 *   response 200: { geometry: GeoJSON, confidence: number }
 *   response 404: no match
 */
export function createResolverClient(baseUrl: string): MapMatchClient {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/resolve`;

  return {
    async resolve(loc: OpenLrLocation): Promise<GeoJsonGeometry | null> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: loc }),
      });

      if (res.status === 404) {
        return null;
      }

      if (!res.ok) {
        throw new Error(`openlr-resolver responded with ${res.status} ${res.statusText}`);
      }

      const body = (await res.json()) as ResolveSuccessBody;
      return body.geometry;
    },
  };
}
