// HTTP surface for Amplenote publishing:
//
//   POST /api/amplenote/ingest            the plugin's report. Bearer AMPLENOTE_PUBLISH_TOKEN; CORS-open
//                                          (no cookies are ever accepted) because the plugin runs in
//                                          Amplenote's sandboxed origin. 404 until the secret is set.
//   /api/portal/website/amplenote/*        status, connect, check and disconnect, registered on the
//                                          portal router (Access + portal.settings.manage, audited).
//   GET /api/integrations/amplenote/callback
//                                          the OAuth redirect. Outside Access (it's the address registered
//                                          with Amplenote), so it trusts only the single-use state and the
//                                          browser cookie set when the owner pressed Connect in the portal.
import { z } from "zod";
import type { AmplenoteStatus } from "../../src/shared/website";
import { capacitiesStatus } from "../capacities/archive";
import type { Env } from "../env";
import { bearerMatches } from "../lib/bearer";
import { HttpError, readText } from "../portal/http";
import { AmplenoteError, browserNonce, clearBrowserCookie, finishConnect, loadConnection, redirectUri, restConfigured } from "./client";
import { conventions, extractMetadata } from "./metadata";
import { type PluginReport, ingest } from "./publisher";

export const INGEST_PATH = "/api/amplenote/ingest";
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

export const pluginConfigured = (env: Env) => (env.AMPLENOTE_PUBLISH_TOKEN?.length ?? 0) >= 32;

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
};

const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...CORS },
    });

const noteSchema = z.object({
    uuid: z.string().regex(/^[0-9a-fA-F-]{36}$/),
    name: z.string().max(500).nullish(),
    tags: z.array(z.string().max(200)).max(200),
    created: z.string().max(40).nullish(),
    updated: z.string().max(40).nullish(),
    publicUrl: z.string().max(500).nullish(),
    markdown: z.string().max(1_000_000).nullish(),
});

const reportSchema = z.object({ version: z.literal(1), complete: z.boolean(), notes: z.array(noteSchema).max(500) });

export async function handleIngest(request: Request, env: Env, fetchImpl?: typeof fetch): Promise<Response> {
    if (!pluginConfigured(env)) return reply({ error: "not_found" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return reply({ error: "use POST" }, 405);
    // A bearer token only: a browser's cookies or Access session never authorise this endpoint.
    if (!(await bearerMatches(request.headers.get("Authorization"), env.AMPLENOTE_PUBLISH_TOKEN))) {
        return new Response(JSON.stringify({ error: "unauthorised" }), {
            status: 401,
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "WWW-Authenticate": "Bearer", ...CORS },
        });
    }
    let report: PluginReport;
    try {
        const text = await readText(request, MAX_REPORT_BYTES);
        report = reportSchema.parse(JSON.parse(text));
    } catch (error) {
        if (error instanceof HttpError) return reply({ error: error.code }, error.status);
        return reply({ error: "invalid_report", message: "The report isn't in the expected format; update the plugin" }, 422);
    }
    const summary = await ingest(env, report, { fetchImpl });
    return reply(summary, summary.status === "skipped" ? 409 : summary.status === "failed" ? 502 : 200);
}

export async function amplenoteStatus(env: Env): Promise<AmplenoteStatus> {
    const [connection, articles, runs, capacities, moves] = await Promise.all([
        loadConnection(env),
        env.DB.prepare(
            "SELECT uuid, title, slug, state, reason, link_status, plugin_seen_at, rest_seen_at, updated_at, markdown, replace_slug, replace_approved_at FROM amplenote_articles ORDER BY state = 'published' DESC, updated_at DESC LIMIT 200",
        ).all<Record<string, string | null>>(),
        env.DB.prepare(
            "SELECT id, trigger, finished_at, status, published, updated, unpublished, errors, log FROM sync_runs WHERE trigger LIKE 'amplenote:%' ORDER BY id DESC LIMIT 10",
        ).all<Record<string, string | number | null>>(),
        capacitiesStatus(env),
        env.DB.prepare(
            `SELECT 'live' AS kind, id, slug, title, NULL AS replaced_by FROM posts WHERE source = 'capacities'
             UNION ALL SELECT 'redirect', post_id, from_slug, NULL, NULL FROM slug_redirects
             UNION ALL SELECT 'moved', id, slug, title, replaced_by FROM capacities_archive WHERE replaced_by IS NOT NULL`,
        ).all<{ kind: string; id: string; slug: string; title: string | null; replaced_by: string | null }>(),
    ]);
    // Which notes move (or wait to move) a Capacities article to Amplenote. The note's content never leaves the server.
    const live = new Map(moves.results.filter((m) => m.kind === "live").map((m) => [m.slug, m]));
    const liveById = new Map(moves.results.filter((m) => m.kind === "live").map((m) => [m.id, m]));
    const redirectTo = new Map(moves.results.filter((m) => m.kind === "redirect").map((m) => [m.slug, m.id]));
    const moved = new Map(moves.results.filter((m) => m.kind === "moved").map((m) => [m.replaced_by!, m]));
    const replacement = (r: Record<string, string | null>): AmplenoteStatus["articles"][number]["replacement"] => {
        const done = moved.get(String(r.uuid));
        if (done) return { slug: done.slug, title: done.title ?? done.slug, state: "done" };
        const wanted = r.markdown ? extractMetadata(r.markdown).metadata.replaces : null;
        const target = wanted ? (live.get(wanted) ?? liveById.get(redirectTo.get(wanted) ?? "")) : undefined;
        if (!target) return null;
        return {
            slug: target.slug,
            title: target.title ?? target.slug,
            state: r.replace_slug === target.slug && r.replace_approved_at ? "approved" : "waiting",
        };
    };
    const site = env.SITE_URL.replace(/\/+$/, "");
    return {
        tag: conventions(env.AMPLENOTE_TAG).tag,
        ingestUrl: `${site}${INGEST_PATH}`,
        redirectUri: redirectUri(env),
        configured: { plugin: pluginConfigured(env), api: restConfigured(env) },
        connection: connection
            ? {
                  connectedBy: connection.connected_by,
                  connectedAt: connection.connected_at,
                  fullListedAt: connection.full_listed_at,
                  lastError: connection.last_error,
              }
            : null,
        articles: articles.results.map((r) => ({
            uuid: String(r.uuid),
            // A title is only ever stored for notes reported as published, so drafts show none.
            title: r.title,
            slug: r.slug,
            state: r.state as AmplenoteStatus["articles"][number]["state"],
            reason: r.reason,
            linkStatus: r.link_status,
            pluginSeenAt: r.plugin_seen_at,
            restSeenAt: r.rest_seen_at,
            updatedAt: String(r.updated_at),
            replacement: replacement(r),
        })),
        runs: runs.results.map((r) => {
            let log: string[] = [];
            try {
                log = JSON.parse(String(r.log ?? "[]")) as string[];
            } catch {
                // An unreadable log shows as empty.
            }
            return {
                id: Number(r.id),
                trigger: String(r.trigger),
                finishedAt: (r.finished_at as string | null) ?? null,
                status: String(r.status),
                published: Number(r.published),
                updated: Number(r.updated),
                unpublished: Number(r.unpublished),
                errors: Number(r.errors),
                log: log.slice(0, 20),
            };
        }),
        capacities,
    };
}

export const SETTINGS_PATH = "/portal/settings/website";

/** The OAuth redirect: exchanges the code server-side, then sends the owner back to Portal settings. */
export async function amplenoteCallback(request: Request, env: Env, fetchImpl?: typeof fetch): Promise<Response> {
    const url = new URL(request.url);
    const back = (result: string) =>
        new Response(null, {
            status: 303,
            headers: {
                Location: `${SETTINGS_PATH}?amplenote=${result}`,
                "Set-Cookie": clearBrowserCookie,
                "Cache-Control": "no-store",
                "X-Robots-Tag": "noindex, nofollow",
                // The address holds the authorisation code: never pass it on.
                "Referrer-Policy": "no-referrer",
            },
        });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!state) return back("declined");
    if (url.searchParams.get("error") || !code) {
        // Cancelled in Amplenote: use the state up so it can't be replayed.
        await env.DB.prepare("DELETE FROM amplenote_oauth_states WHERE state = ?").bind(state.slice(0, 200)).run();
        return back("declined");
    }
    try {
        await finishConnect(env, code.slice(0, 2000), state.slice(0, 200), browserNonce(request), fetchImpl);
        return back("connected");
    } catch (error) {
        console.error(JSON.stringify({ event: "amplenote_connect_error", message: (error as Error).message }));
        return back(error instanceof AmplenoteError && /expired|started/.test(error.message) ? "expired" : "failed");
    }
}
