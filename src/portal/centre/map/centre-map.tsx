// The Intelligence Centre's map (MapLibre GL JS, BSD-3), shared by the Live Map page, record pages
// and wallboards.
//
// No third-party tiles. The basemap is either the detailed OpenStreetMap vector tiles this site
// serves from its own R2 archive (towns, roads, waterways, boundaries, labels: basemap-style.ts) or,
// when that isn't installed, an outline of Australia's states (public/centre/australia.geojson,
// Natural Earth). Viewing an area never tells a tile host where someone is looking. MapLibre's
// worker, the tiles and the glyphs all come from this origin, so the Content Security Policy stays
// as it is. Wallboards send their display credential with tile requests (never a cookie).
//
// What's drawn is only what providers published: points as points, published areas as areas.
// Official records and satellite detections use different shapes; text-only and district records
// aren't drawn (they're listed beside the map). The map isn't the only way to see anything: every
// record is in the list next to it.
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { MapLayer } from "@/shared/centre/types";
import { MAP_LAYER_LABELS } from "@/shared/centre/types";
import type { BasemapInfo } from "@/shared/centre/wallboard";
import { cx } from "@/utils/cx";
import type { BasemapFlavor } from "./basemap-style";
import { useBasemap } from "./use-basemap";

export interface MapFeature {
    type: "Feature";
    id: string;
    geometry: { type: string; coordinates: unknown };
    properties: {
        id: string;
        layer: string;
        kind: string;
        title: string;
        level: string | null;
        rank: number;
        area: 0 | 1;
        nature: "official" | "observed";
        at: string | null;
    };
}

export interface WatchOutline {
    id: string;
    name: string;
    /** A ring of [lon, lat] (a circle is approximated client-side), or a line for a corridor. */
    ring?: [number, number][];
    line?: [number, number][];
}

/** Resolves a theme token to rgb() by drawing it: palette colours are oklch, which MapLibre can't parse. */
function themeColour(variable: string, fallback: string): string {
    if (typeof document === "undefined") return fallback;
    try {
        const probe = document.createElement("span");
        probe.style.color = `var(${variable})`;
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || !value) return fallback;
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
    } catch {
        return fallback;
    }
}

export interface MapPalette {
    emergency: string;
    watchAct: string;
    advice: string;
    fire: string;
    transport: string;
    power: string;
    air: string;
    weather: string;
    water: string;
    earthquake: string;
    other: string;
    hotspot: string;
    land: string;
    border: string;
    background: string;
    watch: string;
    halo: string;
}

export const mapPalette = (): MapPalette => ({
    emergency: themeColour("--color-utility-red-600", "rgb(217, 45, 32)"),
    watchAct: themeColour("--color-utility-orange-500", "rgb(239, 104, 32)"),
    advice: themeColour("--color-utility-yellow-400", "rgb(250, 197, 21)"),
    fire: themeColour("--color-utility-orange-700", "rgb(185, 56, 21)"),
    transport: themeColour("--color-utility-blue-600", "rgb(21, 112, 239)"),
    power: themeColour("--color-utility-purple-600", "rgb(105, 56, 239)"),
    air: themeColour("--color-utility-green-600", "rgb(3, 152, 85)"),
    weather: themeColour("--color-utility-neutral-500", "rgb(113, 118, 128)"),
    water: themeColour("--color-utility-blue-400", "rgb(83, 177, 253)"),
    earthquake: themeColour("--color-utility-pink-600", "rgb(221, 37, 144)"),
    other: themeColour("--color-utility-indigo-600", "rgb(68, 76, 231)"),
    hotspot: themeColour("--color-utility-orange-400", "rgb(253, 133, 58)"),
    land: themeColour("--color-bg-primary", "rgb(255, 255, 255)"),
    border: themeColour("--color-border-primary", "rgb(213, 215, 218)"),
    background: themeColour("--color-utility-blue-50", "rgb(239, 248, 255)"),
    watch: themeColour("--color-utility-brand-600", "rgb(127, 86, 217)"),
    halo: themeColour("--color-bg-primary", "rgb(255, 255, 255)"),
});

const colourExpression = (p: MapPalette): unknown => [
    "case",
    ["==", ["get", "level"], "Emergency Warning"],
    p.emergency,
    ["==", ["get", "level"], "Watch and Act"],
    p.watchAct,
    ["==", ["get", "level"], "Advice"],
    p.advice,
    [
        "match",
        ["get", "layer"],
        "fire",
        p.fire,
        "warnings",
        p.fire,
        "transport",
        p.transport,
        "power",
        p.power,
        "air",
        p.air,
        "weather",
        p.weather,
        "flood",
        p.water,
        "water",
        p.water,
        "earthquake",
        p.earthquake,
        "hotspot",
        p.hotspot,
        p.other,
    ],
];

/** A circle of `km` around a point, as a ring (for drawing a watch area only). */
export function circleRing(lon: number, lat: number, km: number, steps = 64): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * 2 * Math.PI;
        out.push([lon + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
    }
    return out;
}

/** A diamond, drawn on a canvas, for satellite detections (no sprite or font download needed). */
function diamond(colour: string, size = 18) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = colour;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(size / 2, 1);
    ctx.lineTo(size - 1, size / 2);
    ctx.lineTo(size / 2, size - 1);
    ctx.lineTo(1, size / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
}

export interface CentreMapProps {
    features: MapFeature[];
    /** Layers to show. */
    layers: readonly MapLayer[];
    /** [west, south, east, north] to frame on load and when it changes. */
    frame: [number, number, number, number];
    watches?: WatchOutline[];
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    /** Called with the visible bounds after the map moves (for "only what's on the map"). */
    onMove?: (bounds: [number, number, number, number]) => void;
    label: string;
    className?: string;
    /** Wallboards: no interaction, larger symbols. */
    display?: boolean;
    fullscreen?: boolean;
    /** The basemap to draw. Undefined: the portal asks the Worker (display mode draws the outline). */
    basemap?: BasemapInfo | null;
    /** A wallboard's display credential, sent with its tile requests. */
    authToken?: string | null;
    /** Basemap colours; by default light or dark from the portal theme, dark on wallboards. */
    flavor?: BasemapFlavor;
}

export const CentreMap = ({
    features,
    layers,
    frame,
    watches = [],
    selectedId,
    onSelect,
    onMove,
    label,
    className,
    display = false,
    fullscreen = true,
    basemap,
    authToken = null,
    flavor,
}: CentreMapProps) => {
    const container = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const callbacks = useRef({ onSelect, onMove });
    callbacks.current = { onSelect, onMove };
    const token = useRef(authToken);
    token.current = authToken;
    const asked = useBasemap(basemap === undefined && !display);
    const chosen = basemap === undefined ? (display ? null : asked) : basemap;
    // The map waits for the portal's answer (a quick request), then is made once per basemap.
    const styleKey = chosen === undefined ? null : `${chosen?.kind ?? "outline"}:${chosen?.tiles ?? ""}:${flavor ?? ""}`;

    useEffect(() => {
        if (styleKey === null) return;
        let cancelled = false;
        let map: MapLibreMap | null = null;
        (async () => {
            try {
                // The basemap's style (and its OpenStreetMap layer definitions) loads with MapLibre, only on pages with a map.
                const [maplibre, worker, , { basemapStyle, glyphUrl }] = await Promise.all([
                    import("maplibre-gl"),
                    import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
                    import("maplibre-gl/dist/maplibre-gl.css"),
                    import("./basemap-style"),
                ]);
                if (cancelled || !container.current) return;
                maplibre.setWorkerUrl(new URL(worker.default, window.location.href).href);
                const p = mapPalette();
                const colour = colourExpression(p);
                const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark-mode");
                const detailed = chosen?.kind === "detailed";
                map = new maplibre.Map({
                    container: container.current,
                    style: basemapStyle(chosen ?? null, flavor ?? (display || dark ? "dark" : "light"), {
                        background: p.background,
                        land: p.land,
                        border: p.border,
                    }) as never,
                    transformRequest: (url, type) => {
                        if (type === "Glyphs") return { url: glyphUrl(url) };
                        if (type === "Tile" && token.current && url.includes("/api/display/tiles/"))
                            return { url, headers: { Authorization: `Bearer ${token.current}` } };
                        return { url };
                    },
                    bounds: frame,
                    fitBoundsOptions: { padding: 24 },
                    attributionControl: {
                        compact: true,
                        customAttribution: `${detailed ? chosen!.attribution : "Boundaries: Natural Earth."} Data: the providers listed beside the map.`,
                    },
                    interactive: !display,
                    cooperativeGestures: !display,
                    maxZoom: detailed ? 16 : 14,
                    minZoom: 3,
                });
                map.getCanvas().setAttribute("aria-label", label);
                if (!display) map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
                if (!display && fullscreen) map.addControl(new maplibre.FullscreenControl(), "top-right");
                map.on("load", () => {
                    if (!map) return;
                    map.addImage("detection", diamond(p.hotspot, display ? 22 : 16));
                    map.addSource("areas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
                    map.addSource("official", {
                        type: "geojson",
                        data: { type: "FeatureCollection", features: [] },
                        cluster: !display,
                        clusterRadius: 40,
                        clusterMaxZoom: 9,
                    });
                    map.addSource("observed", {
                        type: "geojson",
                        data: { type: "FeatureCollection", features: [] },
                        cluster: !display,
                        clusterRadius: 30,
                        clusterMaxZoom: 9,
                    });
                    map.addSource("watches", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
                    map.addLayer({ id: "areas-fill", type: "fill", source: "areas", paint: { "fill-color": colour as never, "fill-opacity": 0.22 } });
                    map.addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": colour as never, "line-width": 1.5 } });
                    map.addLayer({
                        id: "watch-line",
                        type: "line",
                        source: "watches",
                        paint: { "line-color": p.watch, "line-width": 2, "line-dasharray": [2, 2] },
                    });
                    for (const [source, kind] of [
                        ["observed", "observed"],
                        ["official", "official"],
                    ] as const) {
                        map.addLayer({
                            id: `${source}-clusters`,
                            type: "circle",
                            source,
                            filter: ["has", "point_count"],
                            // Official clusters are solid with a halo; satellite and observation clusters are
                            // paler and smaller, so detections are never mistaken for confirmed incidents.
                            paint:
                                kind === "official"
                                    ? {
                                          "circle-color": p.fire,
                                          "circle-opacity": 0.85,
                                          "circle-stroke-color": p.halo,
                                          "circle-stroke-width": 2,
                                          "circle-radius": ["step", ["get", "point_count"], 12, 10, 16, 50, 22, 200, 28],
                                      }
                                    : {
                                          "circle-color": p.hotspot,
                                          "circle-opacity": 0.35,
                                          "circle-stroke-color": p.hotspot,
                                          "circle-stroke-width": 1,
                                          "circle-radius": ["step", ["get", "point_count"], 8, 10, 11, 50, 15, 200, 19],
                                      },
                        });
                    }
                    map.addLayer({
                        id: "observed-points",
                        type: "circle",
                        source: "observed",
                        filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "kind"], "detection"]],
                        paint: {
                            "circle-color": colour as never,
                            "circle-radius": display ? 6 : 4,
                            "circle-opacity": 0.85,
                            "circle-stroke-color": p.halo,
                            "circle-stroke-width": 1,
                        },
                    });
                    map.addLayer({
                        id: "detections",
                        type: "symbol",
                        source: "observed",
                        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "kind"], "detection"]],
                        layout: { "icon-image": "detection", "icon-allow-overlap": true },
                    });
                    map.addLayer({
                        id: "official-points",
                        type: "circle",
                        source: "official",
                        filter: ["!", ["has", "point_count"]],
                        paint: {
                            "circle-color": colour as never,
                            "circle-radius": ["+", display ? 8 : 6, ["*", ["get", "rank"], 1.5]],
                            "circle-stroke-color": p.halo,
                            "circle-stroke-width": 2,
                        },
                    });
                    map.addLayer({
                        id: "selected",
                        type: "circle",
                        source: "official",
                        filter: ["==", ["get", "id"], ""],
                        paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 14, "circle-stroke-color": p.watch, "circle-stroke-width": 3 },
                    });
                    const select = (e: MapMouseEvent & { features?: { properties: Record<string, unknown> }[] }) => {
                        const id = e.features?.[0]?.properties?.id;
                        if (typeof id === "string") callbacks.current.onSelect?.(id);
                    };
                    for (const layer of ["official-points", "observed-points", "detections", "areas-fill"]) {
                        map.on("click", layer, select as never);
                        map.on("mouseenter", layer, () => (map!.getCanvas().style.cursor = "pointer"));
                        map.on("mouseleave", layer, () => (map!.getCanvas().style.cursor = ""));
                    }
                    for (const source of ["official", "observed"]) {
                        map.on("click", `${source}-clusters`, async (e) => {
                            const feature = map!.queryRenderedFeatures(e.point, { layers: [`${source}-clusters`] })[0];
                            const clusterId = feature?.properties?.cluster_id;
                            if (clusterId === undefined) return;
                            const zoom = await (map!.getSource(source) as GeoJSONSource).getClusterExpansionZoom(clusterId);
                            map!.easeTo({ center: (feature.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom });
                        });
                    }
                    map.on("moveend", () => {
                        const b = map!.getBounds();
                        callbacks.current.onMove?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
                    });
                    setReady(true);
                });
                map.on("error", (e) => console.warn("map", e.error?.message));
                mapRef.current = map;
            } catch (error) {
                if (!cancelled) setFailed((error as Error).message || "The map couldn't load");
            }
        })();
        return () => {
            cancelled = true;
            map?.remove();
            mapRef.current = null;
            setReady(false);
        };
        // The map is created once per basemap; frame and data changes are applied below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [styleKey]);

    // Data and layer visibility.
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        const visible = features.filter((f) => layers.includes(f.properties.layer as MapLayer));
        const set = (id: string, list: MapFeature[]) =>
            (map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: list as never });
        set(
            "areas",
            visible.filter((f) => f.properties.area === 1),
        );
        set(
            "official",
            visible.filter((f) => f.properties.area === 0 && f.properties.nature === "official"),
        );
        set(
            "observed",
            visible.filter((f) => f.properties.area === 0 && f.properties.nature === "observed"),
        );
        set(
            "watches",
            layers.includes("watch")
                ? watches.map((w) => ({
                      type: "Feature",
                      id: w.id,
                      geometry: w.ring ? { type: "LineString", coordinates: w.ring } : { type: "LineString", coordinates: w.line ?? [] },
                      properties: { id: w.id, layer: "watch", kind: "watch", title: w.name, level: null, rank: 0, area: 0, nature: "official", at: null },
                  }))
                : [],
        );
    }, [ready, features, layers, watches]);

    useEffect(() => {
        const map = mapRef.current;
        if (ready && map) map.setFilter("selected", ["==", ["get", "id"], selectedId ?? ""]);
    }, [ready, selectedId]);

    const frameKey = frame.join(",");
    useEffect(() => {
        const map = mapRef.current;
        if (ready && map) map.fitBounds(frame, { padding: 24, animate: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, frameKey]);

    return (
        <div className={cx("relative overflow-hidden rounded-xl bg-secondary ring-1 ring-secondary", className)}>
            {/* Inline: MapLibre's stylesheet makes its container position: relative, which would collapse it. */}
            <div ref={container} style={{ position: "absolute", inset: 0 }} />
            {!ready && !failed && <p className="absolute inset-0 flex items-center justify-center text-sm text-tertiary">Loading the map…</p>}
            {failed && (
                <p role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-tertiary">
                    The map couldn't be shown in this browser ({failed}). Every record is still in the list.
                </p>
            )}
        </div>
    );
};

/** The legend: what each colour and shape means, with official and observed apart. */
export const MapLegend = ({ className, large = false }: { className?: string; large?: boolean }) => {
    const items: { label: string; className: string; shape?: "diamond" | "area" | "dash" }[] = [
        { label: "Emergency Warning", className: "bg-utility-red-600" },
        { label: "Watch and Act", className: "bg-utility-orange-500" },
        { label: "Advice", className: "bg-utility-yellow-400" },
        { label: "Fire incident (no warning level)", className: "bg-utility-orange-700" },
        { label: "Published area (provider's own)", className: "bg-utility-orange-700/30 ring-1 ring-utility-orange-700", shape: "area" },
        { label: "Road hazard", className: "bg-utility-blue-600" },
        { label: "Power outage", className: "bg-utility-purple-600" },
        { label: "Other incident", className: "bg-utility-indigo-600" },
        { label: "Satellite thermal detection (not a confirmed fire)", className: "bg-utility-orange-400", shape: "diamond" },
        { label: "Group of detections or observations (pale)", className: "bg-utility-orange-400/35 ring-1 ring-utility-orange-400" },
        { label: "Weather station, river gauge, air quality (observed)", className: "bg-utility-neutral-500" },
        { label: "Earthquake", className: "bg-utility-pink-600" },
        { label: "Your watch area", className: "border-2 border-dashed border-utility-brand-600 bg-transparent", shape: "dash" },
    ];
    return (
        <ul
            className={cx("grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2", large ? "text-lg" : "text-xs", "text-secondary", className)}
            aria-label="Map legend"
        >
            {items.map((i) => (
                <li key={i.label} className="flex items-center gap-2">
                    <span
                        aria-hidden="true"
                        className={cx(
                            "inline-block shrink-0",
                            large ? "size-4" : "size-3",
                            i.shape === "diamond" ? "rotate-45 rounded-[1px]" : i.shape === "area" || i.shape === "dash" ? "rounded-sm" : "rounded-full",
                            i.className,
                        )}
                    />
                    {i.label}
                </li>
            ))}
        </ul>
    );
};

export const LAYER_OPTIONS = (Object.keys(MAP_LAYER_LABELS) as MapLayer[]).map((id) => ({ id, label: MAP_LAYER_LABELS[id] }));
