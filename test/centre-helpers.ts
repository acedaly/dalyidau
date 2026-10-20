// Shared pieces for the Intelligence Centre tests: a fake transport that serves the invented
// fixtures (fixtures/intelligence-centre) instead of any real provider, and small shortcuts.
import { feedFixtures } from "../fixtures/intelligence-centre/feeds.mjs";
import { collectSource } from "../worker/centre/ingest";
import type { CentreTransport } from "../worker/centre/net";
import { FetchFailure } from "../worker/centre/net";
import type { Env } from "../worker/env";
import { OWNER, apiCall, db, portalEnv } from "./portal-helpers";

export const C = "/api/portal/centre";

export type Route = string | ((url: URL, init: RequestInit) => Response | Promise<Response>);

export interface FakeTransport extends CentreTransport {
    calls: string[];
    routes: Record<string, Route>;
    ftpFiles: Record<string, string>;
    ftpModified: Record<string, string>;
}

const globToRegex = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** A transport over the fixtures. Routes are matched on the URL without its query string. */
export function fakeTransport(now = new Date(), extra: Record<string, Route> = {}): FakeTransport {
    const all = { ...feedFixtures(now), ...extra };
    const routes: Record<string, Route> = {};
    const ftpFiles: Record<string, string> = {};
    for (const [url, body] of Object.entries(all)) {
        if (url.startsWith("ftp://")) ftpFiles[url.replace(/^ftp:\/\/[^/]+/, "")] = body as string;
        else routes[url] = body;
    }
    const minute = `${new Date(now.getTime() - 60_000).toISOString().slice(0, 16)}:00Z`;
    const ftpModified: Record<string, string> = {};
    for (const path of Object.keys(ftpFiles)) ftpModified[path] = minute;
    const calls: string[] = [];
    const t: FakeTransport = {
        calls,
        routes,
        ftpFiles,
        ftpModified,
        fixture: true,
        async fetch(raw, init) {
            calls.push(raw);
            const url = new URL(raw);
            const route = routes[`${url.origin}${url.pathname}`];
            if (route === undefined) return new Response("not found", { status: 404 });
            if (typeof route === "function") return route(url, init);
            return new Response(route, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
        },
        ftp: {
            async list(_host, dir, pattern) {
                calls.push(`ftp:list:${dir}/${pattern}`);
                const re = globToRegex(pattern);
                return Object.keys(ftpFiles)
                    .filter((p) => p.startsWith(`${dir}/`) && re.test(p.slice(dir.length + 1)))
                    .map((p) => ({ name: p.slice(dir.length + 1), modified: ftpModified[p], size: ftpFiles[p].length }));
            },
            async retrieve(host, path, maxBytes) {
                const found = (await t.ftp.retrieveMany(host, [path], maxBytes)).get(path);
                if (!found) throw new FetchFailure("http_error", "Not found", 404, false);
                return found;
            },
            async retrieveMany(_host, paths, maxBytes) {
                const out = new Map<string, Uint8Array>();
                for (const p of paths) {
                    calls.push(`ftp:get:${p}`);
                    if (ftpFiles[p] === undefined) continue;
                    const bytes = new TextEncoder().encode(ftpFiles[p]);
                    if (bytes.byteLength > maxBytes) throw new FetchFailure("too_large", "too large", null, false);
                    out.set(p, bytes);
                }
                return out;
            },
        },
    };
    return t;
}

export const centreEnv = (overrides: Partial<Env> = {}) => portalEnv(overrides);

export const enableSource = (id: string, email = OWNER) => apiCall("PUT", `${C}/sources/${id}`, { enabled: true }, { email });

export async function collect(env: Env, id: string, transport: CentreTransport, now = new Date()) {
    return collectSource(env, id, { transport, now, trigger: "manual" });
}

export const records = async (sourceId: string) =>
    (
        await db()
            .prepare("SELECT * FROM ic_records WHERE source_id = ? ORDER BY external_id")
            .bind(sourceId)
            .all<Record<string, unknown> & { id: string; external_id: string }>()
    ).results;

export const changes = async () =>
    (
        await db()
            .prepare("SELECT kind, summary, record_id, source_id FROM ic_changes ORDER BY at, rowid")
            .all<{ kind: string; summary: string; record_id: string | null; source_id: string }>()
    ).results;

export const setFlag = (key: string, enabled: boolean) => apiCall("PUT", `/api/portal/flags/${key}`, { enabled });

/** A point watch area around the fixtures' Example places. */
export const exampleWatch = (overrides: Record<string, unknown> = {}) => ({
    name: "Exampleville",
    definition: { kind: "point", lat: -33.6, lon: 150.6, radiusKm: 25, placeName: "Home" },
    fireDistrict: "Example Ranges",
    ...overrides,
});
