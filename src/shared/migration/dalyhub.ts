// Turns rows from a DalyHub V2 database export into a migration plan for Daly Tasks and Daly
// Knowledge (docs/DALYHUB_MIGRATION.md). Pure and dependency-free: the local planning script
// (scripts/dalyhub-plan.mjs, run with Node's type stripping) and the portal both use it, and it
// never touches a database itself.
//
// What moves, and where:
//   DalyHub Project (open)        → a personal Tasks project (archived ones are skipped by default)
//   DalyHub Task (open)           → a task in that project, or the Inbox if it has none
//     checklist item (open)       → a subtask
//     waiting / delegated         → label "waiting", with who and when in the description
//     someday                     → label "someday"
//     Area it belongs to          → a label with the Area's name
//     repeating                   → a single task, label "was-repeating" (the rule is not translated)
//   DalyHub Goal (open)           → a personal Tasks goal, linked to the projects that advance it
//   DalyHub Area                  → a Knowledge object of type Area
//   DalyHub Note                  → a Knowledge Page (Markdown kept as literal text, never as markup)
//   DalyHub Decision              → a Knowledge Decision (status, decided-on date)
//   DalyHub Meeting               → a Knowledge Meeting (date, agenda and notes as text)
// Notes, decisions and meetings filed under a migrated project are linked to it.
//
// Never moved by this plan: People (contact details), Diary, Finance, Assets, Obligations, Habits,
// Attachments, Reviews, AI history, Notifications, Calendar, Templates, saved views and settings.
// They stay in DalyHub's backups; the plan lists how many of each it left behind.

export const PLAN_FORMAT = "daly.dalyhub-migration.v1";

// --- Source rows (the columns the planner reads from the export) ----------------------------------

export interface SourceEntity {
    id: string;
    workspace_id: string;
    type: string;
    title: string;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
}
export interface SourceLink {
    source_entity_id: string;
    target_entity_id: string;
    type: string;
    deleted_at: string | null;
}
export interface SourceSpine {
    entity_id: string;
    kind: string;
    completed_at: string | null;
}
export interface SourceTask {
    entity_id: string;
    status: string;
    priority: string | null;
    due_date: string | null;
    scheduled_date: string | null;
    commitment_state: string;
    delegate_to: string | null;
    delegated_on: string | null;
    follow_up_on: string | null;
    delegate_note: string | null;
    description: string | null;
    waiting_since: string | null;
    waiting_note: string | null;
}
export interface SourceProject {
    entity_id: string;
    status: string;
    archived_at: string | null;
}
export interface SourceGoal {
    entity_id: string;
    target_date: string | null;
    definition_of_done: string | null;
}
export interface SourceArea {
    entity_id: string;
    archived_at: string | null;
}
export interface SourceNote {
    entity_id: string;
    content: string;
    archived_at: string | null;
}
export interface SourceDecision {
    entity_id: string;
    status: string;
    rationale: string | null;
    decision_date: string | null;
    review_date: string | null;
    related_entity_id: string | null;
}
export interface SourceMeeting {
    entity_id: string;
    starts_at: string;
    timezone: string;
    location: string | null;
    status: string;
    agenda_markdown: string;
    notes_markdown: string;
    archived_at: string | null;
}
export interface SourceChecklistItem {
    id: string;
    task_id: string;
    title: string;
    position: number;
    completed: number;
}
export interface SourceTag {
    entity_id: string;
    tag_key: string;
}

export interface DalyHubSource {
    entities: SourceEntity[];
    links: SourceLink[];
    spine: SourceSpine[];
    tasks: SourceTask[];
    projects: SourceProject[];
    goals: SourceGoal[];
    areas: SourceArea[];
    notes: SourceNote[];
    decisions: SourceDecision[];
    meetings: SourceMeeting[];
    checklist: SourceChecklistItem[];
    /** Entity ids that have a recurrence rule. */
    recurring: string[];
    tags: SourceTag[];
    /** Row counts for every table in the export, for the audit of what is left behind. */
    tableCounts: Record<string, number>;
}

export interface PlanOptions {
    /** Also migrate completed tasks, projects and goals (default: open work only). */
    includeCompleted?: boolean;
    /** Also migrate archived projects, notes and areas (default: no). */
    includeArchived?: boolean;
    /** When the plan was made. */
    now?: string;
    /** When the export was taken, if known. */
    exportedAt?: string | null;
}

// --- The plan --------------------------------------------------------------------------------------

export interface PlannedProject {
    sourceId: string;
    name: string;
    description: string;
}
export interface PlannedGoal {
    sourceId: string;
    title: string;
    description: string;
    targetDate: string | null;
    projectSourceIds: string[];
}
export interface PlannedTask {
    sourceId: string;
    /** null: the Inbox. */
    projectSourceId: string | null;
    /** A subtask's parent (another planned task). */
    parentSourceId: string | null;
    title: string;
    description: string;
    priority: 1 | 2 | 3 | 4;
    dueDate: string | null;
    deadline: string | null;
    labels: string[];
}
export type KnowledgeKind = "page" | "area" | "decision" | "meeting";
export interface PlannedObject {
    sourceId: string;
    type: KnowledgeKind;
    title: string;
    text: string;
    tags: string[];
    properties: Record<string, string>;
    /** Link the object to this migrated project (Tasks → Knowledge reference). */
    projectSourceId: string | null;
}
export interface SkippedGroup {
    category: string;
    count: number;
    reason: string;
}
export interface DalyHubPlan {
    format: typeof PLAN_FORMAT;
    createdAt: string;
    source: { workspaceId: string | null; exportedAt: string | null };
    options: { includeCompleted: boolean; includeArchived: boolean };
    projects: PlannedProject[];
    goals: PlannedGoal[];
    tasks: PlannedTask[];
    knowledge: PlannedObject[];
    skipped: SkippedGroup[];
    warnings: string[];
}

export const PLAN_LIMITS = { projects: 500, goals: 200, tasks: 5_000, knowledge: 5_000 } as const;

/** Tables whose rows are never migrated, with the reason the preview gives. */
export const LEFT_BEHIND: Record<string, string> = {
    person_details: "People hold contact details. Not migrated without a separate decision (docs/DALYHUB_MIGRATION.md).",
    diary_entry_details: "Diary entries are private by DalyHub's own rules. Not migrated.",
    finance_account_details: "Finance has no home in Daly Portal.",
    finance_transaction_details: "Finance has no home in Daly Portal.",
    finance_budgets: "Finance has no home in Daly Portal.",
    finance_categories: "Finance has no home in Daly Portal.",
    finance_imports: "Finance has no home in Daly Portal.",
    asset_details: "Assets have no home in Daly Portal.",
    asset_events: "Assets have no home in Daly Portal.",
    obligation_details: "Obligations have no home in Daly Portal.",
    habit_details: "Habits could become Tasks routines; not migrated automatically.",
    habit_completions: "Habit history is not migrated.",
    attachments: "Attachment files live in DalyHub's R2 bucket and are not copied.",
    review_details: "Past reviews are history, not work. Daly Tasks has its own reviews.",
    goal_milestones: "Goal milestones are not translated; the goal and its projects are.",
    goal_measurements: "Goal measurement history is not migrated.",
    activities: "DalyHub's activity history stays in its backups.",
    ai_usage_requests: "AI usage history is not migrated.",
    notifications: "Notifications are not migrated.",
    external_calendar_events: "Calendar copies are not migrated.",
    project_template_details: "Templates are not migrated.",
    task_saved_views: "Saved views are not migrated.",
};

// --- Helpers ---------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (value: string | null | undefined): string | null => (value && DATE.test(value.slice(0, 10)) ? value.slice(0, 10) : null);
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const clean = (value: string | null | undefined) => (value ?? "").replace(/\r\n?/g, "\n").trim();
const priorityOf = (value: string | null): 1 | 2 | 3 | 4 => (value === "p1" ? 1 : value === "p2" ? 2 : value === "p3" ? 3 : 4);
const labelName = (value: string) =>
    value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/^[@#]+/, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);

function byId<T extends { entity_id: string }>(rows: T[]): Map<string, T> {
    return new Map(rows.map((r) => [r.entity_id, r]));
}

/** The active target of a link of one of `types` from `source`, if there is exactly one. */
function linkTarget(links: SourceLink[], source: string, types: string[]): string | null {
    const found = links.filter((l) => l.source_entity_id === source && l.deleted_at === null && types.includes(l.type));
    return found.length === 1 ? found[0].target_entity_id : null;
}

// --- Planning --------------------------------------------------------------------------------------

export function planDalyHubMigration(source: DalyHubSource, options: PlanOptions = {}): DalyHubPlan {
    const includeCompleted = options.includeCompleted ?? false;
    const includeArchived = options.includeArchived ?? false;
    const warnings: string[] = [];
    const skipped = new Map<string, SkippedGroup>();
    const skip = (category: string, reason: string, count = 1) => {
        const key = `${category}\u0000${reason}`;
        const group = skipped.get(key) ?? { category, count: 0, reason };
        group.count += count;
        skipped.set(key, group);
    };

    const live = source.entities.filter((e) => e.deleted_at === null);
    for (const e of source.entities) if (e.deleted_at !== null) skip(e.type, "Deleted in DalyHub.");
    const workspaces = new Set(live.map((e) => e.workspace_id));
    if (workspaces.size > 1) warnings.push(`The export holds ${workspaces.size} DalyHub workspaces. Only one is expected; check before applying.`);
    const entity = new Map(live.map((e) => [e.id, e]));
    const completed = new Map(source.spine.map((s) => [s.entity_id, s.completed_at]));
    const tasks = byId(source.tasks);
    const projects = byId(source.projects);
    const goals = byId(source.goals);
    const areas = byId(source.areas);
    const recurring = new Set(source.recurring);
    const tagsOf = new Map<string, string[]>();
    for (const t of source.tags) tagsOf.set(t.entity_id, [...(tagsOf.get(t.entity_id) ?? []), t.tag_key]);
    const ofType = (type: string) => live.filter((e) => e.type === type).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

    // Projects.
    const plannedProjects: PlannedProject[] = [];
    for (const e of ofType("project")) {
        const details = projects.get(e.id);
        if (!details) {
            skip("project", "Has no project details in the export.");
            continue;
        }
        if (details.archived_at && !includeArchived) {
            skip("project", "Archived in DalyHub (run with --include-archived to bring it).");
            continue;
        }
        if (completed.get(e.id) && !includeCompleted) {
            skip("project", "Completed in DalyHub (run with --include-completed to bring it).");
            continue;
        }
        const area = linkTarget(source.links, e.id, ["project.belongs_to_area"]);
        const goal = linkTarget(source.links, e.id, ["project.advances_goal"]);
        const lines = [
            "Migrated from DalyHub.",
            details.status !== "active" ? `Status there: ${details.status.replace("_", " ")}.` : "",
            area && entity.get(area) ? `Area: ${entity.get(area)!.title}.` : "",
            goal && entity.get(goal) ? `Advances the goal: ${entity.get(goal)!.title}.` : "",
        ].filter(Boolean);
        plannedProjects.push({ sourceId: e.id, name: clip(e.title.trim(), 120), description: clip(lines.join(" "), 2_000) });
    }
    const migratedProject = new Set(plannedProjects.map((p) => p.sourceId));

    // Goals.
    const plannedGoals: PlannedGoal[] = [];
    for (const e of ofType("goal")) {
        const details = goals.get(e.id);
        if (completed.get(e.id) && !includeCompleted) {
            skip("goal", "Completed in DalyHub.");
            continue;
        }
        const projectSourceIds = source.links
            .filter(
                (l) => l.type === "project.advances_goal" && l.target_entity_id === e.id && l.deleted_at === null && migratedProject.has(l.source_entity_id),
            )
            .map((l) => l.source_entity_id)
            .slice(0, 10);
        plannedGoals.push({
            sourceId: e.id,
            title: clip(e.title.trim(), 200),
            description: clip(clean(details?.definition_of_done) ? `Definition of done: ${clean(details?.definition_of_done)}` : "", 2_000),
            targetDate: date(details?.target_date),
            projectSourceIds,
        });
    }

    // Tasks and their checklist items.
    const plannedTasks: PlannedTask[] = [];
    for (const e of ofType("task")) {
        const details = tasks.get(e.id);
        if (!details) {
            skip("task", "Has no task details in the export.");
            continue;
        }
        if (details.status === "cancelled") {
            skip("task", "Cancelled in DalyHub.");
            continue;
        }
        if (completed.get(e.id) && !includeCompleted) {
            skip("task", "Completed in DalyHub.");
            continue;
        }
        const project = linkTarget(source.links, e.id, ["task.belongs_to_project"]);
        const area =
            linkTarget(source.links, e.id, ["task.belongs_to_area"]) ?? (project ? linkTarget(source.links, project, ["project.belongs_to_area"]) : null);
        let projectSourceId: string | null = null;
        if (project && migratedProject.has(project)) projectSourceId = project;
        else if (project) {
            skip("task", "Its project isn't migrated, so it goes to the Inbox.", 0);
            warnings.push(`"${clip(e.title, 60)}" belongs to a project that isn't migrated; it will go to the Inbox.`);
        }

        const labels = ["dalyhub"];
        const notes: string[] = [];
        const waiting = details.waiting_since || details.delegate_to;
        if (waiting) {
            labels.push("waiting");
            const who = linkTarget(source.links, e.id, ["task.waiting_on"]);
            const whoName = details.delegate_to ?? (who && entity.get(who) ? entity.get(who)!.title : null);
            notes.push(
                [
                    whoName ? `Waiting on ${whoName}` : "Waiting",
                    date(details.delegated_on ?? details.waiting_since) ? ` since ${date(details.delegated_on ?? details.waiting_since)}` : "",
                    date(details.follow_up_on) ? `; follow up ${date(details.follow_up_on)}` : "",
                    ".",
                ].join(""),
            );
            if (clean(details.waiting_note)) notes.push(clean(details.waiting_note));
            if (clean(details.delegate_note)) notes.push(clean(details.delegate_note));
        }
        if (details.commitment_state === "someday") labels.push("someday");
        if (details.status === "on_hold") labels.push("on-hold");
        if (recurring.has(e.id)) {
            labels.push("was-repeating");
            notes.push("This repeated in DalyHub. Set up the repeat again in Daly Tasks if it's still wanted.");
        }
        if (area && entity.get(area)) labels.push(labelName(entity.get(area)!.title));
        for (const tag of tagsOf.get(e.id) ?? []) labels.push(labelName(tag));

        const scheduled = date(details.scheduled_date);
        const due = date(details.due_date);
        const description = [clean(details.description), ...notes].filter(Boolean).join("\n\n");
        plannedTasks.push({
            sourceId: e.id,
            projectSourceId,
            parentSourceId: null,
            title: clip(e.title.trim(), 500),
            description: clip(description, 10_000),
            priority: priorityOf(details.priority),
            // DalyHub's scheduled date is when to do it, its due date the deadline. With only a due
            // date, that's both.
            dueDate: waiting && date(details.follow_up_on) ? date(details.follow_up_on) : (scheduled ?? due),
            deadline: scheduled && due ? due : null,
            labels: [...new Set(labels.filter(Boolean))].slice(0, 20),
        });
    }
    const migratedTask = new Map(plannedTasks.map((t) => [t.sourceId, t]));
    for (const item of [...source.checklist].sort((a, b) => a.task_id.localeCompare(b.task_id) || a.position - b.position)) {
        const parent = migratedTask.get(item.task_id);
        if (!parent) {
            skip("checklist item", "Its task isn't migrated.");
            continue;
        }
        if (item.completed && !includeCompleted) {
            skip("checklist item", "Ticked off in DalyHub.");
            continue;
        }
        plannedTasks.push({
            sourceId: `checklist:${item.id}`,
            projectSourceId: parent.projectSourceId,
            parentSourceId: parent.sourceId,
            title: clip(item.title.trim(), 500),
            description: "",
            priority: 4,
            dueDate: null,
            deadline: null,
            labels: ["dalyhub"],
        });
    }

    // Knowledge: areas, notes, decisions, meetings.
    const knowledge: PlannedObject[] = [];
    const fileUnder = (id: string) => {
        const target = source.links.find(
            (l) =>
                l.deleted_at === null &&
                ((l.source_entity_id === id && migratedProject.has(l.target_entity_id)) ||
                    (l.target_entity_id === id && migratedProject.has(l.source_entity_id))),
        );
        return target ? (migratedProject.has(target.target_entity_id) ? target.target_entity_id : target.source_entity_id) : null;
    };
    for (const e of ofType("area")) {
        if (areas.get(e.id)?.archived_at && !includeArchived) {
            skip("area", "Archived in DalyHub.");
            continue;
        }
        const projectNames = source.links
            .filter((l) => l.type === "project.belongs_to_area" && l.target_entity_id === e.id && l.deleted_at === null && entity.get(l.source_entity_id))
            .map((l) => entity.get(l.source_entity_id)!.title);
        knowledge.push({
            sourceId: e.id,
            type: "area",
            title: clip(e.title.trim(), 300),
            text: ["Migrated from DalyHub.", projectNames.length ? `Projects in this area: ${projectNames.join(", ")}.` : ""].filter(Boolean).join("\n\n"),
            tags: ["dalyhub", ...(tagsOf.get(e.id) ?? [])].slice(0, 30),
            properties: {},
            projectSourceId: null,
        });
    }
    for (const note of source.notes) {
        const e = entity.get(note.entity_id);
        if (!e) continue;
        if (note.archived_at && !includeArchived) {
            skip("note", "Archived in DalyHub.");
            continue;
        }
        const body = clean(note.content);
        if (body.length > 20_000) warnings.push(`The note "${clip(e.title, 60)}" is longer than 20,000 characters and will be shortened.`);
        knowledge.push({
            sourceId: e.id,
            type: "page",
            title: clip(e.title.trim(), 300),
            text: clip(body, 20_000),
            tags: ["dalyhub", ...(tagsOf.get(e.id) ?? [])].slice(0, 30),
            properties: {},
            projectSourceId: fileUnder(e.id),
        });
    }
    for (const d of source.decisions) {
        const e = entity.get(d.entity_id);
        if (!e) continue;
        const text = [
            clean(d.rationale) ? `Why: ${clean(d.rationale)}` : "",
            date(d.review_date) ? `Review on ${date(d.review_date)}.` : "",
            d.related_entity_id && entity.get(d.related_entity_id) ? `About: ${entity.get(d.related_entity_id)!.title}.` : "",
        ].filter(Boolean);
        knowledge.push({
            sourceId: e.id,
            type: "decision",
            title: clip(e.title.trim(), 300),
            text: clip(text.join("\n\n"), 20_000),
            tags: ["dalyhub", ...(tagsOf.get(e.id) ?? [])].slice(0, 30),
            properties: { status: d.status === "decided" ? "decided" : "proposed", ...(date(d.decision_date) ? { decided_on: date(d.decision_date)! } : {}) },
            projectSourceId: d.related_entity_id && migratedProject.has(d.related_entity_id) ? d.related_entity_id : null,
        });
    }
    for (const m of source.meetings) {
        const e = entity.get(m.entity_id);
        if (!e) continue;
        if (m.archived_at && !includeArchived) {
            skip("meeting", "Archived in DalyHub.");
            continue;
        }
        if (m.status === "cancelled") {
            skip("meeting", "Cancelled in DalyHub.");
            continue;
        }
        const text = [
            m.location ? `Where: ${clean(m.location)}` : "",
            clean(m.agenda_markdown) ? `Agenda\n\n${clean(m.agenda_markdown)}` : "",
            clean(m.notes_markdown) ? `Notes\n\n${clean(m.notes_markdown)}` : "",
        ].filter(Boolean);
        knowledge.push({
            sourceId: e.id,
            type: "meeting",
            title: clip(e.title.trim(), 300),
            text: clip(text.join("\n\n"), 20_000),
            tags: ["dalyhub", ...(tagsOf.get(e.id) ?? [])].slice(0, 30),
            properties: date(m.starts_at) ? { date: date(m.starts_at)! } : {},
            projectSourceId: fileUnder(e.id),
        });
    }

    for (const [table, reason] of Object.entries(LEFT_BEHIND)) {
        const count = source.tableCounts[table] ?? 0;
        if (count > 0) skip(table, reason, count);
    }
    for (const [what, list, max] of [
        ["projects", plannedProjects, PLAN_LIMITS.projects],
        ["goals", plannedGoals, PLAN_LIMITS.goals],
        ["tasks", plannedTasks, PLAN_LIMITS.tasks],
        ["Knowledge objects", knowledge, PLAN_LIMITS.knowledge],
    ] as const) {
        if (list.length > max) warnings.push(`There are ${list.length} ${what}; one plan holds at most ${max}. Split the migration.`);
    }

    return {
        format: PLAN_FORMAT,
        createdAt: options.now ?? new Date().toISOString(),
        source: { workspaceId: workspaces.size === 1 ? [...workspaces][0] : null, exportedAt: options.exportedAt ?? null },
        options: { includeCompleted, includeArchived },
        projects: plannedProjects,
        goals: plannedGoals,
        tasks: plannedTasks,
        knowledge,
        skipped: [...skipped.values()].filter((g) => g.count > 0),
        warnings,
    };
}

/** A short human summary of a plan, for the preview. */
export function describePlan(plan: DalyHubPlan): string {
    const lines = [
        "# DalyHub → Daly Portal migration preview",
        "",
        `Plan made ${plan.createdAt}${plan.source.exportedAt ? ` from an export taken ${plan.source.exportedAt}` : ""}. Nothing has been written anywhere.`,
        "",
        "## Will be created",
        "",
        `- ${plan.projects.length} Tasks projects (personal)`,
        `- ${plan.tasks.filter((t) => !t.parentSourceId).length} tasks and ${plan.tasks.filter((t) => t.parentSourceId).length} subtasks`,
        `- ${plan.goals.length} Tasks goals (personal)`,
        `- ${plan.knowledge.length} Knowledge objects in your personal space: ${(["page", "area", "decision", "meeting"] as const).map((k) => `${plan.knowledge.filter((o) => o.type === k).length} ${k}s`).join(", ")}`,
        "",
        "Every imported task has the label `dalyhub`, and every Knowledge object the tag `dalyhub`.",
        "Note, agenda and meeting text is stored as plain text: Markdown formatting shows literally.",
        "",
        "## Left behind",
        "",
        ...(plan.skipped.length ? plan.skipped.map((s) => `- ${s.count} × ${s.category}: ${s.reason}`) : ["- Nothing."]),
        "",
        "## Warnings",
        "",
        ...(plan.warnings.length ? plan.warnings.map((w) => `- ${w}`) : ["- None."]),
        "",
    ];
    return lines.join("\n");
}
