// monorepo-wired: verified in OpenMapX monorepo (apps/web), not compiled here.
// This file requires React, MapLibre GL JS, and OpenMapX hooks (useStyleSyncedLayer,
// useLayerReanchor, useIntegrationAttribution) which are unavailable in the
// standalone openconditions repo. The tsconfig.json `include` list intentionally
// excludes this file to keep `typecheck` and `test` passing without React deps.
//
// When wired into the OpenMapX monorepo (deferred step), wire up as described below.

/*
import { useEffect, useRef, useState } from "react";
import { useMap } from "@openmapx/core";
import { useStyleSyncedLayer, useLayerReanchor } from "@openmapx/core";
import { useIntegrationAttribution } from "@openmapx/core";
import { useRoadConditionsStore } from "./store.js";
import { useDebouncedCallback } from "use-debounce";

const SEVERITY_COLOR: Record<string, string> = {
  low: "#FFC107",
  medium: "#FF9800",
  high: "#F4511E",
  critical: "#D32F2F",
  unknown: "#9E9E9E",
};

const SEVERITY_EXPR = [
  "match",
  ["get", "severity"],
  "low", SEVERITY_COLOR.low,
  "medium", SEVERITY_COLOR.medium,
  "high", SEVERITY_COLOR.high,
  "critical", SEVERITY_COLOR.critical,
  SEVERITY_COLOR.unknown,
] as const;

const SOURCE_ID = "road-conditions-source";
const LAYER_POINT = "road-conditions-points";
const LAYER_LINE = "road-conditions-lines";
const LAYER_FILL = "road-conditions-fill";

export function RoadConditionsLayer({ visible }: { visible: boolean }) {
  const map = useMap();
  const { setData } = useRoadConditionsStore();
  const [selected, setSelected] = useState<GeoJSON.Feature | null>(null);

  useIntegrationAttribution("overlay-road-conditions", visible);

  const fetchObservations = useDebouncedCallback(async () => {
    if (!map || !visible) return;
    const bounds = map.getBounds();
    const bbox = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ].join(",");
    const res = await fetch(
      `/api/integrations/overlay-road-conditions/observations?domain=roads&bbox=${bbox}`,
    );
    if (!res.ok) return;
    const fc = await res.json();
    const source = map.getSource(SOURCE_ID);
    if (source && "setData" in source) {
      (source as maplibregl.GeoJSONSource).setData(fc);
    }
    setData(fc);
  }, 300);

  useEffect(() => {
    if (!map) return;
    map.on("moveend", fetchObservations);
    fetchObservations();
    return () => { map.off("moveend", fetchObservations); };
  }, [map, visible, fetchObservations]);

  useStyleSyncedLayer(map, SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterRadius: 40,
  });

  useStyleSyncedLayer(map, LAYER_POINT, {
    type: "circle",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": SEVERITY_EXPR,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 6, 14, 12],
      "circle-stroke-width": 1,
      "circle-stroke-color": "#fff",
    },
    layout: { visibility: visible ? "visible" : "none" },
  });

  useStyleSyncedLayer(map, LAYER_LINE, {
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": SEVERITY_EXPR,
      "line-width": 4,
    },
    layout: { visibility: visible ? "visible" : "none" },
  });

  useStyleSyncedLayer(map, LAYER_FILL, {
    type: "fill",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": SEVERITY_EXPR,
      "fill-opacity": 0.25,
    },
    layout: { visibility: visible ? "visible" : "none" },
  });

  useLayerReanchor(map, [LAYER_POINT, LAYER_LINE, LAYER_FILL]);

  return null;
}
*/
