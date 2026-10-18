// Importing from Todoist's CSV export (src/shared/tasks/todoist.ts reads the files).
//
// Two steps, both given the same files and options: preview (nothing is written) and run.
//
// Where things go. Each exported project becomes a new personal project of the person importing,
// unless they map it to an existing project they can edit (the preview points out a project of
// theirs with the same name). Nothing is ever made shared by an import.
//
// Importing again (idempotency). Every project, section, task and comment that's imported is
// recorded in task_import_items with a key derived from its place in the export (see importKeys),
// so the same file, or a newer export of the same project, finds what was imported before:
//   * unchanged in Todoist: left alone;
//   * changed in Todoist, untouched in Daly Tasks since the import: updated if the person chose
//     "update", otherwise left alone;
//   * changed in both: never overwritten; reported as a conflict;
//   * deleted in Daly Tasks since: stays deleted (reported).
// A task not imported before that has the same title as an open task already in the same place
// (same project and parent) is a possible duplicate: by default it's linked to that task instead
// of copied; the person can choose to import it anyway.
//
// Bounded, resumable runs. A run writes at most RUN_LIMIT tasks, each task with its labels,
// comments and record in the same atomic D1 batch. The browser calls again (with the batch id)
// until it's done. If a run stops part-way, everything before the failing batch is saved and
// recorded, so running the import again carries on where it stopped without duplicating anything.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { describeRule, recurrenceInput, withAnchor } from "../../src/shared/tasks/recurrence";
import {
    IMPORT_LIMITS,
    ImportFormatError,
    type ImportedProject,
    type ImportedTask,
    type PriorityScale,
    fileFingerprint,
    importKeys,
    parseTodoistCsv,
} from "../../src/shared/tasks/todoist";
import { chunk, newId, nowIso, parseJson, placeholders } from "../portal/db";
import { HttpError } from "../portal/http";
import { requireProject, requireWritable, todayFor } from "./access";
import { activity } from "./activity";
import { labelStatements, normaliseLabels, resolveSchedule } from "./tasks";

const SOURCE = "todoist";
/** Tasks written per request. */
export const RUN_LIMIT = 250;
/** Statements per D1 batch (each batch is atomic). */
const BATCH_STATEMENTS = 90;

const tpj = z.string().regex(/^tpj_[a-z0-9]{14}$/, "Not a valid project");
export const importInput = z
    .object({
        files: z
            .array(z.object({ name: z.string().trim().min(1).max(200), text: z.string() }).strict())
            .min(1, "Choose a file")
            .max(IMPORT_LIMITS.files, `At most ${IMPORT_LIMITS.files} files at once`),
        options: z
            .object({
                priorityScale: z.enum(["one_is_highest", "four_is_highest"]).default("one_is_highest"),
                /** Per exported project (by its key): "new" for a new personal project, or an existing project's id. */
                destinations: z.record(z.string().regex(/^[0-9a-f]{40}$/), z.union([z.literal("new"), tpj])).default({}),
                duplicates: z.enum(["link", "import"]).default("link"),
                changed: z.enum(["keep", "update"]).default("keep"),
            })
            .strict()
            .default({ priorityScale: "one_is_highest", destinations: {}, duplicates: "link", changed: "keep" }),
        batchId: z
            .string()
            .regex(/^tib_[a-z0-9]{14}$/)
            .optional(),
    })
    .strict();
type ImportInput = z.output<typeof importInput>;

export type TaskStatus = "new" | "unchanged" | "update" | "conflict" | "deleted" | "duplicate" | "import_duplicate";

interface Provenance {
    target_id: string;
    imported_version: number | null;
    content_hash: string;
}

interface PlannedProject {
    data: ImportedProject;
    keys: Awaited<ReturnType<typeof importKeys>>;
    destination: { kind: "new" } | { kind: "existing"; projectId: string; name: string; imported: boolean };
    sameName: { id: string; name: string } | null;
    status: TaskStatus[];
    /** For tasks already matched: the Daly task it corresponds to, and its version now. */
    targets: (string | null)[];
    versions: (number | null)[];
}

const invalid = (message: string) => new HttpError(422, "validation", message);

async function loadProvenance(db: D1Database, email: string) {
    const rows = await db
        .prepare("SELECT kind, source_key, target_id, imported_version, content_hash FROM task_import_items WHERE owner_email = ? AND source = ?")
        .bind(email, SOURCE)
        .all<Provenance & { kind: string; source_key: string }>();
    return new Map(rows.results.map((r) => [`${r.kind}:${r.source_key}`, r]));
}

/** Tasks the caller can still see, with their versions and parents. */
async function visibleTasks(db: D1Database, email: string, ids: string[]) {
    const out = new Map<string, { version: number; project_id: string }>();
    for (const part of chunk([...new Set(ids)], 50)) {
        const rows = await db
            .prepare(
                `SELECT t.id, t.version, t.project_id FROM task_items t JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?
                 WHERE t.id IN (${placeholders(part.length)})`,
            )
            .bind(email, ...part)
            .all<{ id: string; version: number; project_id: string }>();
        for (const r of rows.results) out.set(r.id, r);
    }
    return out;
}

/** Reads the files and works out what would happen to every item. Writes nothing. */
async function plan(db: D1Database, user: PortalUser, body: ImportInput): Promise<PlannedProject[]> {
    const today = await todayFor(db, user.email);
    const projects: PlannedProject[] = [];
    let total = 0;
    for (const file of body.files) {
        if (!/\.csv$/i.test(file.name)) throw invalid(`${file.name}: only CSV files from Todoist can be imported (unzip a backup first, or choose the zip)`);
        let data: ImportedProject;
        try {
            data = parseTodoistCsv(file.name, file.text, { today, priorityScale: body.options.priorityScale as PriorityScale });
        } catch (error) {
            if (error instanceof ImportFormatError) throw invalid(error.message);
            throw error;
        }
        total += data.tasks.length;
        if (total > IMPORT_LIMITS.tasks)
            throw invalid(`At most ${IMPORT_LIMITS.tasks.toLocaleString()} tasks in one import; import the projects in smaller groups`);
        const keys = await importKeys(data);
        if (projects.some((p) => p.keys.projectKey === keys.projectKey)) throw invalid(`Two files are the same Todoist project (${data.name}); choose one`);
        projects.push({ data, keys, destination: { kind: "new" }, sameName: null, status: [], targets: [], versions: [] });
    }

    const provenance = await loadProvenance(db, user.email);
    const own = await db
        .prepare(
            `SELECT p.id, p.name, m.role, p.status FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ?
             WHERE p.status <> 'archived' LIMIT 1000`,
        )
        .bind(user.email)
        .all<{ id: string; name: string; role: string; status: string }>();
    const editable = new Map(own.results.filter((p) => p.role !== "viewer").map((p) => [p.id, p]));
    const known = await visibleTasks(
        db,
        user.email,
        [...provenance.values()].map((p) => p.target_id),
    );

    for (const p of projects) {
        const chosen = body.options.destinations[p.keys.projectKey];
        const before = provenance.get(`project:${p.keys.projectKey}`);
        if (chosen && chosen !== "new") {
            // Checked like any write: an editor of a project that isn't archived, or 404.
            const project = await requireProject(db, user, chosen, "editor");
            requireWritable(project);
            p.destination = { kind: "existing", projectId: project.id, name: project.name, imported: before?.target_id === project.id };
        } else if (before && editable.has(before.target_id) && chosen !== "new") {
            p.destination = { kind: "existing", projectId: before.target_id, name: editable.get(before.target_id)!.name, imported: true };
        }
        if (p.destination.kind === "new") {
            const same = own.results.find((o) => o.role !== "viewer" && o.name.toLowerCase() === p.data.name.toLowerCase());
            p.sameName = same ? { id: same.id, name: same.name } : null;
        }

        // Open tasks already in the destination, for possible duplicates: (parent, title) → id.
        const existing = new Map<string, { id: string; version: number }>();
        if (p.destination.kind === "existing") {
            const rows = await db
                .prepare("SELECT id, parent_id, title, version FROM task_items WHERE project_id = ? AND status = 'open' LIMIT 5000")
                .bind(p.destination.projectId)
                .all<{ id: string; parent_id: string | null; title: string; version: number }>();
            for (const r of rows.results) existing.set(`${r.parent_id ?? ""}|${r.title.toLowerCase()}`, { id: r.id, version: r.version });
        }
        p.data.tasks.forEach((t, i) => {
            const key = p.keys.taskKeys[i];
            const prov = provenance.get(`task:${key}`);
            const parentTarget = t.parent === null ? null : p.targets[t.parent];
            if (prov) {
                const now = known.get(prov.target_id);
                p.targets[i] = now ? prov.target_id : null;
                p.versions[i] = now?.version ?? null;
                if (!now) p.status[i] = "deleted";
                else if (prov.content_hash === p.keys.hashes[i]) p.status[i] = "unchanged";
                else if (now.version !== prov.imported_version) p.status[i] = "conflict";
                else p.status[i] = body.options.changed === "update" ? "update" : "unchanged";
                return;
            }
            // A new parent means its subtasks can't be duplicates of anything.
            const match = t.parent !== null && !parentTarget ? undefined : existing.get(`${parentTarget ?? ""}|${t.title.toLowerCase()}`);
            if (match) {
                p.status[i] = body.options.duplicates === "link" ? "duplicate" : "import_duplicate";
                p.targets[i] = body.options.duplicates === "link" ? match.id : null;
                p.versions[i] = body.options.duplicates === "link" ? match.version : null;
            } else {
                p.status[i] = "new";
                p.targets[i] = null;
            }
        });
    }
    return projects;
}

const counts = (statuses: TaskStatus[]) => {
    const out: Record<TaskStatus, number> = { new: 0, unchanged: 0, update: 0, conflict: 0, deleted: 0, duplicate: 0, import_duplicate: 0 };
    for (const s of statuses) out[s]++;
    return out;
};

const describeDate = (t: ImportedTask) => {
    if (t.recurrence) {
        const rule = recurrenceInput.safeParse(t.recurrence);
        return rule.success && t.dueDate ? describeRule(withAnchor(rule.data, t.dueDate)) : t.dateText;
    }
    return t.dueDate ? `${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ""}` : null;
};

/** What the preview shows: per project, where it goes, counts by outcome, warnings and a sample of tasks. */
export async function previewImport(db: D1Database, user: PortalUser, input: unknown) {
    const body = importInput.parse(input);
    const projects = await plan(db, user, body);
    const fingerprint = await fileFingerprint(body.files);
    const earlier = await db
        .prepare(
            "SELECT created_at FROM task_import_batches WHERE owner_email = ? AND file_fingerprint = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(user.email, fingerprint)
        .first<{ created_at: string }>();
    return {
        fingerprint,
        importedBefore: earlier?.created_at ?? null,
        projects: projects.map((p) => ({
            key: p.keys.projectKey,
            file: p.data.file,
            name: p.data.name,
            board: p.data.board,
            destination: p.destination,
            sameName: p.sameName,
            sections: p.data.sections.map((s) => s.name),
            taskCount: p.data.tasks.length,
            subtaskCount: p.data.tasks.filter((t) => t.depth > 0).length,
            commentCount: p.data.tasks.reduce((n, t) => n + t.comments.length, 0),
            repeating: p.data.tasks.filter((t) => t.recurrence).length,
            labels: [...new Set(p.data.tasks.flatMap((t) => t.labels))].slice(0, 50),
            counts: counts(p.status),
            unsupported: p.data.unsupported,
            priorityValues: p.data.priorityValues,
            warnings: p.data.warnings.slice(0, 100),
            sample: p.data.tasks.slice(0, 60).map((t, i) => ({
                title: t.title,
                depth: t.depth,
                section: t.section === null ? null : p.data.sections[t.section].name,
                priority: t.priority,
                due: describeDate(t),
                deadline: t.deadline,
                labels: t.labels,
                status: p.status[i],
            })),
        })),
        notImported: [
            "Completed tasks (Todoist leaves them out of CSV exports)",
            "Creation and completion times, and Todoist's own ids",
            "Assignees and authors, durations, reminders and attachments",
            "The start date of repeating tasks (Todoist drops it): each starts from its next occurrence",
        ],
    };
}

interface Summary {
    projectsCreated: number;
    sectionsCreated: number;
    tasksCreated: number;
    tasksUpdated: number;
    linkedDuplicates: number;
    unchanged: number;
    conflicts: number;
    deleted: number;
    comments: number;
    warnings: string[];
    error?: string;
}
const emptySummary = (): Summary => ({
    projectsCreated: 0,
    sectionsCreated: 0,
    tasksCreated: 0,
    tasksUpdated: 0,
    linkedDuplicates: 0,
    unchanged: 0,
    conflicts: 0,
    deleted: 0,
    comments: 0,
    warnings: [],
});

const provenanceStatement = (
    db: D1Database,
    email: string,
    kind: string,
    key: string,
    target: string,
    batchId: string,
    version: number | null,
    hash: string,
    now: string,
) =>
    db
        .prepare(
            `INSERT INTO task_import_items (owner_email, source, kind, source_key, target_id, batch_id, imported_version, content_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner_email, source, kind, source_key) DO UPDATE SET target_id = excluded.target_id, batch_id = excluded.batch_id,
                imported_version = excluded.imported_version, content_hash = excluded.content_hash`,
        )
        .bind(email, SOURCE, kind, key, target, batchId, version, hash, now);

/**
 * Runs (or continues) an import. Returns done: false while there's more to write; the browser then
 * calls again with the same files, options and batch id.
 */
export async function runImport(db: D1Database, user: PortalUser, input: unknown) {
    const body = importInput.parse(input);
    const fingerprint = await fileFingerprint(body.files);
    const now = nowIso();
    let batchId = body.batchId;
    let summary = emptySummary();
    if (batchId) {
        const batch = await db
            .prepare("SELECT status, file_fingerprint, summary_json FROM task_import_batches WHERE id = ? AND owner_email = ?")
            .bind(batchId, user.email)
            .first<{ status: string; file_fingerprint: string; summary_json: string | null }>();
        if (!batch) throw new HttpError(404, "not_found", "Not found");
        if (batch.file_fingerprint !== fingerprint) throw invalid("Those aren't the files this import started with");
        if (batch.status === "completed") return { batchId, done: true, summary: parseJson<Summary>(batch.summary_json, emptySummary()) };
        summary = { ...summary, ...parseJson<Summary>(batch.summary_json, emptySummary()), error: undefined };
        await db.prepare("UPDATE task_import_batches SET status = 'running' WHERE id = ?").bind(batchId).run();
    } else {
        batchId = newId("tib");
        await db
            .prepare(
                "INSERT INTO task_import_batches (id, owner_email, source, file_fingerprint, status, options_json, created_at) VALUES (?, ?, 'todoist_csv', ?, 'running', ?, ?)",
            )
            .bind(batchId, user.email, fingerprint, JSON.stringify(body.options), now)
            .run();
    }
    const save = (status: "running" | "completed" | "failed") =>
        db
            .prepare("UPDATE task_import_batches SET status = ?, summary_json = ?, finished_at = CASE WHEN ? = 'running' THEN NULL ELSE ? END WHERE id = ?")
            .bind(status, JSON.stringify({ ...summary, warnings: summary.warnings.slice(0, 200) }), status, nowIso(), batchId)
            .run();

    try {
        const projects = await plan(db, user, body);
        const today = await todayFor(db, user.email);
        let written = 0;
        let done = true;
        for (const p of projects) {
            if (written >= RUN_LIMIT) {
                done = false;
                break;
            }
            const result = await importProject(db, user, p, batchId, today, summary, RUN_LIMIT - written);
            written += result.written;
            if (!result.done) {
                done = false;
                break;
            }
        }
        if (done) {
            // Warnings once, at the end, from the files themselves.
            for (const p of projects) summary.warnings.push(...p.data.warnings.map((w) => `${p.data.name}: ${w}`));
            for (const p of projects) {
                summary.unchanged += p.status.filter((s) => s === "unchanged").length;
                summary.conflicts += p.status.filter((s) => s === "conflict").length;
                summary.deleted += p.status.filter((s) => s === "deleted").length;
            }
        }
        await save(done ? "completed" : "running");
        return { batchId, done, summary };
    } catch (error) {
        // What's been written so far is saved and recorded; running it again continues from here.
        summary.error = error instanceof HttpError ? error.message : "The import stopped part-way. Run it again to continue where it stopped.";
        await save("failed");
        console.error(JSON.stringify({ event: "task_import_failed", batchId, message: (error as Error).message.slice(0, 200) }));
        throw error instanceof HttpError ? error : new HttpError(500, "import_failed", summary.error);
    }
}

async function importProject(db: D1Database, user: PortalUser, p: PlannedProject, batchId: string, today: string, summary: Summary, budget: number) {
    const now = nowIso();
    const email = user.email;
    let projectId: string;
    if (p.destination.kind === "existing") {
        projectId = p.destination.projectId;
        // Record the mapping, so the next import of this project goes to the same place.
        if (!p.destination.imported) await provenanceStatement(db, email, "project", p.keys.projectKey, projectId, batchId, null, p.keys.projectKey, now).run();
    } else {
        projectId = newId("tpj");
        await db.batch([
            db
                .prepare(
                    `INSERT INTO task_projects (id, name, description, color, kind, default_view, created_by, updated_by, created_at, updated_at)
                     VALUES (?, ?, '', 'gray', 'personal', ?, ?, ?, ?, ?)`,
                )
                .bind(projectId, p.data.name, p.data.board ? "board" : "list", email, email, now, now),
            db
                .prepare(
                    `INSERT INTO task_project_members (project_id, email, role, position, added_by, created_at, updated_at)
                     VALUES (?, ?, 'owner', (SELECT COALESCE(MAX(position), 0) + 1 FROM task_project_members WHERE email = ?), ?, ?, ?)`,
                )
                .bind(projectId, email, email, email, now, now),
            activity(db, { projectId, actor: email, action: "project.import", changes: { source: SOURCE } }),
            provenanceStatement(db, email, "project", p.keys.projectKey, projectId, batchId, null, p.keys.projectKey, now),
        ]);
        summary.projectsCreated++;
        p.destination = { kind: "existing", projectId, name: p.data.name, imported: true };
    }

    // Sections: the one imported before, else one of the same name, else a new one.
    const provenance = await loadProvenance(db, email);
    const sections = (
        await db.prepare("SELECT id, name, position FROM task_sections WHERE project_id = ? ORDER BY position").bind(projectId).all<{
            id: string;
            name: string;
            position: number;
        }>()
    ).results;
    const sectionIds: string[] = [];
    let lastSection = Math.max(0, ...sections.map((s) => s.position));
    for (const [i, s] of p.data.sections.entries()) {
        const key = p.keys.sectionKeys[i];
        const before = provenance.get(`section:${key}`);
        const found = sections.find((x) => x.id === before?.target_id) ?? sections.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
        if (found) {
            sectionIds.push(found.id);
            if (!before) await provenanceStatement(db, email, "section", key, found.id, batchId, null, key, now).run();
            continue;
        }
        const id = newId("tsc");
        await db.batch([
            db
                .prepare("INSERT INTO task_sections (id, project_id, name, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(id, projectId, s.name, ++lastSection, email, now, now),
            provenanceStatement(db, email, "section", key, id, batchId, null, key, now),
        ]);
        sections.push({ id, name: s.name, position: lastSection });
        sectionIds.push(id);
        summary.sectionsCreated++;
    }

    // Tasks, in file order (a parent always comes before its subtasks).
    const placeOf = new Map<string, { depth: number; section: string | null }>();
    const place = async (id: string) => {
        if (!placeOf.has(id)) {
            const row = await db
                .prepare("SELECT depth, section_id FROM task_items WHERE id = ?")
                .bind(id)
                .first<{ depth: number; section_id: string | null }>();
            placeOf.set(id, { depth: row?.depth ?? 0, section: row?.section_id ?? null });
        }
        return placeOf.get(id)!;
    };
    const nextPosition = new Map<string, number>();
    const positionFor = async (sectionId: string | null, parentId: string | null) => {
        const key = `${sectionId}|${parentId}`;
        if (!nextPosition.has(key)) {
            const row = await db
                .prepare("SELECT COALESCE(MAX(position), 0) AS n FROM task_items WHERE project_id = ? AND section_id IS ? AND parent_id IS ?")
                .bind(projectId, sectionId, parentId)
                .first<{ n: number }>();
            nextPosition.set(key, row?.n ?? 0);
        }
        const n = nextPosition.get(key)! + 1;
        nextPosition.set(key, n);
        return n;
    };
    let pending: D1PreparedStatement[] = [];
    const flush = async () => {
        if (pending.length) await db.batch(pending);
        pending = [];
    };
    let written = 0;
    let created = 0;
    for (const [i, t] of p.data.tasks.entries()) {
        const status = p.status[i];
        const key = p.keys.taskKeys[i];
        const hash = p.keys.hashes[i];
        if (status !== "new" && status !== "import_duplicate" && status !== "update" && status !== "duplicate") continue;
        if (written >= budget) {
            await flush();
            return { written, done: false };
        }
        if (status === "duplicate") {
            // Linked to the task that's already there; recorded so the next import finds it.
            pending.push(provenanceStatement(db, email, "task", key, p.targets[i]!, batchId, p.versions[i], hash, now));
            summary.linkedDuplicates++;
            written++;
            if (pending.length >= BATCH_STATEMENTS) await flush();
            continue;
        }
        const statements: D1PreparedStatement[] = [];
        let schedule = { due_date: t.dueDate, due_time: t.dueTime, deadline: t.deadline, recurrence_json: null as string | null };
        try {
            schedule = resolveSchedule(
                { due_date: null, due_time: null, deadline: null, recurrence_json: null },
                { dueDate: t.dueDate, dueTime: t.dueTime, deadline: t.deadline, recurrence: t.recurrence ? recurrenceInput.parse(t.recurrence) : undefined },
                today,
            );
        } catch {
            summary.warnings.push(`${p.data.name}: “${t.title.slice(0, 60)}” repeats in a way that couldn't be set up, so it's imported as a one-off`);
        }
        const labels = normaliseLabels(t.labels);
        if (status === "update") {
            const id = p.targets[i]!;
            const current = { version: p.versions[i]! };
            const guard = "EXISTS (SELECT 1 FROM task_items WHERE id = ? AND version = ?)";
            statements.push(
                db
                    .prepare(
                        `UPDATE task_items SET title = ?, description = ?, priority = ?, due_date = ?, due_time = ?, deadline = ?, recurrence_json = ?,
                            version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ? AND status = 'open'`,
                    )
                    .bind(
                        t.title,
                        t.description,
                        t.priority,
                        schedule.due_date,
                        schedule.due_time,
                        schedule.deadline,
                        schedule.recurrence_json,
                        email,
                        now,
                        id,
                        current.version,
                    ),
                db.prepare(`DELETE FROM task_item_labels WHERE task_id = ? AND ${guard}`).bind(id, id, current.version + 1),
                ...labelStatements(db, id, labels, email, now),
                db
                    .prepare(
                        `UPDATE task_import_items SET content_hash = ?, imported_version = ?, batch_id = ? WHERE owner_email = ? AND source = ? AND kind = 'task' AND source_key = ? AND ${guard}`,
                    )
                    .bind(hash, current.version + 1, batchId, email, SOURCE, key, id, current.version + 1),
            );
            summary.tasksUpdated++;
        } else {
            const parentId = t.parent === null ? null : p.targets[t.parent];
            if (t.parent !== null && !parentId) {
                // Its parent wasn't imported (deleted here since, or a conflict): import it at the top level.
                summary.warnings.push(`${p.data.name}: “${t.title.slice(0, 60)}” is imported at the top level because its parent isn't here`);
            }
            const sectionId = t.section === null ? null : sectionIds[t.section];
            const parent = parentId ? await place(parentId) : null;
            const parentDepth = parent ? parent.depth : -1;
            if (parentDepth >= 3) {
                summary.warnings.push(`${p.data.name}: “${t.title.slice(0, 60)}” would be nested too deep, so it's skipped`);
                continue;
            }
            // A subtask lives in its parent's section.
            const parentSection = parent ? parent.section : sectionId;
            const id = newId("tsk");
            const position = await positionFor(parentSection, parentId);
            statements.push(
                db
                    .prepare(
                        `INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, description, priority, due_date, due_time, deadline,
                            recurrence_json, position, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .bind(
                        id,
                        projectId,
                        parentSection,
                        parentId,
                        parentDepth + 1,
                        t.title,
                        t.description,
                        t.priority,
                        schedule.due_date,
                        schedule.due_time,
                        schedule.deadline,
                        schedule.recurrence_json,
                        position,
                        email,
                        email,
                        now,
                        now,
                    ),
                ...labelStatements(db, id, labels, email, now),
                ...t.comments.map((c) =>
                    db
                        .prepare("INSERT INTO task_comments (id, task_id, author_email, body, created_at) VALUES (?, ?, ?, ?, ?)")
                        .bind(newId("tcm"), id, email, c, now),
                ),
                provenanceStatement(db, email, "task", key, id, batchId, 1, hash, now),
            );
            placeOf.set(id, { depth: parentDepth + 1, section: parentSection });
            p.targets[i] = id;
            summary.tasksCreated++;
            summary.comments += t.comments.length;
            created++;
        }
        if (pending.length + statements.length > BATCH_STATEMENTS) await flush();
        pending.push(...statements);
        written++;
    }
    if (created) pending.push(activity(db, { projectId, actor: email, action: "tasks.import", changes: { count: created } }));
    await flush();
    return { written, done: true };
}

/** The caller's recent imports, newest first. */
export async function listImports(db: D1Database, email: string) {
    const rows = await db
        .prepare("SELECT id, status, summary_json, created_at, finished_at FROM task_import_batches WHERE owner_email = ? ORDER BY created_at DESC LIMIT 20")
        .bind(email)
        .all<{ id: string; status: string; summary_json: string | null; created_at: string; finished_at: string | null }>();
    return rows.results.map((r) => ({
        id: r.id,
        status: r.status,
        summary: parseJson<Summary | null>(r.summary_json, null),
        createdAt: r.created_at,
        finishedAt: r.finished_at,
    }));
}
