// Saved views: a name for a combination of the list's own filters and sort. A definition is data
// checked against the fixed fields below, never SQL or column names, and it is run by the same
// listObjects as every other list. Private views belong to one person; shared views belong to the
// space (editors manage them). Both are read through the caller's current membership.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { isCalendarDate } from "../../src/shared/knowledge/dates";
import { type KnowledgeSavedView, LINK_FILTERS, type ListFilters, roleAtLeast } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { isGuardFailure, newId, nowIso, parseJson, requireChange } from "../portal/db";
import { HttpError } from "../portal/http";
import { notFound, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";

const date = z
    .string()
    .refine(isCalendarDate, "Use a date as YYYY-MM-DD")
    .nullable()
    .default(null);

/** The only shape a saved definition can take. Unknown fields are refused. */
export const viewDefinition = z
    .object({
        view: z.enum(["all", "inbox", "archived", "trashed"]).default("all"),
        typeId: z
            .string()
            .regex(/^kty_[a-z0-9]{14}$/)
            .nullable()
            .default(null),
        tag: z.string().trim().min(1).max(50).nullable().default(null),
        sort: z.enum(["updated", "created", "title"]).default("updated"),
        links: z.enum(LINK_FILTERS).default("any"),
        createdFrom: date,
        createdTo: date,
        updatedFrom: date,
        updatedTo: date,
    })
    .strict();

export const MAX_VIEWS = 100;

interface ViewRow {
    id: string;
    space_id: string;
    owner_email: string | null;
    name: string;
    definition_json: string;
    version: number;
}

/** Reads a stored definition defensively: anything that no longer validates falls back to "all". */
export const storedDefinition = (json: string): ListFilters => {
    const parsed = viewDefinition.safeParse(parseJson(json, {}));
    return parsed.success ? parsed.data : viewDefinition.parse({});
};

const toView = (row: ViewRow, email: string): KnowledgeSavedView => ({
    id: row.id,
    name: row.name,
    shared: row.owner_email === null,
    mine: row.owner_email !== null && row.owner_email.toLowerCase() === email.toLowerCase(),
    definition: storedDefinition(row.definition_json),
    version: row.version,
});

/** The space's shared views and the caller's own private ones. */
export async function listViews(db: D1Database, email: string, spaceId: string): Promise<KnowledgeSavedView[]> {
    const rows = await db
        .prepare(
            `SELECT id, space_id, owner_email, name, definition_json, version FROM knowledge_saved_views
             WHERE space_id = ? AND (owner_email IS NULL OR owner_email = ?) ORDER BY owner_email IS NULL, sort_order, name COLLATE NOCASE LIMIT ${MAX_VIEWS * 2}`,
        )
        .bind(spaceId, email)
        .all<ViewRow>();
    return rows.results.map((r) => toView(r, email));
}

/** A view the caller can see: shared in a space they belong to, or their own. Others get 404. */
export async function getView(db: D1Database, user: PortalUser, viewId: string) {
    const row = await db
        .prepare("SELECT id, space_id, owner_email, name, definition_json, version FROM knowledge_saved_views WHERE id = ?")
        .bind(viewId)
        .first<ViewRow>();
    if (!row || (row.owner_email !== null && row.owner_email.toLowerCase() !== user.email.toLowerCase())) throw notFound();
    const space = await requireSpace(db, user, row.space_id);
    return { view: toView(row, user.email), space };
}

/** Shared views are the space's, so changing them needs an editor; private views only their owner. */
const requireManage = (space: { role: Parameters<typeof roleAtLeast>[0] }, shared: boolean) => {
    if (shared && !roleAtLeast(space.role, "editor")) throw new HttpError(403, "forbidden", "Only editors can change the space's shared views");
};

const viewInput = z.object({
    name: z.string().trim().min(1, "Give the view a name").max(80),
    shared: z.boolean().default(false),
    definition: viewDefinition,
});

export async function createView(db: D1Database, user: PortalUser, spaceId: string, input: unknown): Promise<KnowledgeSavedView> {
    const space = await requireSpace(db, user, spaceId);
    const body = viewInput.parse(input);
    requireManage(space, body.shared);
    const count = await db
        .prepare("SELECT COUNT(*) AS n FROM knowledge_saved_views WHERE space_id = ? AND (owner_email IS NULL OR owner_email = ?)")
        .bind(spaceId, user.email)
        .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_VIEWS) throw new HttpError(422, "validation", `Up to ${MAX_VIEWS} saved views per space`);
    await checkDefinition(db, spaceId, body.definition);
    const id = newId("kvw");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                `INSERT INTO knowledge_saved_views (id, space_id, owner_email, name, definition_json, sort_order, created_by, updated_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM knowledge_saved_views WHERE space_id = ?), ?, ?, ?, ?)`,
            )
            .bind(id, spaceId, body.shared ? null : user.email, body.name, JSON.stringify(body.definition), spaceId, user.email, user.email, now, now),
        knowledgeAudit(db, {
            spaceId,
            actor: user.email,
            action: "view.create",
            entityType: "view",
            entityId: id,
            summary: body.shared ? "Created a shared view" : "Created a private view",
        }),
    ]);
    return (await getView(db, user, id)).view;
}

/** A type in a definition must be in the view's space. */
async function checkDefinition(db: D1Database, spaceId: string, definition: z.infer<typeof viewDefinition>) {
    if (!definition.typeId) return;
    const found = await db.prepare("SELECT 1 FROM knowledge_object_types WHERE id = ? AND space_id = ?").bind(definition.typeId, spaceId).first();
    if (!found) throw new HttpError(422, "validation", "That object type isn't in this space");
}

const viewPatch = z.object({ version: z.number().int().min(1), name: viewInput.shape.name.optional(), definition: viewDefinition.optional() }).strict();

export async function updateView(db: D1Database, user: PortalUser, viewId: string, input: unknown): Promise<KnowledgeSavedView> {
    const { view, space } = await getView(db, user, viewId);
    requireManage(space, view.shared);
    const body = viewPatch.parse(input);
    if (body.definition) await checkDefinition(db, space.id, body.definition);
    const stale = () => new HttpError(409, "conflict", "This view changed in the meantime. Reload and try again.");
    if (body.version !== view.version) throw stale();
    try {
        await db.batch([
            db
                .prepare(
                    "UPDATE knowledge_saved_views SET name = ?, definition_json = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
                )
                .bind(body.name ?? view.name, JSON.stringify(body.definition ?? view.definition), user.email, nowIso(), viewId, body.version),
            requireChange(db),
            knowledgeAudit(db, { spaceId: space.id, actor: user.email, action: "view.update", entityType: "view", entityId: viewId, summary: "Changed a saved view" }),
        ]);
    } catch (error) {
        if (isGuardFailure(error)) throw stale();
        throw error;
    }
    return (await getView(db, user, viewId)).view;
}

export async function deleteView(db: D1Database, user: PortalUser, viewId: string): Promise<void> {
    const { view, space } = await getView(db, user, viewId);
    requireManage(space, view.shared);
    await db.batch([
        db.prepare("DELETE FROM knowledge_saved_views WHERE id = ?").bind(viewId),
        knowledgeAudit(db, { spaceId: space.id, actor: user.email, action: "view.delete", entityType: "view", entityId: viewId, summary: "Deleted a saved view" }),
    ]);
}
