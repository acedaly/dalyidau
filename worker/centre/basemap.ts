// The detailed basemap (docs/INTELLIGENCE_CENTRE_9_1.md#detailed-basemap): OpenStreetMap vector
// tiles (towns, roads, highways, state and local boundaries, waterways, land cover and place
// labels) from one PMTiles archive in this site's own R2 bucket, read by range and served by the
// Worker as ordinary /{z}/{x}/{y} tiles.
//
// No third-party tile service is used, so viewing an area never tells anyone else where someone is
// looking, the Content Security Policy is unchanged and nothing recurs on a bill but R2 storage and
// reads. The archive is a bounded extract (NSW, the ACT and a margin) the owner builds and uploads
// once (scripts/centre-basemap.mjs). Without it, maps fall back to the state outline.
// Tiles are only served behind Cloudflare Access (the portal) or a display credential (wallboards).
import { Compression, type Header, PMTiles, type RangeResponse, type Source } from "pmtiles";
import type { BasemapInfo } from "../../src/shared/centre/wallboard";
import type { Env } from "../env";
import { loadCentreSettings } from "./store";

export const BASEMAP_KEY = "private/centre/basemap/basemap.pmtiles";

/** Tests replace the archive between cases; production never needs this. */
export const forgetBasemap = () => {
    reader = null;
};
export const BASEMAP_ATTRIBUTION = "© OpenStreetMap contributors (ODbL), Protomaps basemap. Boundaries: Natural Earth.";
const OUTLINE_ATTRIBUTION = "Boundaries: Natural Earth (public domain).";

/** Range reads from the archive in R2, never the whole object. */
class R2Source implements Source {
    constructor(
        private readonly bucket: Env["MEDIA"],
        private readonly key: string,
    ) {}
    getKey() {
        return `r2:${this.key}`;
    }
    async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
        const object = await this.bucket.get(this.key, { range: { offset, length } });
        if (!object) throw new Error("The basemap archive isn't there");
        // A replaced archive mid-read: the reader starts again with the new one.
        if (etag && object.etag !== etag) throw new Error("The basemap archive changed");
        return { data: await object.arrayBuffer(), etag: object.etag };
    }
}

/** One reader per isolate and archive version: its header and directories stay cached between requests. */
let reader: { etag: string; tiles: PMTiles; checkedAt: number } | null = null;
/** How long an isolate trusts that the archive hasn't been replaced before checking R2 again. */
const RECHECK_MS = 60_000;

async function archive(env: Env): Promise<{ tiles: PMTiles; header: Header; etag: string } | null> {
    if (!reader || Date.now() - reader.checkedAt > RECHECK_MS) {
        const head = await env.MEDIA.head(BASEMAP_KEY);
        if (!head) {
            reader = null;
            return null;
        }
        if (!reader || reader.etag !== head.etag) reader = { etag: head.etag, tiles: new PMTiles(new R2Source(env.MEDIA, BASEMAP_KEY)), checkedAt: Date.now() };
        else reader.checkedAt = Date.now();
    }
    try {
        return { tiles: reader.tiles, header: await reader.tiles.getHeader(), etag: reader.etag };
    } catch (error) {
        console.log(JSON.stringify({ event: "centre_basemap_unreadable", message: (error as Error).message.slice(0, 200) }));
        reader = null;
        return null;
    }
}

/** What a map should draw, for the portal or a display. */
export async function basemapInfo(env: Env, audience: "portal" | "display"): Promise<BasemapInfo> {
    const { settings } = await loadCentreSettings(env.DB);
    const outline = (note: string | null): BasemapInfo => ({ kind: "outline", tiles: null, minZoom: 0, maxZoom: 0, bounds: null, attribution: OUTLINE_ATTRIBUTION, note });
    if (settings.basemap !== "detailed") return outline(null);
    const found = await archive(env);
    if (!found) return outline("The detailed map isn't installed (no basemap archive in storage), so only the state outline is shown.");
    const { header, etag } = found;
    const version = etag.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const base = audience === "portal" ? "/api/portal/centre/basemap" : "/api/display/tiles";
    return {
        kind: "detailed",
        tiles: `${base}/{z}/{x}/{y}.mvt?v=${version}`,
        minZoom: header.minZoom,
        maxZoom: header.maxZoom,
        bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
        attribution: BASEMAP_ATTRIBUTION,
        note: null,
    };
}

const decompress = async (data: ArrayBuffer, compression: Compression) => {
    if (compression === Compression.None) return data;
    if (compression === Compression.Gzip) return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    throw new Error("The basemap uses a compression this Worker can't read");
};

/** One tile, or 204 when the archive has none there (outside its extract or zoom range). */
export async function serveTile(env: Env, request: Request, z: number, x: number, y: number): Promise<Response> {
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 16 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return new Response("Not found", { status: 404 });
    const found = await archive(env);
    if (!found) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    const { tiles, header, etag } = found;
    const version = etag.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    // Immutable for a given archive version (the version is in the address); otherwise always revalidated.
    const current = new URL(request.url).searchParams.get("v") === version;
    const cacheControl = current ? "private, max-age=604800, immutable" : "private, no-cache";
    const headers = { "Content-Type": "application/vnd.mapbox-vector-tile", "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff" };
    if (z < header.minZoom || z > header.maxZoom) return new Response(null, { status: 204, headers });
    const tile = await tiles.getZxy(z, x, y);
    if (!tile) return new Response(null, { status: 204, headers });
    return new Response(await decompress(tile.data, header.tileCompression), { status: 200, headers });
}

/** /{z}/{x}/{y}.mvt at the end of a path. */
export const tilePath = (path: string) => {
    const m = /\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.mvt$/.exec(path);
    return m ? { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : null;
};
