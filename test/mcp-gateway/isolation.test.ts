// The gateway has no runtime dependency on DalyHub V2: not its Worker, its D1 database, its
// ChiefOfStaffEntrypoint or any service binding. Proven three ways: the deployable configuration,
// the source, and a full session run with every outbound request refused and nothing but the
// PORTAL binding available. Also: rate limits, outages and logs. Every identity is fictional.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import wranglerSource from "../../mcp/wrangler.jsonc?raw";
import { OWNER, SECOND_OWNER, resetPortal } from "../portal-helpers";
import { CERTS_URL, gatewayEnv, guardOutbound, outbound, portalBinding, rateLimit, session } from "./helpers";

const sources = import.meta.glob("../../mcp/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Enough of JSONC for this file: full-line comments and trailing commas. */
const parseJsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

beforeEach(async () => {
    await resetPortal();
    guardOutbound();
});
afterEach(() => vi.restoreAllMocks());

const STORAGE_BINDINGS = [
    "d1_databases",
    "kv_namespaces",
    "r2_buckets",
    "durable_objects",
    "queues",
    "hyperdrive",
    "vectorize",
    "analytics_engine_datasets",
    "ai",
    "browser",
    "secrets_store_secrets",
    "workflows",
    "dispatch_namespaces",
    "mtls_certificates",
    "send_email",
    "tail_consumers",
];

describe("deployable configuration (mcp/wrangler.jsonc)", () => {
    const config = parseJsonc(wranglerSource);
    const environments = { development: config, production: { ...config, ...config.env.production } };

    it("binds only Daly Portal's PortalMcpEntrypoint, in every environment", () => {
        expect(environments.production.services).toEqual([{ binding: "PORTAL", service: "dalyidau", entrypoint: "PortalMcpEntrypoint" }]);
        expect(environments.development.services).toEqual([{ binding: "PORTAL", service: "dalyidau-staging", entrypoint: "PortalMcpEntrypoint" }]);
    });

    it("has no database, storage, queue, Durable Object or other data binding", () => {
        for (const [name, env] of Object.entries(environments)) for (const key of STORAGE_BINDINGS) expect(env[key], `${name}.${key}`).toBeUndefined();
    });

    it("names nothing from DalyHub V2", () => {
        for (const word of ["dalyhub-v2", "ChiefOfStaffEntrypoint", "DALYHUB", "DALYHUB_OWNER_EMAILS"]) expect(wranglerSource).not.toContain(word);
    });

    it("leaves the existing custom domain and Access application alone: production declares no routes", () => {
        expect(environments.production.routes).toBeUndefined();
        expect(environments.production.workers_dev).toBe(false);
        expect(environments.production.preview_urls).toBe(false);
        expect(environments.production.vars).toEqual({ ENVIRONMENT: "production", AUTH_MODE: "cloudflare-access" });
        expect(environments.production.secrets.required.sort()).toEqual(["POLICY_AUD", "TEAM_DOMAIN"]);
    });

    it("keeps the per-person limits it has always had", () => {
        const limits = environments.production.ratelimits.map((r: { name: string; simple: unknown }) => [r.name, r.simple]);
        expect(limits).toEqual([
            ["MCP_CALLS", { limit: 120, period: 60 }],
            ["MCP_WRITES", { limit: 30, period: 60 }],
        ]);
    });
});

describe("source (mcp/src)", () => {
    it("imports nothing from DalyHub and only these packages", () => {
        expect(Object.keys(sources).length).toBeGreaterThanOrEqual(3);
        const allowed = new Set(["jose", "zod", "@modelcontextprotocol/server", "agents/mcp/server", "@cloudflare/workers-types"]);
        for (const [file, text] of Object.entries(sources)) {
            expect(text.toLowerCase(), file).not.toMatch(/dalyhub|chief-of-staff"|~\/kernel|\.\.\/app/);
            for (const [, typeOnly, from] of text.matchAll(/^import (type )?[^;]*? from "([^"]+)";/gms)) {
                if (from.startsWith("./")) continue;
                // The portal's request/response types only: erased at build time, so no portal code is bundled.
                if (from === "../../worker/mcp/entrypoint") {
                    expect(typeOnly, `${file} must import ${from} as types only`).toBe("type ");
                    continue;
                }
                expect(allowed.has(from), `${file} imports ${from}`).toBe(true);
            }
        }
    });
});

describe("running with DalyHub V2 and its database completely unavailable", () => {
    it("serves a whole session (reads, writes, retries, briefings) with nothing but the PORTAL binding", async () => {
        const env = gatewayEnv({ PORTAL: portalBinding() });
        // What the gateway is given is exactly its configuration: no DB, no DalyHub, nothing else.
        expect(Object.keys(env).sort()).toEqual(["AUTH_MODE", "ENVIRONMENT", "POLICY_AUD", "PORTAL", "TEAM_DOMAIN"]);

        const s = await session(OWNER, { env });
        expect(s.init.status).toBe(200);
        expect(((await s.rpc("tools/list")).body.result as { tools: unknown[] }).tools).toHaveLength(66);
        const event = (
            await s.ok<{ event: { id: string } }>("calendar_create_event", { title: "Renew passport", startDate: "2030-03-01", requestId: "isolation-0001" })
        ).event;
        const again = await s.ok<{ event: { id: string } }>("calendar_create_event", {
            title: "Renew passport",
            startDate: "2030-03-01",
            requestId: "isolation-0001",
        });
        expect(again.event.id).toBe(event.id);
        const asset = (await s.ok<{ asset: { id: string } }>("assets_create", { name: "Passport wallet", category: "other", requestId: "isolation-0002" }))
            .asset;
        await s.ok("assets_create_maintenance", { assetId: asset.id, title: "Check expiry", requestId: "isolation-0003" });
        await s.ok("today_get_summary");
        await s.ok("chief_of_staff_daily_context");
        await s.ok("chief_of_staff_weekly_context");

        // The only network request was for the Access signing keys.
        expect(new Set(outbound)).toEqual(new Set([CERTS_URL]));
    });

    it("reports the portal being unreachable as unavailable, never as an empty result", async () => {
        const env = gatewayEnv({ PORTAL: { invoke: () => Promise.reject(new Error("service binding failed")) } });
        const s = await session(OWNER, { env });
        for (const tool of ["calendar_list_calendars", "chief_of_staff_daily_context", "calendar_create_event"]) {
            const answer = await s.tool(tool, tool === "calendar_create_event" ? { title: "x", startDate: "2030-03-01" } : {});
            expect(answer.isError, tool).toBe(true);
            expect(answer.data.error?.code, tool).toBe("unavailable");
            expect(answer.data.error?.message).toContain("Do not treat this as an empty result");
        }
    });

    it("treats a missing PORTAL binding (a misconfigured deploy) the same way", async () => {
        const s = await session(OWNER, { env: gatewayEnv({ PORTAL: undefined }) });
        expect((await s.tool("calendar_list_calendars")).data.error?.code).toBe("unavailable");
    });
});

describe("rate limits, per person", () => {
    it("limits requests per Access subject without affecting anyone else", async () => {
        const MCP_CALLS = rateLimit(4);
        const env = gatewayEnv({ MCP_CALLS });
        const a = await session(OWNER, { env, sub: "subject-a" }); // initialize + initialized = 2
        await a.ok("calendar_list_calendars"); // 3
        await a.ok("calendar_list_calendars"); // 4
        expect((await a.tool("calendar_list_calendars")).status).toBe(429);
        const b = await session(SECOND_OWNER, { env, sub: "subject-b" });
        expect(b.init.status).toBe(200);
        expect((await b.tool("calendar_list_calendars")).status).toBe(200);
    });

    it("limits writes separately, refusing them as a tool error while reads continue", async () => {
        const MCP_WRITES = rateLimit(2);
        const binding = portalBinding();
        const s = await session(OWNER, { env: gatewayEnv({ MCP_WRITES, PORTAL: binding }) });
        await s.ok("calendar_create_event", { title: "One", startDate: "2030-03-01" });
        await s.ok("calendar_create_event", { title: "Two", startDate: "2030-03-01" });
        const third = await s.tool("calendar_create_event", { title: "Three", startDate: "2030-03-01" });
        expect(third.isError).toBe(true);
        expect(third.data.error?.code).toBe("rate_limited");
        expect(binding.calls.filter((t) => t === "calendar_create_event")).toHaveLength(2);
        await s.ok("calendar_list_calendars");
    });
});

describe("logs", () => {
    it("never contain the person, their token, their arguments or their data", async () => {
        const lines: string[] = [];
        for (const method of ["log", "info", "warn", "error"] as const)
            vi.spyOn(console, method).mockImplementation((...args) => void lines.push(args.map(String).join(" ")));
        const s = await session(OWNER);
        await s.ok("calendar_create_event", { title: "Secret-surprise-party", description: "confidential-details", startDate: "2030-03-01" });
        await s.ok("calendar_search_events", { query: "Secret-surprise-party" });
        await s.tool("assets_get", { assetId: "ast_aaaaaaaaaaaaaa" });
        await s.tool("tasks_get", { taskId: "tsk_aaaaaaaaaaaaaa" });
        await (await import("./helpers")).post({}, { token: "not-a-jwt" });
        const all = lines.join("\n");
        for (const secret of [OWNER, s.token, "Secret-surprise-party", "confidential-details"]) expect(all).not.toContain(secret);
        expect(all).toContain("mcp_call");
    });
});
