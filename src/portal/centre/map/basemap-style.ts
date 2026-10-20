// The detailed basemap's style: OpenStreetMap vector tiles from this site (Protomaps' basemap layers,
// BSD-3), with the Natural Earth state outline underneath so places outside the archive still show
// the states. Layers that are only sprite images (points of interest, road shields, one-way arrows)
// or clutter a wallboard (buildings, house numbers) are left out; labels keep their text without icons. Glyphs are served from this site.
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { BasemapInfo } from "@/shared/centre/wallboard";

export type BasemapFlavor = "light" | "dark" | "black";

const DROPPED = new Set(["pois", "roads_shields", "roads_oneway", "address_label", "buildings"]);
const FONTS = new Set(["noto-sans-regular", "noto-sans-medium", "noto-sans-italic"]);

/** Glyph requests for "Noto Sans Medium" go to /centre/fonts/noto-sans-medium/… (kebab-case folders). */
export function glyphUrl(url: string): string {
    const m = /\/centre\/fonts\/([^/]+)\/(\d+-\d+\.pbf)$/.exec(url);
    if (!m) return url;
    const first = decodeURIComponent(m[1]).split(",")[0].trim().toLowerCase().replace(/\s+/g, "-");
    const folder = FONTS.has(first) ? first : "noto-sans-regular";
    return url.replace(m[0], `/centre/fonts/${folder}/${m[2]}`);
}

export interface OutlineColours {
    background: string;
    land: string;
    border: string;
}

/** A MapLibre style: the outline alone, or the detailed basemap over it. */
export function basemapStyle(basemap: BasemapInfo | null, flavor: BasemapFlavor, outline: OutlineColours): Record<string, unknown> {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const outlineLayers = [
        { id: "land", type: "fill", source: "base", paint: { "fill-color": outline.land } },
        { id: "borders", type: "line", source: "base", paint: { "line-color": outline.border, "line-width": 1 } },
    ];
    if (!basemap || basemap.kind !== "detailed" || !basemap.tiles)
        return {
            version: 8,
            sources: { base: { type: "geojson", data: "/centre/australia.geojson" } },
            layers: [{ id: "background", type: "background", paint: { "background-color": outline.background } }, ...outlineLayers],
        };
    const all = layers("basemap", namedFlavor(flavor), { lang: "en" }) as unknown as { id: string; type: string; layout?: Record<string, unknown> }[];
    // Town and suburb labels draw a small sprite dot beside the name; without a sprite sheet the
    // icon is stripped and the label kept, so places are still named.
    const kept = all
        .filter((l) => !DROPPED.has(l.id))
        .map((l) =>
            l.layout && "icon-image" in l.layout
                ? { ...l, layout: Object.fromEntries(Object.entries(l.layout).filter(([key]) => !key.startsWith("icon-"))) }
                : l,
        );
    const background = kept.filter((l) => l.type === "background");
    const rest = kept.filter((l) => l.type !== "background");
    return {
        version: 8,
        glyphs: `${origin}/centre/fonts/{fontstack}/{range}.pbf`,
        sources: {
            base: { type: "geojson", data: "/centre/australia.geojson" },
            basemap: {
                type: "vector",
                // Joined as text: URL() would percent-encode the {z}/{x}/{y} placeholders MapLibre fills in.
                tiles: [`${origin}${basemap.tiles}`],
                minzoom: basemap.minZoom,
                maxzoom: basemap.maxZoom,
                ...(basemap.bounds ? { bounds: basemap.bounds } : {}),
                attribution: basemap.attribution,
            },
        },
        layers: [...background, ...outlineLayers, ...rest],
    };
}
