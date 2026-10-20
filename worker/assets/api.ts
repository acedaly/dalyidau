// JSON API for Home & Assets (/api/portal/assets/*). By the time a request gets here the portal
// router has verified the Access identity, the portal role and the same-origin checks (CSRF). This
// router adds "assets.use"; each handler then checks the caller's rights on the record it touches
// (worker/assets/access.ts). Uploads are JSON (base64), like every other portal write.
import { z } from "zod";
import { applyFilters, filtersFromQuery } from "../../src/shared/assets/filters";
import { REPORTS, type ReportName, assetId } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { csvResponse } from "../portal/csv";
import { HttpError, json, readJson } from "../portal/http";
import { assetPeople, assetPreferences, requireAsset, saveAssetPreferences } from "./access";
import {
    addOdometer,
    addValuation,
    assetSummary,
    bulkUpdate,
    createAsset,
    deleteAsset,
    deleteOdometer,
    deleteValuation,
    deletedAssets,
    listAssets,
    moveAsset,
    regenerateLabel,
    restoreAsset,
    setSharing,
    updateAsset,
} from "./assets";
import { captureStatus, photoProposal, policyProposal, receiptProposal } from "./capture";
import { createCategory, listCategories, updateCategory } from "./catalog";
import { overview } from "./dashboard";
import { assetDetail } from "./detail";
import { deleteFile, fileContent, filesFor, listFiles, retentionDue, setCover, updateFile, uploadFile } from "./files";
import { createPolicy, deletePolicy, linkAsset, listPolicies, policyView, renewPolicy, unlinkAsset, updatePolicy, verifyPolicy } from "./insurance";
import { addKnowledgeLink, createAppointment, createLinkedTask, removeKnowledgeLink } from "./links";
import { createLocation, listLocations, locationView, updateLocation } from "./locations";
import {
    builtinTemplates,
    cancelMaintenance,
    completeMaintenance,
    createMaintenance,
    createSchedule,
    createTemplate,
    deleteSchedule,
    deleteTemplate,
    listMaintenance,
    listSchedules,
    listTemplates,
    maintenanceView,
    reportProblem,
    updateMaintenance,
    updateSchedule,
} from "./maintenance";
import { dismissNotification, listNotifications } from "./notify";
import { assetAddress, qrSvg } from "./qr";
import { reportCsv } from "./reports";
import { searchAll } from "./search";
import { createClaim, createWarranty, deleteWarranty, listClaims, listWarranties, updateClaim, updateWarranty } from "./warranties";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^/api/portal/assets${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

const site = (env: Env) => new URL(env.SITE_URL).origin;
/** Uploads are base64 in JSON: a 10 MB file plus its preview. */
const UPLOAD_BYTES = 15_000_000;

const confirmOf = async (request: Request) => ((await readJson(request)) as { confirm?: unknown }).confirm;

// --- Overview, preferences, people, notifications ------------------------------------------------

add("GET", "/overview", async ({ env, user }) => json({ overview: await overview(env, env.DB, user) }));

add("GET", "/preferences", async ({ env, user }) => json(await assetPreferences(env.DB, user.email)));
add("PUT", "/preferences", async ({ env, request, user }) => {
    const body = z
        .object({ preferences: z.unknown(), version: z.number().int().min(0) })
        .strict()
        .parse(await readJson(request));
    return json(await saveAssetPreferences(env.DB, user, body.preferences, body.version));
});

/** The household: who an asset can be shared with. Names and emails of people who can open Home & Assets. */
add("GET", "/people", async ({ env, user }) => json({ people: (await assetPeople(env, env.DB)).filter((p) => p.email !== user.email) }));

add("GET", "/notifications", async ({ env, user }) => json({ notifications: await listNotifications(env, env.DB, user) }));
add("POST", "/notifications/:id/dismiss", async ({ env, user, params }) => {
    await dismissNotification(env.DB, user, params.id);
    return json({ notifications: await listNotifications(env, env.DB, user) });
});

add("GET", "/categories", async ({ env }) => json({ categories: await listCategories(env.DB) }));
add("POST", "/categories", async ({ env, request, user }) => json({ category: await createCategory(env.DB, user, await readJson(request)) }, 201));
add("PATCH", "/categories/:id", async ({ env, request, user, params }) =>
    json({ category: await updateCategory(env.DB, user, params.id, await readJson(request)) }),
);

add("GET", "/search", async ({ env, url, user }) => json({ results: await searchAll(env.DB, user, url.searchParams.get("q") ?? "") }));

// --- Assets --------------------------------------------------------------------------------------

add("GET", "/items", async ({ env, url, user }) => {
    const { assets, truncated } = await listAssets(env.DB, user);
    return json({ assets: applyFilters(assets, filtersFromQuery(url.searchParams)), truncated });
});
add("POST", "/items", async ({ env, request, user }) => {
    const { asset, replayed } = await createAsset(env.DB, user, await readJson(request));
    return json({ asset, replayed }, replayed ? 200 : 201);
});
add("POST", "/items/bulk", async ({ env, request, user }) => json(await bulkUpdate(env.DB, user, await readJson(request))));
add("GET", "/items/deleted", async ({ env, user }) => json({ assets: await deletedAssets(env.DB, user) }));
add("GET", "/items/:id", async ({ env, user, params }) => json({ detail: await assetDetail(env.DB, user, assetId.parse(params.id)) }));
add("PATCH", "/items/:id", async ({ env, request, user, params }) => json({ asset: await updateAsset(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/items/:id", async ({ env, request, user, params }) => {
    await deleteAsset(env.DB, user, params.id, await confirmOf(request));
    return json({ ok: true });
});
add("POST", "/items/:id/restore", async ({ env, user, params }) => json({ asset: await restoreAsset(env.DB, user, params.id) }));
add("PUT", "/items/:id/sharing", async ({ env, request, user, params }) =>
    json({ sharing: await setSharing(env, env.DB, user, params.id, await readJson(request)) }),
);
add("PUT", "/items/:id/location", async ({ env, request, user, params }) => {
    const { locationId } = z
        .object({
            locationId: z
                .string()
                .regex(/^alo_[a-z0-9]{14}$/)
                .nullable(),
        })
        .strict()
        .parse(await readJson(request));
    return json({ asset: await moveAsset(env.DB, user, params.id, locationId) });
});
add("PUT", "/items/:id/cover", async ({ env, request, user, params }) => {
    const { fileId } = z
        .object({ fileId: z.string().regex(/^afl_[a-z0-9]{14}$/) })
        .strict()
        .parse(await readJson(request));
    await setCover(env.DB, user, params.id, fileId);
    return json({ asset: await assetSummary(env.DB, user, params.id) });
});
add("POST", "/items/:id/label", async ({ env, user, params }) => json(await regenerateLabel(env.DB, user, params.id)));
add("GET", "/items/:id/qr.svg", async ({ env, user, params }) => {
    const { row } = await requireAsset(env.DB, user, assetId.parse(params.id));
    return new Response(await qrSvg(assetAddress(site(env), row.id, row.label_version)), {
        headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex",
        },
    });
});
add("POST", "/items/:id/problem", async ({ env, request, user, params }) => json(await reportProblem(env.DB, user, params.id, await readJson(request)), 201));
add("POST", "/items/:id/odometer", async ({ env, request, user, params }) =>
    json({ odometer: await addOdometer(env.DB, user, params.id, await readJson(request)) }, 201),
);
add("DELETE", "/items/:id/odometer/:reading", async ({ env, user, params }) =>
    json({ odometer: await deleteOdometer(env.DB, user, params.id, params.reading) }),
);
add("POST", "/items/:id/valuations", async ({ env, request, user, params }) =>
    json({ valuations: await addValuation(env.DB, user, params.id, await readJson(request)) }, 201),
);
add("DELETE", "/items/:id/valuations/:valuation", async ({ env, user, params }) =>
    json({ valuations: await deleteValuation(env.DB, user, params.id, params.valuation) }),
);
add("POST", "/items/:id/warranties", async ({ env, request, user, params }) =>
    json({ warranties: await createWarranty(env.DB, user, params.id, await readJson(request)) }, 201),
);
add("POST", "/items/:id/knowledge", async ({ env, request, user, params }) => {
    const { objectId } = (await readJson(request)) as { objectId?: unknown };
    return json({ knowledge: await addKnowledgeLink(env.DB, user, params.id, objectId) }, 201);
});
add("DELETE", "/items/:id/knowledge/:object", async ({ env, user, params }) =>
    json({ knowledge: await removeKnowledgeLink(env.DB, user, params.id, params.object) }),
);

add("GET", "/warranties", async ({ env, user }) => json({ warranties: await listWarranties(env.DB, user) }));
add("PATCH", "/warranties/:id", async ({ env, request, user, params }) =>
    json({ warranties: await updateWarranty(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/warranties/:id", async ({ env, user, params }) => json({ warranties: await deleteWarranty(env.DB, user, params.id) }));

add("GET", "/claims", async ({ env, user }) => json({ claims: await listClaims(env.DB, user) }));
add("POST", "/claims", async ({ env, request, user }) => json({ claim: await createClaim(env.DB, user, await readJson(request)) }, 201));
add("PATCH", "/claims/:id", async ({ env, request, user, params }) => json({ claim: await updateClaim(env.DB, user, params.id, await readJson(request)) }));

// --- Places --------------------------------------------------------------------------------------

add("GET", "/locations", async ({ env, url, user }) =>
    json({ locations: await listLocations(env.DB, user, { includeArchived: url.searchParams.get("archived") === "1" }) }),
);
add("POST", "/locations", async ({ env, request, user }) => json({ location: await createLocation(env.DB, user, await readJson(request)) }, 201));
add("GET", "/locations/:id", async ({ env, user, params }) => json({ location: await locationView(env.DB, user, params.id) }));
add("PATCH", "/locations/:id", async ({ env, request, user, params }) =>
    json({ location: await updateLocation(env.DB, user, params.id, await readJson(request)) }),
);

// --- Maintenance ---------------------------------------------------------------------------------

add("GET", "/maintenance", async ({ env, url, user }) => {
    const scope = url.searchParams.get("scope");
    return json({
        maintenance: await listMaintenance(env.DB, user, {
            scope: scope === "history" || scope === "all" ? scope : "open",
            assetId: url.searchParams.get("asset") ?? undefined,
            locationId: url.searchParams.get("location") ?? undefined,
        }),
    });
});
add("POST", "/maintenance", async ({ env, request, user }) => {
    const { record, replayed } = await createMaintenance(env.DB, user, await readJson(request));
    return json({ record, replayed }, replayed ? 200 : 201);
});
add("GET", "/maintenance/:id", async ({ env, user, params }) => json({ record: await maintenanceView(env.DB, user, params.id) }));
add("PATCH", "/maintenance/:id", async ({ env, request, user, params }) =>
    json({ record: await updateMaintenance(env.DB, user, params.id, await readJson(request)) }),
);
add("POST", "/maintenance/:id/complete", async ({ env, request, user, params }) =>
    json(await completeMaintenance(env.DB, user, params.id, await readJson(request))),
);
add("POST", "/maintenance/:id/cancel", async ({ env, user, params }) => {
    await cancelMaintenance(env.DB, user, params.id);
    return json({ record: await maintenanceView(env.DB, user, params.id) });
});
add("POST", "/maintenance/:id/appointment", async ({ env, request, user, params }) =>
    json(await createAppointment(env.DB, user, params.id, await readJson(request))),
);
add("GET", "/maintenance/:id/files", async ({ env, user, params }) => {
    await maintenanceView(env.DB, user, params.id);
    return json({ files: await filesFor(env.DB, user, "maintenance_id", params.id) });
});

add("GET", "/schedules", async ({ env, user }) => json({ schedules: await listSchedules(env.DB, user) }));
add("POST", "/schedules", async ({ env, request, user }) => json({ schedule: await createSchedule(env.DB, user, await readJson(request)) }, 201));
add("PATCH", "/schedules/:id", async ({ env, request, user, params }) =>
    json({ schedule: await updateSchedule(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/schedules/:id", async ({ env, user, params }) => {
    await deleteSchedule(env.DB, user, params.id);
    return json({ ok: true });
});

add("GET", "/templates", async ({ env }) => json({ builtin: builtinTemplates(), household: await listTemplates(env.DB) }));
add("POST", "/templates", async ({ env, request, user }) => json({ household: await createTemplate(env.DB, user, await readJson(request)) }, 201));
add("DELETE", "/templates/:id", async ({ env, user, params }) => json({ household: await deleteTemplate(env.DB, user, params.id) }));

/** A Daly Task for a record or a date, once (asking again returns the first). */
add("POST", "/tasks", async ({ env, request, user }) => json(await createLinkedTask(env.DB, user, site(env), await readJson(request))));

// --- Insurance -----------------------------------------------------------------------------------

add("GET", "/policies", async ({ env, user }) => json({ policies: await listPolicies(env.DB, user) }));
add("POST", "/policies", async ({ env, request, user }) => json({ policy: await createPolicy(env.DB, user, await readJson(request)) }, 201));
add("GET", "/policies/:id", async ({ env, user, params }) =>
    json({ policy: await policyView(env.DB, user, params.id), files: await filesFor(env.DB, user, "policy_id", params.id) }),
);
add("PATCH", "/policies/:id", async ({ env, request, user, params }) => json({ policy: await updatePolicy(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/policies/:id", async ({ env, request, user, params }) => {
    await deletePolicy(env.DB, user, params.id, await confirmOf(request));
    return json({ ok: true });
});
add("POST", "/policies/:id/verify", async ({ env, request, user, params }) => {
    const { version } = (await readJson(request)) as { version?: unknown };
    return json({ policy: await verifyPolicy(env.DB, user, params.id, version) });
});
add("POST", "/policies/:id/renew", async ({ env, request, user, params }) =>
    json({ policy: await renewPolicy(env.DB, user, params.id, await readJson(request)) }),
);
add("POST", "/policies/:id/assets", async ({ env, request, user, params }) =>
    json({ policy: await linkAsset(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/policies/:id/assets/:asset", async ({ env, user, params }) => json({ policy: await unlinkAsset(env.DB, user, params.id, params.asset) }));
add("POST", "/policies/:id/extract", async ({ env, request, user, params }) => {
    await policyView(env.DB, user, params.id);
    const { fileId } = z
        .object({ fileId: z.string().regex(/^afl_[a-z0-9]{14}$/) })
        .strict()
        .parse(await readJson(request));
    return json({ proposal: await policyProposal(env, env.DB, user, fileId) });
});

// --- Files ---------------------------------------------------------------------------------------

add("GET", "/files", async ({ env, user }) => json({ ...(await listFiles(env.DB, user)), retentionDue: await retentionDue(env.DB, user) }));
add("POST", "/files", async ({ env, request, user }) => json(await uploadFile(env.DB, env.MEDIA, user, await readJson(request, UPLOAD_BYTES)), 201));
add("PATCH", "/files/:id", async ({ env, request, user, params }) => json({ file: await updateFile(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/files/:id", async ({ env, user, params }) => {
    await deleteFile(env.DB, env.MEDIA, user, params.id);
    return json({ ok: true });
});
add("GET", "/files/:id/content", async ({ env, user, params }) => fileContent(env.DB, env.MEDIA, user, params.id));
add("GET", "/files/:id/thumb", async ({ env, user, params }) => fileContent(env.DB, env.MEDIA, user, params.id, true));

// --- Capture (optional AI) -----------------------------------------------------------------------

add("GET", "/capture/status", async ({ env }) => json(await captureStatus(env, env.DB)));
add("POST", "/capture/receipt", async ({ env, request, user }) => {
    const { fileId } = z
        .object({ fileId: z.string().regex(/^afl_[a-z0-9]{14}$/) })
        .strict()
        .parse(await readJson(request));
    return json({ proposal: await receiptProposal(env, env.DB, user, fileId) });
});
add("POST", "/capture/photo", async ({ env, request, user }) => {
    const { fileId } = z
        .object({ fileId: z.string().regex(/^afl_[a-z0-9]{14}$/) })
        .strict()
        .parse(await readJson(request));
    return json({ proposal: await photoProposal(env, env.DB, user, fileId) });
});

// --- Reports -------------------------------------------------------------------------------------

add("GET", "/reports/:name", async ({ env, url, user, params }) => {
    const name = params.name.replace(/\.csv$/, "");
    if (!(REPORTS as readonly string[]).includes(name)) throw new HttpError(404, "not_found", "Not found");
    const ids = (url.searchParams.get("assets") ?? "")
        .split(",")
        .filter((id) => /^ast_[a-z0-9]{14}$/.test(id))
        .slice(0, 200);
    const report = await reportCsv(env.DB, user, name as ReportName, { includeLowValue: url.searchParams.get("all") === "1", assetIds: ids });
    return csvResponse(report.filename, report.csv);
});

export async function handleAssetsApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    if (!can(user, "assets.use")) throw new HttpError(403, "forbidden", "You don't have access to Home & Assets");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        return route.handler({ env, request, url, user, params });
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
