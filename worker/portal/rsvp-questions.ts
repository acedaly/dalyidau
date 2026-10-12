import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { QUESTION_TYPES, type QuestionSummary, type RsvpQuestion } from "../../src/shared/portal/types";
import { auditStatement, newId, nowIso, parseJson } from "./db";
import { NotFoundError, ValidationError } from "./entities";

const conditionSchema = z
    .object({ questionId: z.string().max(40), equals: z.string().trim().min(1).max(200) })
    .nullable()
    .default(null);

const questionSchema = z
    .object({
        label: z.string().trim().min(1, "Question is required").max(300),
        help: z.string().trim().max(500).nullable().optional(),
        type: z.enum(QUESTION_TYPES),
        options: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
        required: z.boolean().default(false),
        scope: z.enum(["guest", "household"]).default("guest"),
        audience: z.enum(["all", "adult", "child"]).default("all"),
        eventId: z.string().max(40).nullable().default(null),
        condition: conditionSchema,
        published: z.boolean().default(false),
        sortOrder: z.number().int().min(0).max(10_000).default(0),
        archived: z.boolean().default(false),
        updatedAt: z.string().optional(),
    })
    .superRefine((value, ctx) => {
        const choices = value.type === "single_choice" || value.type === "multiple_choice";
        if (choices && value.options.length < 2) ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least two options" });
        if (!choices && value.options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "This question type does not use options" });
        if (new Set(value.options.map((option) => option.toLocaleLowerCase())).size !== value.options.length)
            ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
        if (value.scope === "household" && value.audience !== "all")
            ctx.addIssue({ code: "custom", path: ["audience"], message: "Household questions apply to everyone" });
    });

const fromRow = (row: Record<string, unknown>): RsvpQuestion => ({
    id: row.id as string,
    label: row.label as string,
    help: (row.help as string | null) ?? null,
    type: row.type as RsvpQuestion["type"],
    options: parseJson<string[]>(row.options, []),
    required: !!row.required,
    scope: row.scope as RsvpQuestion["scope"],
    audience: row.audience as RsvpQuestion["audience"],
    eventId: (row.event_id as string | null) ?? null,
    condition: parseJson(row.condition, null),
    published: !!row.published,
    sortOrder: Number(row.sort_order),
    version: Number(row.version),
    archived: !!row.archived,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
});

export async function listQuestions(db: D1Database, publicOnly = false) {
    const rows = await db
        .prepare(`SELECT * FROM rsvp_questions ${publicOnly ? "WHERE published = 1 AND archived = 0" : ""} ORDER BY sort_order, created_at`)
        .all<Record<string, unknown>>();
    return rows.results.map(fromRow);
}

export async function saveQuestion(db: D1Database, id: string | null, input: unknown, actor: string) {
    const data = questionSchema.parse(input);
    if (data.condition?.questionId === id) throw new ValidationError("A question cannot depend on itself", "condition");
    if (data.eventId) {
        const event = await db.prepare("SELECT id FROM events WHERE id = ?").bind(data.eventId).first();
        if (!event) throw new ValidationError("Choose an existing event", "eventId");
    }
    if (data.condition) {
        const parent = await db.prepare("SELECT id, type, options FROM rsvp_questions WHERE id = ? AND archived = 0").bind(data.condition.questionId).first<{
            id: string;
            type: RsvpQuestion["type"];
            options: string;
        }>();
        if (!parent) throw new ValidationError("Choose an active question", "condition");
        const allowed = parent.type === "yes_no" ? ["yes", "no"] : parseJson<string[]>(parent.options, []);
        if (!allowed.some((option) => option.toLocaleLowerCase() === data.condition!.equals.toLocaleLowerCase()))
            throw new ValidationError("Choose one of the parent question's answers", "condition");
    }

    const now = nowIso();
    if (!id) {
        id = newId("que");
        await db.batch([
            db
                .prepare(
                    `INSERT INTO rsvp_questions
                     (id, label, help, type, options, required, scope, audience, event_id, condition, published, sort_order, version, archived, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
                )
                .bind(
                    id,
                    data.label,
                    data.help ?? null,
                    data.type,
                    JSON.stringify(data.options),
                    data.required ? 1 : 0,
                    data.scope,
                    data.scope === "household" ? "all" : data.audience,
                    data.eventId,
                    data.condition ? JSON.stringify(data.condition) : null,
                    data.published ? 1 : 0,
                    data.sortOrder,
                    data.archived ? 1 : 0,
                    now,
                    now,
                ),
            auditStatement(db, {
                actor,
                action: "rsvp.question.create",
                entityType: "rsvp_question",
                entityId: id,
                summary: `Created RSVP question “${data.label}”`,
            }),
        ]);
    } else {
        const row = await db.prepare("SELECT * FROM rsvp_questions WHERE id = ?").bind(id).first<Record<string, unknown>>();
        if (!row) throw new NotFoundError("Question not found");
        if (data.updatedAt && data.updatedAt !== row.updated_at)
            throw new ValidationError("Someone else changed this question. Refresh and try again.", "updatedAt");
        const before = fromRow(row);
        const revisionChanged =
            before.label !== data.label ||
            before.help !== (data.help ?? null) ||
            before.type !== data.type ||
            JSON.stringify(before.options) !== JSON.stringify(data.options) ||
            before.required !== data.required ||
            before.scope !== data.scope ||
            before.audience !== (data.scope === "household" ? "all" : data.audience) ||
            before.eventId !== data.eventId ||
            JSON.stringify(before.condition) !== JSON.stringify(data.condition);
        await db.batch([
            db
                .prepare(
                    `UPDATE rsvp_questions SET label = ?, help = ?, type = ?, options = ?, required = ?, scope = ?, audience = ?, event_id = ?,
                     condition = ?, published = ?, sort_order = ?, version = version + ?, archived = ?, updated_at = ? WHERE id = ?`,
                )
                .bind(
                    data.label,
                    data.help ?? null,
                    data.type,
                    JSON.stringify(data.options),
                    data.required ? 1 : 0,
                    data.scope,
                    data.scope === "household" ? "all" : data.audience,
                    data.eventId,
                    data.condition ? JSON.stringify(data.condition) : null,
                    data.published ? 1 : 0,
                    data.sortOrder,
                    revisionChanged ? 1 : 0,
                    data.archived ? 1 : 0,
                    now,
                    id,
                ),
            auditStatement(db, {
                actor,
                action: "rsvp.question.update",
                entityType: "rsvp_question",
                entityId: id,
                summary: `Updated RSVP question “${data.label}”${revisionChanged ? ` to version ${before.version + 1}` : ""}`,
            }),
        ]);
    }
    return fromRow((await db.prepare("SELECT * FROM rsvp_questions WHERE id = ?").bind(id).first<Record<string, unknown>>())!);
}

export async function archiveQuestion(db: D1Database, id: string, actor: string) {
    const question = await db.prepare("SELECT label FROM rsvp_questions WHERE id = ?").bind(id).first<{ label: string }>();
    if (!question) throw new NotFoundError("Question not found");
    await db.batch([
        db.prepare("UPDATE rsvp_questions SET archived = 1, published = 0, updated_at = ? WHERE id = ?").bind(nowIso(), id),
        auditStatement(db, {
            actor,
            action: "rsvp.question.archive",
            entityType: "rsvp_question",
            entityId: id,
            summary: `Archived RSVP question “${question.label}”`,
        }),
    ]);
}

export async function questionSummaries(db: D1Database): Promise<QuestionSummary[]> {
    const [questions, answers] = await Promise.all([
        listQuestions(db),
        db
            .prepare(
                `SELECT a.question_id, a.value, a.question_version,
                        CASE WHEN a.guest_id = '' THEN h.name ELSE trim(g.first_name || ' ' || g.last_name) END AS who
                 FROM rsvp_answers a JOIN households h ON h.id = a.household_id
                 LEFT JOIN guests g ON g.id = a.guest_id ORDER BY a.answered_at DESC`,
            )
            .all<{ question_id: string; value: string; question_version: number; who: string }>(),
    ]);
    return questions.map((question) => {
        const rows = answers.results.filter((answer) => answer.question_id === question.id);
        const counts = new Map<string, number>();
        let total: number | null = question.type === "number" ? 0 : null;
        const responses: QuestionSummary["responses"] = [];
        for (const row of rows) {
            const value = parseJson<unknown>(row.value, null);
            if (typeof value === "number" && total !== null) total += value;
            for (const option of Array.isArray(value) ? value : [value]) {
                if (typeof option === "string" && ["yes_no", "single_choice", "multiple_choice"].includes(question.type))
                    counts.set(option, (counts.get(option) ?? 0) + 1);
            }
            if (["short_text", "long_text", "date", "number"].includes(question.type) && value !== null)
                responses.push({ who: row.who, value: Array.isArray(value) ? value.join(", ") : String(value), version: row.question_version });
        }
        return { question, answered: rows.length, counts: [...counts].map(([option, count]) => ({ option, count })), total, responses };
    });
}
