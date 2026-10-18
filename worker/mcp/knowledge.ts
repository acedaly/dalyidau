// Daly Knowledge tools for the MCP gateway. Every read and write goes through Knowledge's own
// functions (worker/knowledge), so space membership decides everything: an object in a space the
// caller doesn't belong to is "not found", exactly as in the portal, and portal roles grant nothing
// inside a space.
//
// Text from an AI client is never parsed as markup. It becomes plain paragraphs of the allow-listed
// daly.doc.v1 document (paragraphsFromText), and documents are read back as escaped Markdown
// (documentToMarkdown). Rich content an AI client didn't write is never replaced: an object's body
// can be appended to, but not overwritten, through this interface. Deliberately absent: trashing,
// deleting, restoring revisions, bulk changes, types, templates, collections, sharing and members.
import { z } from "zod";
import { type DocNode, paragraphsFromText } from "../../src/shared/knowledge/content";
import { documentToMarkdown } from "../../src/shared/knowledge/markdown";
import { HIGHLIGHT_END, HIGHLIGHT_START, type KnowledgeObjectDetail, type KnowledgeObjectSummary, type KnowledgeType } from "../../src/shared/knowledge/types";
import { ensurePersonalSpace, listSpaces, memberSpaceIds, requireObject, requireSpace } from "../knowledge/access";
import { appendToDailyNote, dailyNote, ensureDailyNote, parseDailyDate, spaceToday } from "../knowledge/daily";
import { KnowledgeConflict, createObject, listObjects, objectDetail, updateObject } from "../knowledge/objects";
import { relatedObjects } from "../knowledge/related";
import { searchObjects } from "../knowledge/search";
import { listTypes } from "../knowledge/types";
import { can } from "../portal/auth";
import { HttpError } from "../portal/http";
import { relatedForObject } from "../tasks/knowledge";
import { type ToolContext, type ToolDef, calendarDate, id, limit, portalUrl, requestId, tool } from "./shared";

const spaceId = id("ksp", "space");
const objectId = id("kob", "Knowledge object");
const text = z.string().trim().min(1).max(20_000);
const tags = z.array(z.string().max(50)).max(30);
const properties = z.record(z.string().max(40), z.unknown());
/** Markdown of a document is cut at this many characters; the full text stays in the portal. */
const MAX_MARKDOWN = 30_000;

/** The caller's personal space: the default when no space is named. */
async function personalSpaceId(ctx: ToolContext): Promise<string> {
    await ensurePersonalSpace(ctx.db, ctx.user);
    const row = await ctx.db
        .prepare("SELECT id FROM knowledge_spaces WHERE kind = 'personal' AND personal_owner = ?")
        .bind(ctx.user.email)
        .first<{ id: string }>();
    return row!.id;
}

const spaceFor = async (ctx: ToolContext, requested: string | undefined) => requested ?? (await personalSpaceId(ctx));

/** A type in the space by id, slug or name ("note", "Person"). Unknown types are a validation error, never a guess. */
async function resolveType(ctx: ToolContext, space: string, type: string | undefined): Promise<string | undefined> {
    if (!type) return undefined;
    const types = await listTypes(ctx.db, space);
    const wanted = type.trim().toLowerCase();
    const found = types.find((t) => t.id === type || t.slug === wanted || t.name.toLowerCase() === wanted);
    if (!found) throw new HttpError(422, "validation", `No object type “${type.slice(0, 60)}” in this space. Use knowledge_list_types to see them.`);
    return found.id;
}

export const typeNames = async (ctx: ToolContext, spaceIds: string[]) => {
    const names = new Map<string, string>();
    for (const space of [...new Set(spaceIds)].slice(0, 10)) for (const t of await listTypes(ctx.db, space)) names.set(t.id, t.name);
    return names;
};

export const summaryOut = (ctx: ToolContext, o: KnowledgeObjectSummary, types: Map<string, string>) => ({
    id: o.id,
    spaceId: o.spaceId,
    title: o.title || "Untitled",
    type: types.get(o.typeId) ?? null,
    typeId: o.typeId,
    status: o.status,
    inInbox: o.inInbox,
    dailyDate: o.dailyDate,
    tags: o.tags,
    excerpt: o.excerpt.replace(/\s+/g, " ").trim(),
    updatedAt: o.updatedAt,
    updatedBy: o.updatedBy,
    url: portalUrl(ctx, `/portal/knowledge/o/${o.id}`),
});

const linkOut = (ctx: ToolContext, l: KnowledgeObjectDetail["outgoing"][number], types: Map<string, string>) => ({
    objectId: l.object.id,
    title: l.object.title || "Untitled",
    type: types.get(l.object.typeId) ?? null,
    status: l.object.status,
    origin: l.origin,
    url: portalUrl(ctx, `/portal/knowledge/o/${l.object.id}`),
});

async function detailOut(ctx: ToolContext, detail: KnowledgeObjectDetail) {
    const o = detail.object;
    const types = await typeNames(ctx, [o.spaceId]);
    const markdown = documentToMarkdown(o.content as DocNode, { objectLink: (_id, label) => `[[${label}]]` });
    return {
        object: {
            ...summaryOut(ctx, o, types),
            version: o.version,
            properties: o.properties,
            content: markdown.slice(0, MAX_MARKDOWN),
            contentTruncated: markdown.length > MAX_MARKDOWN,
            createdAt: o.createdAt,
            createdBy: o.createdBy,
        },
        outgoing: detail.outgoing.slice(0, 50).map((l) => linkOut(ctx, l, types)),
        backlinks: detail.backlinks.slice(0, 50).map((l) => linkOut(ctx, l, types)),
        referenced: Object.values(detail.referenced).map((r) => ({ objectId: r.id, title: r.title || "Untitled", status: r.status })),
        ...(detail.notices?.length ? { notices: detail.notices } : {}),
    };
}

const objectWritten = async (ctx: ToolContext, detail: KnowledgeObjectDetail) => ({
    data: await detailOut(ctx, detail),
    outcome: { entityType: "knowledge_object" as const, entityId: detail.object.id },
});

const replayObject = async (ctx: ToolContext, outcome: { entityId: string }) => {
    // Membership is checked again: someone removed from the space since gets nothing back.
    await requireObject(ctx.db, ctx.user, outcome.entityId);
    return { data: { ...(await detailOut(ctx, await objectDetail(ctx.db, outcome.entityId))), replayed: true } };
};

/** Search snippets mark matches with control characters; MCP clients get «…» instead. */
const snippet = (value: string) => value.split(HIGHLIGHT_START).join("«").split(HIGHLIGHT_END).join("»").replace(/\s+/g, " ").trim();

// --- Reads ---------------------------------------------------------------------------------------

const knowledgeListSpaces = tool({
    name: "knowledge_list_spaces",
    write: false,
    permission: "knowledge.use",
    input: z.object({}).strict(),
    run: async (ctx) => {
        await ensurePersonalSpace(ctx.db, ctx.user);
        const spaces = await listSpaces(ctx.db, ctx.user.email);
        return {
            data: {
                spaces: spaces.map((s) => ({
                    id: s.id,
                    name: s.name,
                    kind: s.kind,
                    role: s.role,
                    timeZone: s.timeZone,
                    today: spaceToday({ time_zone: s.timeZone }),
                })),
            },
        };
    },
});

const knowledgeListTypes = tool({
    name: "knowledge_list_types",
    write: false,
    permission: "knowledge.use",
    input: z.object({ spaceId: spaceId.optional() }).strict(),
    run: async (ctx, input) => {
        const space = await requireSpace(ctx.db, ctx.user, await spaceFor(ctx, input.spaceId));
        const types = (await listTypes(ctx.db, space.id)).filter((t: KnowledgeType) => !t.archived);
        return {
            data: {
                spaceId: space.id,
                types: types.map((t) => ({
                    id: t.id,
                    name: t.name,
                    slug: t.slug,
                    description: t.description,
                    objectCount: t.objectCount,
                    properties: t.schema.properties.map((p) => ({
                        key: p.key,
                        label: p.label,
                        type: p.type,
                        required: p.required,
                        ...(p.options ? { options: p.options.map((o) => o.id) } : {}),
                        ...(p.multiple !== undefined ? { multiple: p.multiple } : {}),
                    })),
                })),
            },
        };
    },
});

const knowledgeSearch = tool({
    name: "knowledge_search",
    write: false,
    permission: "knowledge.use",
    input: z
        .object({
            query: z.string().trim().min(1).max(300),
            spaceId: spaceId.optional(),
            type: z.string().max(60).optional(),
            tag: z.string().max(50).optional(),
            status: z.enum(["active", "archived", "any"]).default("active"),
            limit: limit(10, 25),
        })
        .strict(),
    run: async (ctx, input) => {
        // Only ever the caller's own spaces; a named space must be one of them.
        const spaceIds = input.spaceId ? [(await requireSpace(ctx.db, ctx.user, input.spaceId)).id] : await memberSpaceIds(ctx.db, ctx.user.email);
        const typeId = input.spaceId ? await resolveType(ctx, input.spaceId, input.type) : input.type?.startsWith("kty_") ? input.type : undefined;
        if (input.type && !typeId) throw new HttpError(422, "validation", "Name a space to search by type name, or pass the type's id");
        const hits = await searchObjects(ctx.db, input.query, {
            spaceIds,
            typeId: typeId ?? null,
            tag: input.tag ?? null,
            status: input.status,
            limit: input.limit,
        });
        const types = await typeNames(
            ctx,
            hits.map((h) => h.object.spaceId),
        );
        return {
            data: {
                results: hits.map((h) => ({ ...summaryOut(ctx, h.object, types), titleMatch: snippet(h.titleSnippet), bodyMatch: snippet(h.bodySnippet) })),
                count: hits.length,
                // The search is ranked and capped; a full result fills the limit.
                mayHaveMore: hits.length === input.limit,
            },
        };
    },
});

const knowledgeGetObject = tool({
    name: "knowledge_get_object",
    write: false,
    permission: "knowledge.use",
    input: z.object({ objectId }).strict(),
    run: async (ctx, { objectId }) => {
        await requireObject(ctx.db, ctx.user, objectId);
        return { data: await detailOut(ctx, await objectDetail(ctx.db, objectId)) };
    },
});

const knowledgeListObjects = tool({
    name: "knowledge_list_objects",
    write: false,
    permission: "knowledge.use",
    input: z
        .object({
            spaceId: spaceId.optional(),
            view: z.enum(["all", "inbox", "archived"]).default("all"),
            type: z.string().max(60).optional(),
            tag: z.string().max(50).optional(),
            sort: z.enum(["updated", "created", "title"]).default("updated"),
            updatedFrom: calendarDate.optional(),
            limit: limit(25, 100),
            offset: z.number().int().min(0).max(100_000).default(0),
        })
        .strict(),
    run: async (ctx, input) => {
        const space = await requireSpace(ctx.db, ctx.user, await spaceFor(ctx, input.spaceId));
        const { objects, total } = await listObjects(
            ctx.db,
            space.id,
            {
                view: input.view,
                typeId: (await resolveType(ctx, space.id, input.type)) ?? null,
                tag: input.tag ?? null,
                sort: input.sort,
                links: "any",
                createdFrom: null,
                createdTo: null,
                updatedFrom: input.updatedFrom ?? null,
                updatedTo: null,
            },
            { limit: input.limit, offset: input.offset },
            space.time_zone,
        );
        const types = await typeNames(ctx, [space.id]);
        const more = input.offset + objects.length < total;
        return {
            data: { spaceId: space.id, objects: objects.map((o) => summaryOut(ctx, o, types)), total, nextOffset: more ? input.offset + objects.length : null },
        };
    },
});

const knowledgeGetRelated = tool({
    name: "knowledge_get_related",
    write: false,
    permission: "knowledge.use",
    input: z.object({ objectId }).strict(),
    run: async (ctx, { objectId }) => {
        const access = await requireObject(ctx.db, ctx.user, objectId);
        const [detail, suggestions] = await Promise.all([objectDetail(ctx.db, objectId), relatedObjects(ctx.db, access.id, access.space_id)]);
        const types = await typeNames(ctx, [access.space_id]);
        // Linked tasks only for people who can use Tasks, and only tasks in projects they belong to.
        const tasks = can(ctx.user, "tasks.use") ? await relatedForObject(ctx.db, ctx.user, objectId) : null;
        return {
            data: {
                objectId,
                outgoing: detail.outgoing.slice(0, 50).map((l) => linkOut(ctx, l, types)),
                backlinks: detail.backlinks.slice(0, 50).map((l) => linkOut(ctx, l, types)),
                // Suggestions are computed from shared tags, links and similar titles: not facts, just leads.
                suggested: suggestions.map((s) => ({
                    objectId: s.object.id,
                    title: s.object.title || "Untitled",
                    strength: s.strength,
                    reasons: s.reasons,
                    url: portalUrl(ctx, `/portal/knowledge/o/${s.object.id}`),
                })),
                ...(tasks
                    ? {
                          linkedTasks: tasks.tasks
                              .slice(0, 25)
                              .map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: t.dueDate, url: portalUrl(ctx, `/portal/tasks/t/${t.id}`) })),
                          linkedProjects: tasks.projects.map((p) => ({ id: p.id, name: p.name, url: portalUrl(ctx, `/portal/tasks/p/${p.id}`) })),
                      }
                    : {}),
            },
        };
    },
});

const knowledgeGetDailyNote = tool({
    name: "knowledge_get_daily_note",
    write: false,
    permission: "knowledge.use",
    input: z.object({ spaceId: spaceId.optional(), date: z.union([z.literal("today"), calendarDate]).default("today") }).strict(),
    run: async (ctx, input) => {
        const space = await requireSpace(ctx.db, ctx.user, await spaceFor(ctx, input.spaceId));
        const date = parseDailyDate(input.date, space);
        const note = await dailyNote(ctx.db, space.id, date);
        // No note means nobody wrote one: say so rather than inventing an empty one.
        return { data: { spaceId: space.id, date, today: spaceToday(space), exists: !!note, ...(note ? await detailOut(ctx, note) : {}) } };
    },
});

// --- Writes --------------------------------------------------------------------------------------

const knowledgeCreateObject = tool({
    name: "knowledge_create_object",
    write: true,
    permission: "knowledge.use",
    input: z
        .object({
            spaceId: spaceId.optional(),
            type: z.string().max(60).optional(),
            title: z.string().trim().min(1).max(300),
            text: text.optional(),
            tags: tags.optional(),
            properties: properties.optional(),
            inInbox: z.boolean().default(false),
            requestId,
        })
        .strict(),
    run: async (ctx, input) => {
        const space = await spaceFor(ctx, input.spaceId);
        const typeId = await resolveType(ctx, space, input.type);
        const detail = await createObject(ctx.db, ctx.user, space, {
            ...(typeId ? { typeId } : {}),
            title: input.title,
            content: { type: "doc", content: input.text ? paragraphsFromText(input.text) : [] },
            properties: input.properties ?? {},
            tags: input.tags ?? [],
            inInbox: input.inInbox,
        });
        return objectWritten(ctx, detail);
    },
    replay: replayObject,
});

const knowledgeUpdateObject = tool({
    name: "knowledge_update_object",
    write: true,
    permission: "knowledge.use",
    input: z
        .object({
            objectId,
            version: z.number().int().min(1),
            title: z.string().trim().min(1).max(300).optional(),
            tags: tags.optional(),
            properties: properties.optional(),
            inInbox: z.boolean().optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, { objectId, requestId: _, ...changes }) => objectWritten(ctx, await updateObject(ctx.db, ctx.user, objectId, changes)),
    replay: replayObject,
});

const knowledgeAppendToObject = tool({
    name: "knowledge_append_to_object",
    write: true,
    permission: "knowledge.use",
    input: z.object({ objectId, text, version: z.number().int().min(1).optional(), requestId }).strict(),
    run: async (ctx, input) => {
        const added = paragraphsFromText(input.text);
        // Appending can't lose anyone's edit, so without a version a concurrent save is retried on
        // the newer version. With a version, a newer save is a conflict, as in the editor.
        for (let attempt = 0; ; attempt++) {
            await requireObject(ctx.db, ctx.user, input.objectId, "editor");
            const current = await objectDetail(ctx.db, input.objectId);
            const doc = current.object.content as DocNode;
            try {
                const detail = await updateObject(ctx.db, ctx.user, input.objectId, {
                    version: input.version ?? current.object.version,
                    content: { type: "doc", content: [...(doc.content ?? []), ...added] },
                });
                return objectWritten(ctx, detail);
            } catch (error) {
                if (!(error instanceof KnowledgeConflict) || input.version !== undefined || attempt >= 2) throw error;
            }
        }
    },
    replay: replayObject,
});

const knowledgeCreateDailyNote = tool({
    name: "knowledge_create_daily_note",
    write: true,
    permission: "knowledge.use",
    input: z
        .object({ spaceId: spaceId.optional(), date: z.union([z.literal("today"), calendarDate]).default("today"), text: text.optional(), requestId })
        .strict(),
    run: async (ctx, input) => {
        const space = await requireSpace(ctx.db, ctx.user, await spaceFor(ctx, input.spaceId), "editor");
        const date = parseDailyDate(input.date, space);
        // Appending stamps the time and goes through the versioned update path; without text this
        // only makes sure the note exists (the same note every time, never a second one).
        const detail = input.text
            ? await appendToDailyNote(ctx.db, ctx.user, space.id, { text: input.text, date })
            : await ensureDailyNote(ctx.db, ctx.user, space.id, date);
        return objectWritten(ctx, detail);
    },
    replay: replayObject,
});

export const KNOWLEDGE_TOOLS: ToolDef[] = [
    knowledgeListSpaces,
    knowledgeListTypes,
    knowledgeSearch,
    knowledgeGetObject,
    knowledgeListObjects,
    knowledgeGetRelated,
    knowledgeGetDailyNote,
    knowledgeCreateObject,
    knowledgeUpdateObject,
    knowledgeAppendToObject,
    knowledgeCreateDailyNote,
];
