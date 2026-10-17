// JSON API for Daly Knowledge (/api/portal/knowledge/*). By the time a request gets here the portal
// router has verified the Access identity, the portal role and the same-origin checks. This router
// adds the "knowledge.use" permission; each handler then checks the caller's membership of the
// space it touches (worker/knowledge/access.ts).
import { z } from "zod";
import { isCalendarDate } from "../../src/shared/knowledge/dates";
import { LINK_FILTERS, type LinkFilter, type ListFilters } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { HttpError, json, readJson } from "../portal/http";
import { createSharedSpace, ensurePersonalSpace, listSpaces, memberSpaceIds, requireObject, requireSpace, toSpace } from "./access";
import { listKnowledgeAudit } from "./audit";
import {
    addToCollection,
    collectionItems,
    createCollection,
    deleteCollection,
    listCollections,
    listFavourites,
    moveInCollection,
    pinInCollection,
    removeFromCollection,
    requireCollection,
    setFavourite,
    setPinned,
    updateCollection,
} from "./collections";
import { appendToDailyNote, dailyNote, ensureDailyNote, parseDailyDate, spaceToday } from "./daily";
import { exportObject, exportSpace, exportZip, objectMarkdown, safeFileStem } from "./export";
import {
    KnowledgeConflict,
    STATUS_ACTIONS,
    type StatusAction,
    addRelation,
    applyTemplateToObject,
    bulkAction,
    changeStatus,
    createObject,
    deletePermanently,
    getRevision,
    listObjects,
    listRevisions,
    listTags,
    lookupObjects,
    objectDetail,
    removeRelation,
    restoreRevision,
    updateObject,
} from "./objects";
import { relatedObjects } from "./related";
import { searchObjects } from "./search";
import { addMember, listMembers, removeMember, updateMember, updateSpace } from "./spaces";
import { createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate } from "./templates";
import { createType, listTypes, updateType } from "./types";
import { createView, deleteView, listViews, updateView } from "./views";

/** Documents can be large; everything else is small. */
const MAX_OBJECT_BYTES = 1_000_000;

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
        `^/api/portal/knowledge${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

const dateParam = (url: URL, name: string) => {
    const value = url.searchParams.get(name);
    return isCalendarDate(value) ? value : null;
};

export const parseListFilters = (url: URL, view?: ListFilters["view"]): ListFilters => {
    const views = ["all", "inbox", "archived", "trashed"] as const;
    const sorts = ["updated", "created", "title"] as const;
    const requestedView = url.searchParams.get("view") as ListFilters["view"];
    const sort = url.searchParams.get("sort") as ListFilters["sort"];
    const links = url.searchParams.get("links") as LinkFilter;
    return {
        view: view ?? (views.includes(requestedView) ? requestedView : "all"),
        typeId: url.searchParams.get("type")?.slice(0, 40) || null,
        tag: url.searchParams.get("tag")?.slice(0, 50) || null,
        sort: sorts.includes(sort) ? sort : "updated",
        links: LINK_FILTERS.includes(links) ? links : "any",
        createdFrom: dateParam(url, "created_from"),
        createdTo: dateParam(url, "created_to"),
        updatedFrom: dateParam(url, "updated_from"),
        updatedTo: dateParam(url, "updated_to"),
    };
};

const boundedInteger = (value: string | null, fallback: number, minimum: number, maximum: number) => {
    if (value === null || value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), minimum), maximum) : fallback;
};

const pageParams = (url: URL) => ({
    limit: boundedInteger(url.searchParams.get("limit"), 100, 1, 200),
    offset: boundedInteger(url.searchParams.get("offset"), 0, 0, 1_000_000),
});

// --- Spaces and members --------------------------------------------------------------------------

add("GET", "/spaces", async ({ env, user }) => {
    await ensurePersonalSpace(env.DB, user);
    return json({ spaces: await listSpaces(env.DB, user.email) });
});
add("POST", "/spaces", async ({ env, request, user }) => {
    const { name } = z.object({ name: z.string().trim().min(1, "Give the space a name").max(80) }).parse(await readJson(request));
    const id = await createSharedSpace(env.DB, user, name);
    return json({ space: toSpace(await requireSpace(env.DB, user, id)) }, 201);
});
add("PATCH", "/spaces/:space", async ({ env, request, user, params }) => {
    await updateSpace(env.DB, user, params.space, await readJson(request));
    return json({ space: toSpace(await requireSpace(env.DB, user, params.space)) });
});
add("GET", "/spaces/:space/members", async ({ env, user, params }) => json({ members: await listMembers(env.DB, user, params.space) }));
add("POST", "/spaces/:space/members", async ({ env, request, user, params }) => {
    await addMember(env, env.DB, user, params.space, await readJson(request));
    return json({ members: await listMembers(env.DB, user, params.space) }, 201);
});
add("PATCH", "/spaces/:space/members/:email", async ({ env, request, user, params }) => {
    await updateMember(env.DB, user, params.space, params.email.toLowerCase(), await readJson(request));
    return json({ members: await listMembers(env.DB, user, params.space) });
});
add("DELETE", "/spaces/:space/members/:email", async ({ env, user, params }) => {
    await removeMember(env.DB, user, params.space, params.email.toLowerCase());
    return json({ ok: true });
});
add("GET", "/spaces/:space/audit", async ({ env, user, params }) => {
    await requireSpace(env.DB, user, params.space, "owner");
    return json({ entries: await listKnowledgeAudit(env.DB, params.space) });
});

// --- Types ---------------------------------------------------------------------------------------

add("GET", "/spaces/:space/types", async ({ env, user, params }) => {
    await requireSpace(env.DB, user, params.space);
    return json({ types: await listTypes(env.DB, params.space) });
});
add("POST", "/spaces/:space/types", async ({ env, request, user, params }) =>
    json({ type: await createType(env.DB, user, params.space, await readJson(request)) }, 201),
);
add("PATCH", "/types/:id", async ({ env, request, user, params }) => json({ type: await updateType(env.DB, user, params.id, await readJson(request)) }));

// --- Objects -------------------------------------------------------------------------------------

add("GET", "/spaces/:space/objects", async ({ env, url, user, params }) => {
    const space = await requireSpace(env.DB, user, params.space);
    return json(await listObjects(env.DB, params.space, parseListFilters(url), pageParams(url), space.time_zone));
});
add("POST", "/spaces/:space/objects", async ({ env, request, user, params }) =>
    json(await createObject(env.DB, user, params.space, await readJson(request, MAX_OBJECT_BYTES)), 201),
);
add("POST", "/spaces/:space/objects/bulk", async ({ env, request, user, params }) =>
    json(await bulkAction(env.DB, user, params.space, await readJson(request))),
);
add("GET", "/spaces/:space/lookup", async ({ env, url, user, params }) => {
    await requireSpace(env.DB, user, params.space);
    return json({ results: await lookupObjects(env.DB, params.space, url.searchParams.get("q") ?? "") });
});
add("GET", "/spaces/:space/tags", async ({ env, user, params }) => {
    await requireSpace(env.DB, user, params.space);
    return json({ tags: await listTags(env.DB, params.space) });
});

add("GET", "/objects/:id", async ({ env, user, params }) => {
    await requireObject(env.DB, user, params.id);
    return json(await objectDetail(env.DB, params.id));
});
add("PATCH", "/objects/:id", async ({ env, request, user, params }) =>
    json(await updateObject(env.DB, user, params.id, await readJson(request, MAX_OBJECT_BYTES))),
);
add("POST", "/objects/:id/status/:action", async ({ env, user, params }) => {
    if (!(params.action in STATUS_ACTIONS)) throw new HttpError(404, "not_found", "Not found");
    return json(await changeStatus(env.DB, user, params.id, params.action as StatusAction));
});
add("POST", "/objects/:id/delete", async ({ env, request, user, params }) => {
    await deletePermanently(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("GET", "/objects/:id/revisions", async ({ env, user, params }) => json({ revisions: await listRevisions(env.DB, user, params.id) }));
add("GET", "/objects/:id/revisions/:revision", async ({ env, user, params }) =>
    json({ revision: await getRevision(env.DB, user, params.id, params.revision) }),
);
add("POST", "/objects/:id/revisions/:revision/restore", async ({ env, request, user, params }) =>
    json(await restoreRevision(env.DB, user, params.id, params.revision, await readJson(request))),
);
add("POST", "/objects/:id/relations", async ({ env, request, user, params }) => json(await addRelation(env.DB, user, params.id, await readJson(request)), 201));
add("DELETE", "/relations/:id", async ({ env, user, params }) => {
    await removeRelation(env.DB, user, params.id);
    return json({ ok: true });
});

add("GET", "/objects/:id/related", async ({ env, user, params }) => {
    const access = await requireObject(env.DB, user, params.id);
    return json({ related: await relatedObjects(env.DB, access.id, access.space_id) });
});
add("POST", "/objects/:id/apply-template", async ({ env, request, user, params }) =>
    json(await applyTemplateToObject(env.DB, user, params.id, await readJson(request))),
);
const toggle = (key: string) => z.object({ [key]: z.boolean() });
add("POST", "/objects/:id/favourite", async ({ env, request, user, params }) => {
    const body = toggle("favourite").parse(await readJson(request)) as { favourite: boolean };
    await setFavourite(env.DB, user, params.id, body.favourite);
    return json({ ok: true });
});
add("POST", "/objects/:id/pin", async ({ env, request, user, params }) => {
    const body = toggle("pinned").parse(await readJson(request)) as { pinned: boolean };
    await setPinned(env.DB, user, params.id, body.pinned);
    return json({ ok: true });
});
add("GET", "/favourites", async ({ env, user }) => json({ favourites: await listFavourites(env.DB, user.email) }));

// --- Daily notes ---------------------------------------------------------------------------------

add("POST", "/spaces/:space/daily/append", async ({ env, request, user, params }) =>
    json(await appendToDailyNote(env.DB, user, params.space, await readJson(request, MAX_OBJECT_BYTES))),
);
add("GET", "/spaces/:space/daily/:date", async ({ env, user, params }) => {
    const space = await requireSpace(env.DB, user, params.space);
    const date = parseDailyDate(params.date, space);
    return json({ date, today: spaceToday(space), note: await dailyNote(env.DB, space.id, date) });
});
add("POST", "/spaces/:space/daily/:date", async ({ env, user, params }) => {
    const space = await requireSpace(env.DB, user, params.space, "editor");
    return json(await ensureDailyNote(env.DB, user, space.id, parseDailyDate(params.date, space)));
});

// --- Collections ---------------------------------------------------------------------------------

add("GET", "/spaces/:space/collections", async ({ env, url, user, params }) => {
    await requireSpace(env.DB, user, params.space);
    return json({ collections: await listCollections(env.DB, params.space, { archived: url.searchParams.get("archived") === "1" }) });
});
add("POST", "/spaces/:space/collections", async ({ env, request, user, params }) =>
    json({ collection: await createCollection(env.DB, user, params.space, await readJson(request)) }, 201),
);
add("GET", "/collections/:id", async ({ env, url, user, params }) => {
    const { collection } = await requireCollection(env.DB, user, params.id);
    return json({ collection, ...(await collectionItems(env.DB, collection.id, pageParams(url))) });
});
add("PATCH", "/collections/:id", async ({ env, request, user, params }) =>
    json({ collection: await updateCollection(env.DB, user, params.id, await readJson(request)) }),
);
add("DELETE", "/collections/:id", async ({ env, user, params }) => {
    await deleteCollection(env.DB, user, params.id);
    return json({ ok: true });
});
add("POST", "/collections/:id/items", async ({ env, request, user, params }) => json(await addToCollection(env.DB, user, params.id, await readJson(request)), 201));
add("DELETE", "/collections/:id/items/:object", async ({ env, user, params }) => {
    await removeFromCollection(env.DB, user, params.id, params.object);
    return json({ ok: true });
});
add("POST", "/collections/:id/move", async ({ env, request, user, params }) => {
    await moveInCollection(env.DB, user, params.id, await readJson(request));
    return json({ ok: true });
});
add("POST", "/collections/:id/items/:object/pin", async ({ env, request, user, params }) => {
    const body = toggle("pinned").parse(await readJson(request)) as { pinned: boolean };
    await pinInCollection(env.DB, user, params.id, params.object, body.pinned);
    return json({ ok: true });
});

// --- Saved views ---------------------------------------------------------------------------------

add("GET", "/spaces/:space/views", async ({ env, user, params }) => {
    await requireSpace(env.DB, user, params.space);
    return json({ views: await listViews(env.DB, user.email, params.space) });
});
add("POST", "/spaces/:space/views", async ({ env, request, user, params }) =>
    json({ view: await createView(env.DB, user, params.space, await readJson(request)) }, 201),
);
add("PATCH", "/views/:id", async ({ env, request, user, params }) => json({ view: await updateView(env.DB, user, params.id, await readJson(request)) }));
add("DELETE", "/views/:id", async ({ env, user, params }) => {
    await deleteView(env.DB, user, params.id);
    return json({ ok: true });
});

// --- Templates -----------------------------------------------------------------------------------

add("GET", "/spaces/:space/templates", async ({ env, user, params }) => {
    await requireSpace(env.DB, user, params.space);
    return json({ templates: await listTemplates(env.DB, params.space) });
});
add("POST", "/spaces/:space/templates", async ({ env, request, user, params }) =>
    json({ template: await createTemplate(env.DB, user, params.space, await readJson(request, MAX_OBJECT_BYTES)) }, 201),
);
add("GET", "/templates/:id", async ({ env, user, params }) => json({ template: await getTemplate(env.DB, user, params.id) }));
add("PATCH", "/templates/:id", async ({ env, request, user, params }) =>
    json({ template: await updateTemplate(env.DB, user, params.id, await readJson(request, MAX_OBJECT_BYTES)) }),
);
add("DELETE", "/templates/:id", async ({ env, user, params }) => {
    await deleteTemplate(env.DB, user, params.id);
    return json({ ok: true });
});

// --- Export --------------------------------------------------------------------------------------

/** Exports are private downloads: never cached, never rendered, never sniffed. */
const download = (body: BodyInit, type: string, filename: string) =>
    new Response(body, {
        headers: {
            "Content-Type": type,
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex",
        },
    });
const asciiName = (name: string) => safeFileStem(name).replace(/[^A-Za-z0-9 _-]+/g, "").replace(/\s+/g, "-").toLowerCase() || "knowledge";

add("GET", "/objects/:id/export", async ({ env, url, user, params }) => {
    const format = url.searchParams.get("format") === "json" ? "json" : "markdown";
    const data = await exportObject(env.DB, user, params.id, { revisions: format === "json" && url.searchParams.get("revisions") !== "0" });
    const stem = asciiName(data.objects[0].title || "untitled");
    return format === "json"
        ? download(JSON.stringify(data, null, 2), "application/json; charset=utf-8", `${stem}.json`)
        : download(objectMarkdown(data, params.id), "text/markdown; charset=utf-8", `${stem}.md`);
});
add("GET", "/spaces/:space/export", async ({ env, url, user, params }) => {
    const format = url.searchParams.get("format") === "json" ? "json" : "zip";
    const data = await exportSpace(env.DB, user, params.space, { revisions: url.searchParams.get("revisions") !== "0" });
    const stem = `${asciiName(data.space.name)}-${data.exportedAt.slice(0, 10)}`;
    return format === "json"
        ? download(JSON.stringify(data, null, 2), "application/json; charset=utf-8", `${stem}.json`)
        : download(exportZip(data), "application/zip", `${stem}.zip`);
});

// --- Search --------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
add("GET", "/search", async ({ env, url, user }) => {
    const q = (url.searchParams.get("q") ?? "").slice(0, 300);
    const space = url.searchParams.get("space");
    // Only ever the caller's own spaces; a named space must be one of them.
    const spaceIds = space ? [(await requireSpace(env.DB, user, space)).id] : await memberSpaceIds(env.DB, user.email);
    const status = url.searchParams.get("status");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const hits = await searchObjects(env.DB, q, {
        spaceIds,
        typeId: url.searchParams.get("type") || null,
        tag: url.searchParams.get("tag") || null,
        status: status === "archived" || status === "any" ? status : "active",
        updatedFrom: from && DATE.test(from) ? from : null,
        updatedTo: to && DATE.test(to) ? to : null,
        limit: boundedInteger(url.searchParams.get("limit"), 50, 1, 100),
    });
    return json({ hits });
});

// --- Dispatch ------------------------------------------------------------------------------------

export async function handleKnowledgeApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        try {
            return await route.handler({ env, request, url, user, params });
        } catch (error) {
            // The editor needs to know which version is current to offer a way forward.
            if (error instanceof KnowledgeConflict) return json({ error: error.code, message: error.message, current: error.current }, 409);
            throw error;
        }
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
