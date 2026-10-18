// Applies a DalyHub migration plan (src/shared/migration/dalyhub.ts) to the signed-in owner's own
// Daly Tasks and Daly Knowledge, and reverts it (docs/DALYHUB_MIGRATION.md).
//
// Three steps, all given the same plan:
//   preview: validates the plan and says what would be created, what was already imported and what
//            was imported then removed since. Writes nothing.
//   apply:   needs the fingerprint the preview returned, so the plan the owner looked at is the plan
//            that runs. Creates records through the ordinary Tasks and Knowledge services (so every
//            rule, history entry, audit row and search index applies) and records each one in
//            dalyhub_import_items. Bounded: at most APPLY_LIMIT records a request; call again with
//            the run id until done. Running the same plan again creates nothing twice.
//   revert:  removes, in reverse order, exactly the records a run created that nobody has touched
//            since (same version as when imported, nothing else added inside them). Knowledge
//            objects go to the Trash, so even those can be restored. Anything edited is kept and
//            reported. Preview first with dryRun.
//
// Everything is created as personal records of the person running it: nothing is shared, and no
// other person's data is read or changed. The plan itself is never stored.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { paragraphsFromText } from "../../src/shared/knowledge/content";
import { PLAN_FORMAT, PLAN_LIMITS } from "../../src/shared/migration/dalyhub";
import type { PortalUser } from "../../src/shared/portal/types";
import { ensurePersonalSpace } from "../knowledge/access";
import { changeStatus, createObject } from "../knowledge/objects";
import { listTypes } from "../knowledge/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { ensureInbox } from "../tasks/access";
import { createGoal, deleteGoal } from "../tasks/goals";
import { linkProjectKnowledge, unlinkProjectKnowledge } from "../tasks/knowledge";
import { createProject, deleteProject } from "../tasks/projects";
import { createTask, deleteTask } from "../tasks/tasks";

/** Records created per apply request (each is several D1 queries). */
export const APPLY_LIMIT = 40;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sourceId = z.string().min(1).max(128);
const label = z.string().min(1).max(60);

export const planSchema = z
    .object({
        format: z.literal(PLAN_FORMAT),
        createdAt: z.string().max(40),
        source: z.object({ workspaceId: z.string().max(128).nullable(), exportedAt: z.string().max(40).nullable() }).strict(),
        options: z.object({ includeCompleted: z.boolean(), includeArchived: z.boolean() }).strict(),
        projects: z
            .array(z.object({ sourceId, name: z.string().trim().min(1).max(120), description: z.string().max(2_000) }).strict())
            .max(PLAN_LIMITS.projects),
        goals: z
            .array(
                z
                    .object({
                        sourceId,
                        title: z.string().trim().min(1).max(200),
                        description: z.string().max(2_000),
                        targetDate: date.nullable(),
                        projectSourceIds: z.array(sourceId).max(10),
                    })
                    .strict(),
            )
            .max(PLAN_LIMITS.goals),
        tasks: z
            .array(
                z
                    .object({
                        sourceId,
                        projectSourceId: sourceId.nullable(),
                        parentSourceId: sourceId.nullable(),
                        title: z.string().trim().min(1).max(500),
                        description: z.string().max(10_000),
                        priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
                        dueDate: date.nullable(),
                        deadline: date.nullable(),
                        labels: z.array(label).max(20),
                    })
                    .strict(),
            )
            .max(PLAN_LIMITS.tasks),
        knowledge: z
            .array(
                z
                    .object({
                        sourceId,
                        type: z.enum(["page", "area", "decision", "meeting"]),
                        title: z.string().trim().min(1).max(300),
                        text: z.string().max(20_000),
                        tags: z.array(z.string().min(1).max(50)).max(30),
                        properties: z.record(z.string().max(40), z.string().max(40)),
                        projectSourceId: sourceId.nullable(),
                    })
                    .strict(),
            )
            .max(PLAN_LIMITS.knowledge),
        skipped: z.array(z.object({ category: z.string().max(80), count: z.number().int().min(0), reason: z.string().max(400) }).strict()).max(200),
        warnings: z.array(z.string().max(400)).max(500),
    })
    .strict()
    .superRefine((plan, ctx) => {
        const projects = new Set(plan.projects.map((p) => p.sourceId));
        const tasks = new Map(plan.tasks.map((t, i) => [t.sourceId, i]));
        for (const list of [plan.projects, plan.goals, plan.tasks, plan.knowledge] as { sourceId: string }[][]) {
            if (new Set(list.map((x) => x.sourceId)).size !== list.length) ctx.addIssue({ code: "custom", message: "A record appears twice in the plan" });
        }
        plan.tasks.forEach((t, i) => {
            if (t.projectSourceId && !projects.has(t.projectSourceId))
                ctx.addIssue({ code: "custom", path: ["tasks", i], message: "Names a project the plan doesn't create" });
            const parent = t.parentSourceId ? tasks.get(t.parentSourceId) : undefined;
            if (t.parentSourceId && (parent === undefined || parent >= i || plan.tasks[parent].parentSourceId))
                ctx.addIssue({ code: "custom", path: ["tasks", i], message: "A subtask must come after its parent, one level deep" });
        });
        for (const g of plan.goals)
            for (const p of g.projectSourceIds)
                if (!projects.has(p)) ctx.addIssue({ code: "custom", message: "A goal names a project the plan doesn't create" });
        for (const k of plan.knowledge)
            if (k.projectSourceId && !projects.has(k.projectSourceId))
                ctx.addIssue({ code: "custom", message: "A Knowledge object names a project the plan doesn't create" });
    });

export type Plan = z.output<typeof planSchema>;
type Kind = "project" | "goal" | "task" | "knowledge_object" | "project_knowledge_link";

interface Item {
    kind: Kind;
    source_id: string;
    target_id: string;
    run_id: string;
    imported_version: number | null;
    state: "imported" | "reverted";
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const planFingerprint = async (plan: Plan) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(plan))));

/** Only a portal owner who can use both applications may migrate, and only into their own records. */
function requireMigrator(user: PortalUser) {
    if (user.role !== "owner" || !user.permissions.includes("tasks.use") || !user.permissions.includes("knowledge.use"))
        throw new HttpError(403, "forbidden", "Only a portal owner can migrate DalyHub data");
}

async function existing(db: D1Database, email: string): Promise<Map<string, Item>> {
    const rows = await db
        .prepare("SELECT kind, source_id, target_id, run_id, imported_version, state FROM dalyhub_import_items WHERE owner_email = ?")
        .bind(email)
        .all<Item>();
    return new Map(rows.results.map((r) => [`${r.kind}:${r.source_id}`, r]));
}

const TARGET_TABLE: Record<Exclude<Kind, "project_knowledge_link">, string> = {
    project: "task_projects",
    goal: "task_goals",
    task: "task_items",
    knowledge_object: "knowledge_objects",
};

/** The current version of a target record, or null if it no longer exists (or is trashed). */
async function currentVersion(db: D1Database, kind: Kind, id: string): Promise<number | null> {
    if (kind === "project_knowledge_link") {
        const row = await db.prepare("SELECT 1 AS v FROM task_project_knowledge_links WHERE id = ?").bind(id).first<{ v: number }>();
        return row ? 1 : null;
    }
    const trashed = kind === "knowledge_object" ? " AND status <> 'trashed'" : "";
    const row = await db.prepare(`SELECT version FROM ${TARGET_TABLE[kind]} WHERE id = ?${trashed}`).bind(id).first<{ version: number }>();
    return row?.version ?? null;
}

/** Every record the plan creates, in the order they must be created. */
function steps(plan: Plan): { kind: Kind; sourceId: string; title: string }[] {
    return [
        ...plan.projects.map((p) => ({ kind: "project" as const, sourceId: p.sourceId, title: p.name })),
        ...plan.goals.map((g) => ({ kind: "goal" as const, sourceId: g.sourceId, title: g.title })),
        ...plan.knowledge.map((k) => ({ kind: "knowledge_object" as const, sourceId: k.sourceId, title: k.title })),
        ...plan.tasks.map((t) => ({ kind: "task" as const, sourceId: t.sourceId, title: t.title })),
        ...plan.knowledge.filter((k) => k.projectSourceId).map((k) => ({ kind: "project_knowledge_link" as const, sourceId: k.sourceId, title: k.title })),
    ];
}

export async function previewMigration(db: D1Database, user: PortalUser, input: unknown) {
    requireMigrator(user);
    const plan = planSchema.parse((input as { plan?: unknown })?.plan);
    const done = await existing(db, user.email);
    const counts = { create: 0, alreadyImported: 0, removedSinceImport: 0 };
    const removed: { kind: Kind; title: string }[] = [];
    for (const step of steps(plan)) {
        const item = done.get(`${step.kind}:${step.sourceId}`);
        if (!item) counts.create += 1;
        else if (item.state === "imported" && (await currentVersion(db, step.kind, item.target_id)) !== null) counts.alreadyImported += 1;
        else {
            counts.removedSinceImport += 1;
            if (removed.length < 50) removed.push({ kind: step.kind, title: step.title });
        }
    }
    return {
        fingerprint: await planFingerprint(plan),
        counts,
        // Records imported before and removed since stay removed: the migration never recreates them.
        removedSinceImport: removed,
        creates: {
            projects: plan.projects.length,
            goals: plan.goals.length,
            tasks: plan.tasks.filter((t) => !t.parentSourceId).length,
            subtasks: plan.tasks.filter((t) => t.parentSourceId).length,
            knowledge: plan.knowledge.length,
        },
        skipped: plan.skipped,
        warnings: plan.warnings,
    };
}

const applyInput = z
    .object({
        plan: z.unknown(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        runId: z
            .string()
            .regex(/^dhr_[a-z0-9]{14}$/)
            .optional(),
    })
    .strict();

export async function applyMigration(db: D1Database, user: PortalUser, input: unknown) {
    requireMigrator(user);
    const body = applyInput.parse(input);
    const plan = planSchema.parse(body.plan);
    const fingerprint = await planFingerprint(plan);
    if (fingerprint !== body.fingerprint) throw new HttpError(409, "plan_changed", "This isn't the plan you previewed. Preview it again.");

    let runId = body.runId;
    if (runId) {
        const run = await db
            .prepare("SELECT plan_fingerprint, status FROM dalyhub_import_runs WHERE id = ? AND owner_email = ?")
            .bind(runId, user.email)
            .first<{ plan_fingerprint: string; status: string }>();
        if (!run) throw new HttpError(404, "not_found", "Not found");
        if (run.plan_fingerprint !== fingerprint) throw new HttpError(409, "plan_changed", "That run was for a different plan");
        if (run.status === "reverted") throw new HttpError(409, "reverted", "That run was reverted. Preview the plan again to start a new run.");
    } else {
        runId = newId("dhr");
        await db
            .prepare("INSERT INTO dalyhub_import_runs (id, owner_email, plan_fingerprint, status, created_at) VALUES (?, ?, ?, 'running', ?)")
            .bind(runId, user.email, fingerprint, nowIso())
            .run();
    }

    await ensurePersonalSpace(db, user);
    const space = await db.prepare("SELECT id FROM knowledge_spaces WHERE kind = 'personal' AND personal_owner = ?").bind(user.email).first<{ id: string }>();
    const types = new Map((await listTypes(db, space!.id)).map((t) => [t.slug, t.id]));
    const inbox = await ensureInbox(db, user.email);
    const done = await existing(db, user.email);
    const target = (kind: Kind, source: string) => done.get(`${kind}:${source}`)?.target_id ?? null;
    const record = async (kind: Kind, source: string, targetId: string, version: number | null) => {
        await db
            .prepare(
                `INSERT INTO dalyhub_import_items (owner_email, kind, source_id, target_id, run_id, imported_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(user.email, kind, source, targetId, runId, version, nowIso())
            .run();
        done.set(`${kind}:${source}`, { kind, source_id: source, target_id: targetId, run_id: runId!, imported_version: version, state: "imported" });
    };

    let created = 0;
    try {
        for (const step of steps(plan)) {
            if (done.has(`${step.kind}:${step.sourceId}`)) continue;
            if (created >= APPLY_LIMIT) break;
            if (step.kind === "project") {
                const p = plan.projects.find((x) => x.sourceId === step.sourceId)!;
                await record("project", p.sourceId, (await createProject(db, user, { name: p.name, description: p.description })).id, 1);
            } else if (step.kind === "goal") {
                const g = plan.goals.find((x) => x.sourceId === step.sourceId)!;
                const projectIds = g.projectSourceIds.map((s) => target("project", s)).filter((x): x is string => !!x);
                await record(
                    "goal",
                    g.sourceId,
                    await createGoal(db, user, { title: g.title, description: g.description, targetDate: g.targetDate, projectIds }),
                    1,
                );
            } else if (step.kind === "knowledge_object") {
                const k = plan.knowledge.find((x) => x.sourceId === step.sourceId)!;
                const detail = await createObject(db, user, space!.id, {
                    ...(types.get(k.type) ? { typeId: types.get(k.type) } : {}),
                    title: k.title,
                    // Plain paragraphs: DalyHub's Markdown is kept as literal text, never parsed as markup.
                    content: { type: "doc", content: k.text ? paragraphsFromText(k.text) : [] },
                    properties: types.get(k.type) ? k.properties : {},
                    tags: k.tags,
                });
                await record("knowledge_object", k.sourceId, detail.object.id, detail.object.version);
            } else if (step.kind === "task") {
                const t = plan.tasks.find((x) => x.sourceId === step.sourceId)!;
                const projectId = t.projectSourceId ? target("project", t.projectSourceId) : inbox;
                const parentId = t.parentSourceId ? target("task", t.parentSourceId) : null;
                if (!projectId || (t.parentSourceId && !parentId)) continue; // its project or parent was removed since: left out
                const { task } = await createTask(db, user, {
                    title: t.title,
                    description: t.description,
                    projectId,
                    ...(parentId ? { parentId } : {}),
                    priority: t.priority,
                    dueDate: t.dueDate,
                    deadline: t.deadline,
                    labels: t.labels,
                    // The Tasks engine's own replay guard, so a run cut off between the task and its
                    // provenance row can't create the task twice when resumed.
                    clientId: `dalyhub-${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t.sourceId))).slice(0, 40)}`,
                });
                await record("task", t.sourceId, task.id, task.version);
            } else {
                const k = plan.knowledge.find((x) => x.sourceId === step.sourceId)!;
                const projectId = target("project", k.projectSourceId!);
                const objectId = target("knowledge_object", k.sourceId);
                if (!projectId || !objectId) continue;
                await linkProjectKnowledge(db, user, projectId, { objectId });
                const link = await db
                    .prepare("SELECT id FROM task_project_knowledge_links WHERE project_id = ? AND object_id = ?")
                    .bind(projectId, objectId)
                    .first<{ id: string }>();
                if (link) await record("project_knowledge_link", k.sourceId, link.id, null);
            }
            created += 1;
        }
    } catch (error) {
        await db.prepare("UPDATE dalyhub_import_runs SET status = 'failed', finished_at = ? WHERE id = ?").bind(nowIso(), runId).run();
        console.error(JSON.stringify({ event: "dalyhub_import_failed", runId, error: (error as Error)?.name }));
        throw error;
    }

    const remaining = steps(plan).filter((s) => !done.has(`${s.kind}:${s.sourceId}`)).length;
    const finished = remaining === 0 || created === 0;
    const summary = { created, remaining };
    await db
        .prepare("UPDATE dalyhub_import_runs SET status = ?, summary_json = ?, finished_at = ? WHERE id = ?")
        .bind(finished ? "completed" : "running", JSON.stringify(summary), finished ? nowIso() : null, runId)
        .run();
    return { runId, done: finished, ...summary };
}

const revertInput = z.object({ dryRun: z.boolean().default(true) }).strict();

const REVERT_ORDER: Kind[] = ["project_knowledge_link", "task", "knowledge_object", "goal", "project"];

export async function revertMigration(db: D1Database, user: PortalUser, runId: string, input: unknown) {
    requireMigrator(user);
    const { dryRun } = revertInput.parse(input ?? {});
    const run = await db.prepare("SELECT status FROM dalyhub_import_runs WHERE id = ? AND owner_email = ?").bind(runId, user.email).first<{ status: string }>();
    if (!run) throw new HttpError(404, "not_found", "Not found");
    const items = (
        await db
            .prepare(
                "SELECT kind, source_id, target_id, run_id, imported_version, state FROM dalyhub_import_items WHERE run_id = ? AND owner_email = ? AND state = 'imported'",
            )
            .bind(runId, user.email)
            .all<Item>()
    ).results;
    const ours = new Set(items.map((i) => i.target_id));
    const result = { removed: 0, alreadyGone: 0, kept: [] as { kind: Kind; id: string; reason: string }[] };
    const keep = (item: Item, reason: string) => result.kept.length < 200 && result.kept.push({ kind: item.kind, id: item.target_id, reason });
    const gone = new Set<string>();

    // Subtasks before their parents, so deleting a parent never takes an unchecked child with it.
    const tasks = items.filter((i) => i.kind === "task");
    const depth = new Map<string, number>();
    for (const t of tasks) {
        const row = await db.prepare("SELECT depth FROM task_items WHERE id = ?").bind(t.target_id).first<{ depth: number }>();
        depth.set(t.target_id, row?.depth ?? 0);
    }
    const ordered = REVERT_ORDER.flatMap((kind) =>
        kind === "task" ? [...tasks].sort((a, b) => (depth.get(b.target_id) ?? 0) - (depth.get(a.target_id) ?? 0)) : items.filter((i) => i.kind === kind),
    );

    for (const item of ordered) {
        const version = await currentVersion(db, item.kind, item.target_id);
        if (version === null) {
            result.alreadyGone += 1;
            if (!dryRun) await markReverted(db, user.email, item);
            continue;
        }
        if (item.imported_version !== null && version !== item.imported_version) {
            keep(item, "Changed since it was imported");
            continue;
        }
        if (item.kind === "task") {
            const children = await db.prepare("SELECT id FROM task_items WHERE parent_id = ?").bind(item.target_id).all<{ id: string }>();
            const comments = await db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?").bind(item.target_id).first<{ n: number }>();
            if ((comments?.n ?? 0) > 0 || children.results.some((r) => !(ours.has(r.id) && gone.has(r.id)))) {
                keep(item, "Has subtasks or comments added since");
                continue;
            }
        }
        if (item.kind === "project" || item.kind === "goal") {
            const inside =
                item.kind === "project"
                    ? await db.prepare("SELECT id FROM task_items WHERE project_id = ?").bind(item.target_id).all<{ id: string }>()
                    : { results: [] as { id: string }[] };
            if (inside.results.some((r) => !gone.has(r.id))) {
                keep(item, "Holds tasks that weren't imported, or were changed since");
                continue;
            }
        }
        if (!dryRun) {
            if (item.kind === "project_knowledge_link") {
                const link = await db
                    .prepare("SELECT project_id FROM task_project_knowledge_links WHERE id = ?")
                    .bind(item.target_id)
                    .first<{ project_id: string }>();
                if (link) await unlinkProjectKnowledge(db, user, link.project_id, item.target_id);
            } else if (item.kind === "task") await deleteTask(db, user, item.target_id);
            else if (item.kind === "knowledge_object") await changeStatus(db, user, item.target_id, "trash");
            else if (item.kind === "goal") await deleteGoal(db, user, item.target_id, { confirm: "DELETE" });
            else await deleteProject(db, user, item.target_id, { confirm: "DELETE" });
            await markReverted(db, user.email, item);
        }
        gone.add(item.target_id);
        result.removed += 1;
    }

    if (!dryRun) {
        const allGone = result.kept.length === 0;
        await db
            .prepare("UPDATE dalyhub_import_runs SET status = CASE WHEN ? THEN 'reverted' ELSE status END, reverted_at = ? WHERE id = ?")
            .bind(allGone ? 1 : 0, nowIso(), runId)
            .run();
    }
    return { runId, dryRun, ...result };
}

const markReverted = (db: D1Database, email: string, item: Item) =>
    db
        .prepare("UPDATE dalyhub_import_items SET state = 'reverted' WHERE owner_email = ? AND kind = ? AND source_id = ?")
        .bind(email, item.kind, item.source_id)
        .run();

export async function listMigrationRuns(db: D1Database, user: PortalUser) {
    requireMigrator(user);
    const rows = await db
        .prepare(
            "SELECT id, status, summary_json, created_at, finished_at, reverted_at FROM dalyhub_import_runs WHERE owner_email = ? ORDER BY created_at DESC LIMIT 20",
        )
        .bind(user.email)
        .all<{ id: string; status: string; summary_json: string | null; created_at: string; finished_at: string | null; reverted_at: string | null }>();
    return rows.results.map((r) => ({ ...r, summary: r.summary_json ? JSON.parse(r.summary_json) : null, summary_json: undefined }));
}
