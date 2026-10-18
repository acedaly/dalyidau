// Reading Todoist's CSV export ("Export as CSV" on a project, or the CSV files inside a Todoist
// backup zip). One file is one project. Columns, per Todoist's own help article ("Format a CSV file
// to import into Todoist"): TYPE (task | section | note | meta), CONTENT, DESCRIPTION, PRIORITY,
// INDENT, AUTHOR, RESPONSIBLE, DATE, DATE_LANG, TIMEZONE, DURATION, DURATION_UNIT, DEADLINE,
// DEADLINE_LANG and, for sections, IS_COLLAPSED.
//
// What the format can't give us, and so isn't imported: completed tasks (the export leaves them
// out), creation and completion times, Todoist's ids, assignees and authors (people are named, not
// identified, and aren't Daly Portal users), durations, reminders and attachments. A repeating
// date is exported without its start ("every year starting 31 Jan" becomes "every year"), so it
// starts from its next occurrence after the import. Dates are read with Quick Add's own grammar;
// any date it doesn't understand is reported and the task is imported without one. Nothing is
// guessed silently: every such case is a warning in the preview.
//
// Pure functions shared by the Worker (which always parses again; it never trusts the browser's
// reading) and the browser.
import { parseQuickAdd, readDate } from "./parse";
import type { RecurrenceInput } from "./recurrence";
import { LIMITS, MAX_DEPTH, type Priority } from "./types";

export const IMPORT_LIMITS = { fileBytes: 2_000_000, files: 30, tasks: 5_000, rows: 20_000 };

export const KNOWN_COLUMNS = [
    "TYPE",
    "CONTENT",
    "DESCRIPTION",
    "PRIORITY",
    "INDENT",
    "AUTHOR",
    "RESPONSIBLE",
    "DATE",
    "DATE_LANG",
    "TIMEZONE",
    "DURATION",
    "DURATION_UNIT",
    "DEADLINE",
    "DEADLINE_LANG",
    "IS_COLLAPSED",
    "META",
] as const;
/** Columns that are read. The rest are reported as not imported when they hold anything. */
const USED = new Set(["TYPE", "CONTENT", "DESCRIPTION", "PRIORITY", "INDENT", "DATE", "DEADLINE", "DATE_LANG", "DEADLINE_LANG", "META"]);

/**
 * How PRIORITY numbers map to P1–P4. Todoist's help says 1 is p1 (the highest), but files made from
 * its API use 4 for p1. The preview shows what's in the file and the person chooses.
 */
export type PriorityScale = "one_is_highest" | "four_is_highest";

export interface ImportedTask {
    /** Row number in the file (1 = the first row after the header), for warnings. */
    row: number;
    title: string;
    description: string;
    priority: Priority;
    rawPriority: string;
    labels: string[];
    depth: number;
    /** Index of the parent task in `tasks`, or null for a top-level task. */
    parent: number | null;
    /** Index in `sections`, or null for tasks before the first section. */
    section: number | null;
    dueDate: string | null;
    dueTime: string | null;
    recurrence: RecurrenceInput | null;
    deadline: string | null;
    /** The DATE text as exported, for the preview and the matching rule. */
    dateText: string;
    comments: string[];
}

export interface ImportedProject {
    file: string;
    name: string;
    /** From a backup file name like "Home [2203306141].csv", when present. */
    sourceId: string | null;
    description: string;
    board: boolean;
    sections: { name: string; row: number }[];
    tasks: ImportedTask[];
    /** Columns with data that isn't imported, with how many rows used them. */
    unsupported: Record<string, number>;
    warnings: string[];
    priorityValues: Record<string, number>;
}

export class ImportFormatError extends Error {}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a UTF-8 byte order mark. */
export function parseCsv(text: string, maxRows = IMPORT_LIMITS.rows): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') ((field += '"'), i++);
                else quoted = false;
            } else field += c;
        } else if (c === '"' && field === "") quoted = true;
        else if (c === ",") (row.push(field), (field = ""));
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            field = "";
            if (row.some((f) => f !== "")) rows.push(row);
            row = [];
            if (rows.length > maxRows) throw new ImportFormatError(`The file has more than ${maxRows.toLocaleString()} rows`);
        } else field += c;
    }
    if (quoted) throw new ImportFormatError("The file ends inside a quoted value, so it isn't valid CSV");
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
    return rows;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (text: string, max: number) => text.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim().slice(0, max);

/** "@errands" words in Todoist content are labels. */
const LABEL = /(?<=^|\s)@([\p{L}\p{N}_-]{1,60})(?=$|\s)/gu;

/** Project name from the file name: "Home [2203306141].csv" → "Home", with the bracketed id kept. */
export function projectFromFileName(file: string): { name: string; sourceId: string | null } {
    const base = file
        .split(/[\\/]/)
        .pop()!
        .replace(/\.csv$/i, "");
    const m = /^(.*?)\s*\[(\d{3,20})\]$/.exec(base);
    const name = clean(m ? m[1] : base, LIMITS.projectName) || "Imported project";
    return { name, sourceId: m ? m[2] : null };
}

function readTodoistDate(text: string, today: string): { dueDate: string | null; dueTime: string | null; recurrence: RecurrenceInput | null } | null {
    const t = text.trim();
    if (!t) return { dueDate: null, dueTime: null, recurrence: null };
    // ISO dates and date-times ("2026-10-21", "2026-10-21T09:30:00").
    const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z?)?$/.exec(t);
    if (iso) return readDate(iso[1], today) ? { dueDate: iso[1], dueTime: iso[2] ? `${iso[2]}:${iso[3]}` : null, recurrence: null } : null;
    // Otherwise Todoist's natural language, through Quick Add's grammar: accepted only if all of it was understood.
    const parsed = parseQuickAdd(`x ${t}`, { today });
    if (parsed.title !== "x" || !parsed.tokens.length || parsed.tokens.some((k) => !["date", "time", "recurrence"].includes(k.kind))) return null;
    return { dueDate: parsed.dueDate, dueTime: parsed.dueTime, recurrence: parsed.recurrence };
}

const priorityOf = (raw: string, scale: PriorityScale): Priority => {
    const n = Number(raw);
    // An empty cell is p1 per Todoist's format; here it's the safer P4 unless the file says otherwise.
    if (!raw.trim() || !Number.isInteger(n) || n < 1 || n > 4) return 4;
    return (scale === "one_is_highest" ? n : 5 - n) as Priority;
};

/** Reads one exported project. Throws ImportFormatError for a file that isn't a Todoist CSV. */
export function parseTodoistCsv(file: string, text: string, options: { today: string; priorityScale: PriorityScale }): ImportedProject {
    if (new TextEncoder().encode(text).length > IMPORT_LIMITS.fileBytes)
        throw new ImportFormatError(`${file} is larger than ${IMPORT_LIMITS.fileBytes / 1_000_000} MB`);
    const rows = parseCsv(text);
    if (!rows.length) throw new ImportFormatError(`${file} is empty`);
    const header = rows[0].map((h) => h.trim().toUpperCase());
    const col = (name: string) => header.indexOf(name);
    if (col("TYPE") === -1 || col("CONTENT") === -1)
        throw new ImportFormatError(`${file} doesn't look like a Todoist export (it needs TYPE and CONTENT columns)`);
    const { name, sourceId } = projectFromFileName(file);
    const project: ImportedProject = {
        file,
        name,
        sourceId,
        description: "",
        board: false,
        sections: [],
        tasks: [],
        unsupported: {},
        warnings: [],
        priorityValues: {},
    };
    for (const h of header) if (h && !USED.has(h) && !(KNOWN_COLUMNS as readonly string[]).includes(h)) project.unsupported[h] = 0;
    const get = (row: string[], name: string) => (col(name) === -1 ? "" : (row[col(name)] ?? ""));
    // The most recent task at each depth, so INDENT can find a parent.
    const lastAt: (number | null)[] = [null, null, null, null];
    let section: number | null = null;
    const langs = new Set<string>();

    rows.slice(1).forEach((row, i) => {
        const line = i + 1;
        const type = get(row, "TYPE").trim().toLowerCase();
        for (const h of header)
            if (h && !USED.has(h) && get(row, h).trim() && !(h === "DURATION_UNIT" && /^none$/i.test(get(row, h).trim())))
                project.unsupported[h] = (project.unsupported[h] ?? 0) + 1;
        const content = get(row, "CONTENT");
        if (type === "meta" || (type === "" && /^view_style=/i.test(content))) {
            if (/view_style=board/i.test(`${content} ${get(row, "META")}`)) project.board = true;
            return;
        }
        if (type === "section") {
            project.sections.push({ name: clean(content, LIMITS.sectionName) || "Untitled section", row: line });
            section = project.sections.length - 1;
            lastAt.fill(null);
            return;
        }
        if (type === "note") {
            const task = project.tasks[project.tasks.length - 1];
            const body = clean(content, LIMITS.comment);
            if (task && body) task.comments.push(body);
            else if (body) project.warnings.push(`Row ${line}: a comment with no task before it was left out`);
            return;
        }
        if (type !== "task") {
            if (type) project.warnings.push(`Row ${line}: “${type}” rows aren't imported`);
            return;
        }
        if (project.tasks.length >= IMPORT_LIMITS.tasks) {
            if (project.tasks.length === IMPORT_LIMITS.tasks) project.warnings.push(`Only the first ${IMPORT_LIMITS.tasks.toLocaleString()} tasks were read`);
            return;
        }
        const labels: string[] = [];
        const title = clean(content.replace(LABEL, (_, label: string) => (labels.push(label), "")).replace(/\s+/g, " "), LIMITS.title);
        if (!title) {
            project.warnings.push(`Row ${line}: a task with no name was left out`);
            return;
        }
        const indent = Number(get(row, "INDENT").trim() || "1");
        let depth = Number.isInteger(indent) && indent >= 1 ? Math.min(indent - 1, MAX_DEPTH) : 0;
        if (indent - 1 > MAX_DEPTH) project.warnings.push(`Row ${line}: nested deeper than ${MAX_DEPTH + 1} levels, so it's placed at the deepest level`);
        let parent: number | null = null;
        if (depth > 0) {
            // The nearest task above at a shallower level; Todoist only skips levels in edited files.
            let d = depth - 1;
            while (d >= 0 && lastAt[d] === null) d--;
            if (d < 0) project.warnings.push(`Row ${line}: an indented task with no task above it is imported at the top level`);
            else if (d < depth - 1) project.warnings.push(`Row ${line}: nested more than one level below the task above, so it's placed one level below it`);
            depth = d + 1;
            parent = d < 0 ? null : lastAt[d];
        }
        const rawPriority = get(row, "PRIORITY").trim();
        project.priorityValues[rawPriority || "(blank)"] = (project.priorityValues[rawPriority || "(blank)"] ?? 0) + 1;
        const dateText = get(row, "DATE").trim();
        const lang = get(row, "DATE_LANG").trim().toLowerCase();
        if (dateText && lang && lang !== "en") langs.add(lang);
        const date = readTodoistDate(dateText, options.today);
        if (!date)
            project.warnings.push(`Row ${line}: the date “${dateText.slice(0, 60)}” wasn't understood, so “${title.slice(0, 60)}” is imported without one`);
        const deadlineText = get(row, "DEADLINE").trim();
        const deadline = deadlineText
            ? (readDate(deadlineText.slice(0, 10), options.today)?.date ?? readDate(deadlineText, options.today)?.date ?? null)
            : null;
        if (deadlineText && !deadline) project.warnings.push(`Row ${line}: the deadline “${deadlineText.slice(0, 40)}” wasn't understood`);
        project.tasks.push({
            row: line,
            title,
            description: clean(get(row, "DESCRIPTION"), LIMITS.description),
            priority: priorityOf(rawPriority, options.priorityScale),
            rawPriority,
            labels: [...new Set(labels)].slice(0, LIMITS.labelsPerTask),
            depth,
            parent,
            section,
            dueDate: date?.dueDate ?? null,
            dueTime: date?.dueTime ?? null,
            recurrence: date?.recurrence ?? null,
            deadline,
            dateText,
            comments: [],
        });
        lastAt[depth] = project.tasks.length - 1;
        for (let d = depth + 1; d < lastAt.length; d++) lastAt[d] = null;
    });
    if (langs.size) project.warnings.push(`Some dates are in ${[...langs].join(", ")}; only English dates are understood`);
    for (const [key, n] of Object.entries(project.unsupported)) if (!n) delete project.unsupported[key];
    return project;
}

// --- Matching (idempotency) ----------------------------------------------------------------------

/** Lower-case, single-spaced text for keys. */
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const sha = async (text: string) => {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return [...bytes.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Stable keys for each project, section and task, so a second import of the same export finds what
 * the first one made. Todoist's CSV has no ids, so a key is built from where the item sits:
 *   project: the backup's bracketed project id if the file name has one, otherwise the project name;
 *   section: the project key, the section name, and which section of that name it is (1st, 2nd…);
 *   task:    the project key, its section, the titles of its parent tasks, its own title, and which
 *            task of that title it is among its siblings.
 * So renaming a task, or moving it, in Todoist makes it a new task on the next import; editing its
 * description, date or priority doesn't (that's a change to the same task, reconciled as chosen).
 */
export async function importKeys(project: ImportedProject) {
    const projectKey = await sha(`project|${project.sourceId ?? norm(project.name)}`);
    const sectionSeen = new Map<string, number>();
    const sectionKeys: string[] = [];
    for (const s of project.sections) {
        const n = (sectionSeen.get(norm(s.name)) ?? 0) + 1;
        sectionSeen.set(norm(s.name), n);
        sectionKeys.push(await sha(`${projectKey}|section|${norm(s.name)}|${n}`));
    }
    const siblingSeen = new Map<string, number>();
    const paths: string[] = [];
    const taskKeys: string[] = [];
    const hashes: string[] = [];
    for (const [i, t] of project.tasks.entries()) {
        const parentPath = t.parent === null ? "" : paths[t.parent];
        const where = `${t.section === null ? "-" : sectionKeys[t.section]}|${parentPath}`;
        const n = (siblingSeen.get(`${where}|${norm(t.title)}`) ?? 0) + 1;
        siblingSeen.set(`${where}|${norm(t.title)}`, n);
        paths[i] = `${parentPath}/${norm(t.title)}#${n}`;
        taskKeys.push(await sha(`${projectKey}|task|${where}|${norm(t.title)}|${n}`));
        hashes.push(
            await sha(JSON.stringify([t.title, t.description, t.priority, t.dueDate, t.dueTime, t.recurrence, t.deadline, [...t.labels].sort(), t.comments])),
        );
    }
    return { projectKey, sectionKeys, taskKeys, hashes };
}

/** A fingerprint of the files themselves, recorded on each import batch. */
export const fileFingerprint = (files: { name: string; text: string }[]) =>
    sha(
        files
            .map((f) => `${f.name}\n${f.text}`)
            .sort()
            .join("\n\u0000\n"),
    );
