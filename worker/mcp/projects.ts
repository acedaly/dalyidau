// Daly Tasks project tools for the MCP gateway: find, create, edit, archive and restore projects.
//
// Like the task tools, each one calls the functions the portal's own API uses (worker/tasks), so
// the rules are the browser's: the creator is the only member and owner of a new project (a shared
// project starts with nobody else in it; members are added in the portal), editors change details,
// only owners change status, the Inbox can't be renamed or archived, and every edit carries the
// version it was based on. Archiving only changes the project's status: tasks, sections, comments,
// history and Knowledge references all stay, and restoring brings the project back as it was.
//
// Deliberately absent: deleting a project, members and sharing (turning a personal project into a
// shared one or back), moving tasks between projects. Deleting stays a deliberate act in the portal.
import { z } from "zod";
import { REVIEW_FREQUENCIES } from "../../src/shared/tasks/productivity";
import { COLORS, LIMITS, type TaskProject } from "../../src/shared/tasks/types";
import { requireObject } from "../knowledge/access";
import { can } from "../portal/auth";
import { HttpError } from "../portal/http";
import { ensureInbox, requireProject, todayFor } from "../tasks/access";
import { linkProjectKnowledge, projectKnowledgeReferences } from "../tasks/knowledge";
import { ProjectConflict, createProject, getProject, listProjects, replayedProject, sectionsFor, updateProject } from "../tasks/projects";
import { type ToolContext, type ToolDef, bounded, calendarDate, id, limit, requestId, tool } from "./shared";
import { projectOut } from "./tasks";

const projectId = id("tpj", "project");
const objectId = id("kob", "Knowledge object");
const name = z.string().trim().min(1).max(LIMITS.projectName);
const description = z.string().trim().max(LIMITS.projectDescription);
const version = z.number().int().min(1);
/** The statuses an MCP edit may set. Archiving and restoring have their own tools. */
const openStatus = z.enum(["active", "on_hold", "completed"]);

// --- Matching names ------------------------------------------------------------------------------

/** Case, accents' composed forms, punctuation and spacing don't make two names different. */
export const normaliseName = (value: string) =>
    value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

const FILLER = new Set(["the", "and", "for", "with", "our", "my", "project", "projects"]);
const words = (value: string) =>
    normaliseName(value)
        .split(" ")
        .filter((w) => w.length >= 3 && !FILLER.has(w));

export type NameMatch = "exact" | "similar" | "description";

/**
 * How well a project matches a name someone is looking for: the same name once normalised, a name
 * containing the other as whole words or sharing a significant word, or only its description
 * mentioning one of the words. Null when it doesn't match at all.
 */
export function matchProject(query: string, project: Pick<TaskProject, "name" | "description" | "isInbox">): NameMatch | null {
    const q = normaliseName(query);
    const n = normaliseName(project.isInbox ? "Inbox" : project.name);
    if (!q || !n) return null;
    if (q === n) return "exact";
    if (` ${n} `.includes(` ${q} `) || ` ${q} `.includes(` ${n} `)) return "similar";
    const wanted = words(query);
    const own = new Set(words(n));
    if (wanted.some((w) => own.has(w))) return "similar";
    const described = new Set(words(project.description));
    if (wanted.some((w) => described.has(w))) return "description";
    return null;
}

const RANK: Record<NameMatch, number> = { exact: 0, similar: 1, description: 2 };

/** The caller's projects matching a name, best first. Only projects they're a member of are ever considered. */
async function findProjects(ctx: ToolContext, query: string, includeArchived: boolean) {
    await ensureInbox(ctx.db, ctx.user.email);
    const projects = await listProjects(ctx.db, ctx.user.email, await todayFor(ctx.db, ctx.user.email));
    return projects
        .filter((p) => includeArchived || p.status !== "archived")
        .map((p) => ({ project: p, match: matchProject(query, p) }))
        .filter((m): m is { project: TaskProject; match: NameMatch } => m.match !== null)
        .sort((a, b) => RANK[a.match] - RANK[b.match] || Number(a.project.status === "archived") - Number(b.project.status === "archived"));
}

const matchOut = (ctx: ToolContext, m: { project: TaskProject; match: NameMatch }) => ({ ...projectOut(ctx, m.project), match: m.match });

/** The Inbox is made once per person by the portal itself; nothing else may be called that. */
const refuseReserved = (value: string) => {
    if (normaliseName(value) === "inbox")
        throw new HttpError(422, "validation", '"Inbox" is reserved for each person\'s own Inbox, which already exists. Choose another name.');
};

// --- Errors the gateway reports with detail -------------------------------------------------------

/** A project with the same name is already in the caller's projects. */
export class DuplicateProject extends HttpError {
    constructor(readonly matches: ReturnType<typeof matchOut>[]) {
        super(
            409,
            "duplicate",
            "A project with this name already exists. Reuse it (add tasks with its id), or, if the person confirms they want a separate project with the same name, retry with allowDuplicateName: true.",
        );
    }
}

/** The project changed since the version the client read. */
export class StaleProject extends HttpError {
    constructor(readonly current: { version: number; updatedAt: string; status: TaskProject["status"] } | null) {
        super(
            409,
            "conflict",
            "This project changed since you read it. Read it again (tasks_search_projects or tasks_project_summary) and retry with its current version.",
        );
    }
}

/** Runs a project write, turning a version conflict into one that carries the current version. */
async function guarded<T>(ctx: ToolContext, id: string, write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (error) {
        if (!(error instanceof ProjectConflict)) throw error;
        const now = await getProject(ctx.db, ctx.user, id, await todayFor(ctx.db, ctx.user.email)).catch(() => null);
        throw new StaleProject(now ? { version: now.version, updatedAt: now.updatedAt, status: now.status } : null);
    }
}

// --- Output --------------------------------------------------------------------------------------

/** One project as it is now, with what an AI client needs next: its sections (for tasks_create) and Knowledge references. */
async function projectDetail(ctx: ToolContext, id: string) {
    const project = await getProject(ctx.db, ctx.user, id, await todayFor(ctx.db, ctx.user.email));
    const [sections, knowledge] = await Promise.all([sectionsFor(ctx.db, ctx.user.email), projectKnowledgeReferences(ctx.db, ctx.user, id)]);
    return {
        project: {
            ...projectOut(ctx, project),
            description: project.description,
            color: project.color,
            defaultView: project.defaultView,
            reviewFrequency: project.reviewFrequency,
            updatedAt: project.updatedAt,
        },
        sections: (sections[id] ?? []).map((s) => ({ id: s.id, name: s.name })),
        knowledge: knowledge.map((k) =>
            k.available ? { available: true, objectId: k.objectId, title: k.title, spaceName: k.spaceName } : { available: false },
        ),
    };
}

const writtenProject = async (ctx: ToolContext, id: string, extra: Record<string, unknown> = {}) => ({
    data: { ...(await projectDetail(ctx, id)), ...extra },
    outcome: { entityType: "task_project" as const, entityId: id },
});

/** A retried write: the project as it is now. Membership is checked again by getProject. */
const replayProject = async (ctx: ToolContext, outcome: { entityId: string }) => ({
    data: { ...(await projectDetail(ctx, outcome.entityId)), replayed: true },
});

// --- Read ----------------------------------------------------------------------------------------

const tasksSearchProjects = tool({
    name: "tasks_search_projects",
    write: false,
    permission: "tasks.use",
    input: z
        .object({
            query: z.string().trim().min(1).max(LIMITS.projectName),
            includeArchived: z.boolean().default(true),
            limit: limit(20, 50),
        })
        .strict(),
    run: async (ctx, input) => {
        const found = await findProjects(ctx, input.query, input.includeArchived);
        const cut = bounded(found, input.limit);
        return {
            data: {
                query: input.query,
                exactMatch: found.some((m) => m.match === "exact"),
                projects: cut.items.map((m) => matchOut(ctx, m)),
                count: cut.count,
                truncated: cut.truncated,
            },
        };
    },
});

// --- Writes --------------------------------------------------------------------------------------

const tasksCreateProject = tool({
    name: "tasks_create_project",
    write: true,
    permission: "tasks.use",
    input: z
        .object({
            name,
            description: description.optional(),
            kind: z.enum(["personal", "shared"]).default("personal"),
            color: z.enum(COLORS).optional(),
            startDate: calendarDate.optional(),
            targetDate: calendarDate.optional(),
            defaultView: z.enum(["list", "board"]).optional(),
            sections: z.array(z.string().trim().min(1).max(LIMITS.sectionName)).max(20).optional(),
            knowledgeObjectIds: z.array(objectId).max(10).optional(),
            allowDuplicateName: z.boolean().default(false),
            requestId,
        })
        .strict(),
    run: async (ctx, { requestId, knowledgeObjectIds = [], allowDuplicateName, ...fields }) => {
        refuseReserved(fields.name);

        const objects = [...new Set(knowledgeObjectIds)];
        const link = async (projectId: string) => {
            // Linking is idempotent, so finishing a create that died part-way links only what's missing.
            const notLinked: string[] = [];
            for (const object of objects) {
                try {
                    await linkProjectKnowledge(ctx.db, ctx.user, projectId, { objectId: object });
                } catch {
                    notLinked.push(object);
                }
            }
            return notLinked.length ? { knowledgeNotLinked: notLinked } : {};
        };

        // A create whose ledger claim was lost part-way (the request died after writing) still made
        // its project once: give that one back, finished, rather than refusing it as a duplicate of itself.
        const earlier = await replayedProject(ctx.db, ctx.user, requestId);
        if (earlier) return writtenProject(ctx, earlier, { created: false, replayed: true, ...(await link(earlier)) });

        // Everything that could refuse is checked before anything is written, so a refusal never
        // leaves a half-made project behind.
        if (objects.length) {
            if (!can(ctx.user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge, so nothing can be linked.");
            for (const object of objects) {
                const row = await requireObject(ctx.db, ctx.user, object);
                if (row.status === "trashed") throw new HttpError(404, "not_found", "Not found");
            }
        }
        if (!allowDuplicateName) {
            const same = (await findProjects(ctx, fields.name, true)).filter((m) => m.match === "exact");
            if (same.length) throw new DuplicateProject(same.slice(0, 10).map((m) => matchOut(ctx, m)));
        }

        // The Tasks engine's own retry protection (clientId) backs up the ledger's.
        const { id, replayed } = await createProject(ctx.db, ctx.user, { ...fields, ...(requestId ? { clientId: requestId } : {}) });

        // Links are added after the project exists. Each was checked above; if one still fails (it
        // was trashed in between), the project stands and the result says which weren't linked.
        return writtenProject(ctx, id, { created: !replayed, replayed, ...(await link(id)) });
    },
    replay: replayProject,
});

const tasksUpdateProject = tool({
    name: "tasks_update_project",
    write: true,
    permission: "tasks.use",
    input: z
        .object({
            projectId,
            version,
            name: name.optional(),
            description: description.optional(),
            color: z.enum(COLORS).optional(),
            startDate: calendarDate.nullable().optional(),
            targetDate: calendarDate.nullable().optional(),
            defaultView: z.enum(["list", "board"]).optional(),
            reviewFrequency: z.enum(REVIEW_FREQUENCIES).optional(),
            status: openStatus.optional(),
            requestId,
        })
        .strict(),
    run: async (ctx, { projectId, requestId: _, ...changes }) => {
        if (changes.name !== undefined) refuseReserved(changes.name);
        const fields = Object.keys(changes).filter((k) => k !== "version");
        if (!fields.length) throw new HttpError(422, "validation", "Nothing to change: send at least one field.");
        if (changes.status !== undefined) {
            const project = await requireProject(ctx.db, ctx.user, projectId, "owner");
            if (project.status === "archived")
                throw new HttpError(422, "archived", "This project is archived. Restore it with tasks_unarchive_project, which can set its status too.");
        }
        await guarded(ctx, projectId, () => updateProject(ctx.db, ctx.user, projectId, changes));
        return writtenProject(ctx, projectId, { changed: fields });
    },
    replay: replayProject,
});

const tasksArchiveProject = tool({
    name: "tasks_archive_project",
    write: true,
    permission: "tasks.use",
    input: z.object({ projectId, version, requestId }).strict(),
    run: async (ctx, { projectId, version }) => {
        // Owners only, as in the portal; checked before the "already archived" answer too.
        const project = await requireProject(ctx.db, ctx.user, projectId, "owner");
        if (project.status === "archived") return writtenProject(ctx, projectId, { alreadyArchived: true });
        await guarded(ctx, projectId, () => updateProject(ctx.db, ctx.user, projectId, { version, status: "archived" }));
        return writtenProject(ctx, projectId, {
            archived: true,
            note: "Archived, not deleted: every task, section, comment, history entry and Knowledge reference is kept, read-only. tasks_unarchive_project restores it.",
        });
    },
    replay: replayProject,
});

const tasksUnarchiveProject = tool({
    name: "tasks_unarchive_project",
    write: true,
    permission: "tasks.use",
    input: z.object({ projectId, version, status: openStatus.default("active"), requestId }).strict(),
    run: async (ctx, { projectId, version, status }) => {
        const project = await requireProject(ctx.db, ctx.user, projectId, "owner");
        if (project.status !== "archived") return writtenProject(ctx, projectId, { alreadyRestored: true });
        await guarded(ctx, projectId, () => updateProject(ctx.db, ctx.user, projectId, { version, status }));
        return writtenProject(ctx, projectId, { restored: true });
    },
    replay: replayProject,
});

export const PROJECT_TOOLS: ToolDef[] = [tasksSearchProjects, tasksCreateProject, tasksUpdateProject, tasksArchiveProject, tasksUnarchiveProject];
