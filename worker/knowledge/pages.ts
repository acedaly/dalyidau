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
import { listObjects, listTags, objectDetail, spaceCounts } from "./objects";
import { searchObjects } from "./search";
import { listMembers } from "./spaces";
import { listTypes } from "./types";

export type KnowledgePage = "home" | "list" | "object" | "search" | "types" | "settings";

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
    return { space: toSpace(row), spaces, types: await listTypes(env.DB, row.id) };
}

const LIST_VIEWS: Record<string, ListView> = { inbox: "inbox", all: "all", archive: "archived", trash: "trashed" };

export async function loadKnowledgePage(env: Env, user: PortalUser, url: URL, page: KnowledgePage, arg?: string): Promise<KnowledgeRoute | null> {
    const spaceParam = url.searchParams.get("space");
    return visible(async (): Promise<KnowledgeRoute> => {
        switch (page) {
            case "home": {
                const base = await shell(env, user, spaceParam);
                const [recent, inbox, counts] = await Promise.all([
                    listObjects(env.DB, base.space.id, { view: "all", typeId: null, tag: null, sort: "updated" }, { limit: 12, offset: 0 }),
                    listObjects(env.DB, base.space.id, { view: "inbox", typeId: null, tag: null, sort: "created" }, { limit: 6, offset: 0 }),
                    spaceCounts(env.DB, base.space.id),
                ]);
                return { route: "knowledge-home", ...base, recent: recent.objects, inbox: inbox.objects, counts };
            }
            case "list": {
                const base = await shell(env, user, spaceParam);
                const filters = parseListFilters(url, LIST_VIEWS[arg ?? "all"]);
                const [list, tags] = await Promise.all([listObjects(env.DB, base.space.id, filters, { limit: 200, offset: 0 }), listTags(env.DB, base.space.id)]);
                return { route: "knowledge-list", ...base, filters, objects: list.objects, total: list.total, tags };
            }
            case "object": {
                const access = await requireObject(env.DB, user, arg!);
                const base = await shell(env, user, access.space_id);
                return { route: "knowledge-object", ...base, detail: await objectDetail(env.DB, access.id) };
            }
            case "search": {
                const base = await shell(env, user, spaceParam);
                const query = (url.searchParams.get("q") ?? "").slice(0, 300);
                const typeId = url.searchParams.get("type") || null;
                const allSpaces = url.searchParams.get("scope") === "all";
                const hits = query
                    ? await searchObjects(env.DB, query, { spaceIds: allSpaces ? base.spaces.map((s) => s.id) : [base.space.id], typeId, status: "any" })
                    : [];
                return { route: "knowledge-search", ...base, query, hits, typeId, allSpaces };
            }
            case "types":
                return { route: "knowledge-types", ...(await shell(env, user, spaceParam)) };
            case "settings": {
                const base = await shell(env, user, spaceParam);
                const [members, audit] = await Promise.all([
                    listMembers(env.DB, user, base.space.id),
                    base.space.role === "owner" ? listKnowledgeAudit(env.DB, base.space.id, 50) : Promise.resolve(null),
                ]);
                return { route: "knowledge-settings", ...base, members, audit };
            }
        }
    });
}
