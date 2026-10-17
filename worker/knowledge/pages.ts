// First-render data for the Knowledge pages (/portal/knowledge/*). The portal page router has
// already checked the "knowledge.use" permission; these check space membership. Anything the
// caller can't see returns null, which the router turns into the ordinary 404 page.
import type { KnowledgeRoute, ListView } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { HttpError } from "../portal/http";
import { type SpaceRow, ensurePersonalSpace, listSpaces, requireObject, requireSpace, toSpace } from "./access";
import { parseListFilters } from "./api";
import { listKnowledgeAudit } from "./audit";
import { collectionItems, listCollections, listFavourites, listPins, navigationState, objectCollections, requireCollection } from "./collections";
import { calendarWindow, dailyNote, dailyNoteDates, parseDailyDate, recentDailyNotes, spaceToday } from "./daily";
import { listObjects, listTags, objectDetail, spaceCounts } from "./objects";
import { organisedIds } from "./related";
import { searchObjects } from "./search";
import { listMembers } from "./spaces";
import { getTemplate, listTemplates } from "./templates";
import { listTypes } from "./types";
import { getView, listViews } from "./views";

export type KnowledgePage =
    | "home"
    | "list"
    | "object"
    | "daily"
    | "collections"
    | "collection"
    | "favourites"
    | "templates"
    | "template"
    | "discover"
    | "search"
    | "types"
    | "settings";

/** Hidden behind 404: a space or object the caller isn't a member of. */
const visible = async <T>(load: () => Promise<T>): Promise<T | null> => {
    try {
        return await load();
    } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 403)) return null;
        throw error;
    }
};

async function shell(env: Env, user: PortalUser, spaceId: string | null) {
    await ensurePersonalSpace(env.DB, user);
    const spaces = await listSpaces(env.DB, user.email);
    let row: SpaceRow;
    if (spaceId) row = await requireSpace(env.DB, user, spaceId);
    else {
        const personal = spaces.find((s) => s.kind === "personal") ?? spaces[0];
        if (!personal) throw new HttpError(404, "not_found", "Not found");
        row = await requireSpace(env.DB, user, personal.id);
    }
    const [types, templates, favourites, collections] = await Promise.all([
        listTypes(env.DB, row.id),
        listTemplates(env.DB, row.id),
        listFavourites(env.DB, user.email, row.id, 8),
        listCollections(env.DB, row.id),
    ]);
    return {
        space: toSpace(row),
        spaces,
        types,
        templates: templates.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name, typeId: t.typeId, isDefault: t.isDefault })),
        nav: { favourites, collections: collections.slice(0, 12).map((c) => ({ id: c.id, name: c.name })), today: spaceToday(row) },
        row,
        allCollections: collections,
        allTemplates: templates,
    };
}

/** The shell without the loader-only extras. */
const base = ({ row: _row, allCollections: _c, allTemplates: _t, ...rest }: Awaited<ReturnType<typeof shell>>) => rest;

const LIST_VIEWS: Record<string, ListView> = { inbox: "inbox", all: "all", archive: "archived", trash: "trashed" };
const DISCOVER_PAGE = 50;

export async function loadKnowledgePage(env: Env, user: PortalUser, url: URL, page: KnowledgePage, arg?: string): Promise<KnowledgeRoute | null> {
    const spaceParam = url.searchParams.get("space");
    return visible(async (): Promise<KnowledgeRoute> => {
        switch (page) {
            case "home": {
                const s = await shell(env, user, spaceParam);
                const id = s.space.id;
                const [recent, inbox, counts, pinned, today] = await Promise.all([
                    listObjects(env.DB, id, { view: "all", typeId: null, tag: null, sort: "updated" }, { limit: 10, offset: 0 }),
                    listObjects(env.DB, id, { view: "inbox", typeId: null, tag: null, sort: "created" }, { limit: 5, offset: 0 }),
                    spaceCounts(env.DB, id),
                    listPins(env.DB, id),
                    dailyNote(env.DB, id, s.nav.today),
                ]);
                const todayNote = today
                    ? { date: s.nav.today, id: today.object.id, title: today.object.title, excerpt: today.object.excerpt }
                    : null;
                return {
                    route: "knowledge-home",
                    ...base(s),
                    recent: recent.objects,
                    inbox: inbox.objects,
                    counts,
                    pinned,
                    collections: s.allCollections.slice(0, 6),
                    todayNote,
                };
            }
            case "list": {
                // A saved view brings its own filters; they were validated when it was saved and again as it's read.
                const savedId = url.searchParams.get("saved");
                const saved = savedId ? await getView(env.DB, user, savedId) : null;
                const s = await shell(env, user, saved?.space.id ?? spaceParam);
                const filters = saved ? saved.view.definition : parseListFilters(url, LIST_VIEWS[arg ?? "all"]);
                const [list, tags, views] = await Promise.all([
                    listObjects(env.DB, s.space.id, filters, { limit: 200, offset: 0 }, s.row.time_zone),
                    listTags(env.DB, s.space.id),
                    listViews(env.DB, user.email, s.space.id),
                ]);
                return { route: "knowledge-list", ...base(s), filters, objects: list.objects, total: list.total, tags, views, savedView: saved?.view ?? null };
            }
            case "object": {
                const access = await requireObject(env.DB, user, arg!);
                const s = await shell(env, user, access.space_id);
                const [detail, state, collections] = await Promise.all([
                    objectDetail(env.DB, access.id),
                    navigationState(env.DB, user.email, access.id, access.space_id),
                    objectCollections(env.DB, access.id, access.space_id),
                ]);
                return { route: "knowledge-object", ...base(s), detail, state, collections };
            }
            case "daily": {
                const s = await shell(env, user, spaceParam);
                const date = parseDailyDate(arg, s.row);
                const window = calendarWindow(date);
                const [note, recent, marked] = await Promise.all([
                    dailyNote(env.DB, s.space.id, date),
                    recentDailyNotes(env.DB, s.space.id, 10),
                    dailyNoteDates(env.DB, s.space.id, window.from, window.to),
                ]);
                return { route: "knowledge-daily", ...base(s), date, today: s.nav.today, note, recent, marked };
            }
            case "collections": {
                const s = await shell(env, user, spaceParam);
                return { route: "knowledge-collections", ...base(s), collections: await listCollections(env.DB, s.space.id, { archived: true }) };
            }
            case "collection": {
                const { collection } = await requireCollection(env.DB, user, arg!);
                const s = await shell(env, user, collection.spaceId);
                const { items, total } = await collectionItems(env.DB, collection.id);
                return { route: "knowledge-collection", ...base(s), collection, items, total };
            }
            case "favourites": {
                const s = await shell(env, user, spaceParam);
                return { route: "knowledge-favourites", ...base(s), favourites: await listFavourites(env.DB, user.email) };
            }
            case "templates": {
                const s = await shell(env, user, spaceParam);
                return { route: "knowledge-templates", ...base(s), allTemplates: s.allTemplates };
            }
            case "template": {
                const template = await getTemplate(env.DB, user, arg!);
                const s = await shell(env, user, template.spaceId);
                return { route: "knowledge-template", ...base(s), template };
            }
            case "discover": {
                const s = await shell(env, user, spaceParam);
                const list = (links: "unlinked" | "no_backlinks" | "no_outgoing") =>
                    listObjects(env.DB, s.space.id, { view: "all", typeId: null, tag: null, sort: "updated", links }, { limit: DISCOVER_PAGE, offset: 0 });
                const [unlinked, noBacklinks, noOutgoing] = await Promise.all([list("unlinked"), list("no_backlinks"), list("no_outgoing")]);
                const organised = await organisedIds(env.DB, [...new Set([...unlinked.objects, ...noBacklinks.objects, ...noOutgoing.objects].map((o) => o.id))]);
                return {
                    route: "knowledge-discover",
                    ...base(s),
                    lists: { unlinked, no_backlinks: noBacklinks, no_outgoing: noOutgoing },
                    organised: [...organised],
                };
            }
            case "search": {
                const s = await shell(env, user, spaceParam);
                const query = (url.searchParams.get("q") ?? "").slice(0, 300);
                const typeId = url.searchParams.get("type") || null;
                const allSpaces = url.searchParams.get("scope") === "all";
                const hits = query
                    ? await searchObjects(env.DB, query, { spaceIds: allSpaces ? s.spaces.map((x) => x.id) : [s.space.id], typeId, status: "any" })
                    : [];
                return { route: "knowledge-search", ...base(s), query, hits, typeId, allSpaces };
            }
            case "types":
                return { route: "knowledge-types", ...base(await shell(env, user, spaceParam)) };
            case "settings": {
                const s = await shell(env, user, spaceParam);
                const [members, audit] = await Promise.all([
                    listMembers(env.DB, user, s.space.id),
                    s.space.role === "owner" ? listKnowledgeAudit(env.DB, s.space.id, 50) : Promise.resolve(null),
                ]);
                return { route: "knowledge-settings", ...base(s), members, audit };
            }
        }
    });
}
