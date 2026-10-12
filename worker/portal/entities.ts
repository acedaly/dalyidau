// A small, explicit CRUD layer. Each entity declares its table, its columns (camelCase field →
// snake_case column) and a zod schema. Every write is validated and recorded in the audit log in
// the same D1 batch as the change itself.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { FlagKey } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import { MESSAGE_CATEGORIES } from "../../src/shared/portal/types";
import type { BudgetItem, CustomField, Household, MessageTemplate, Supplier, Task, TimelineItem, WeddingEvent } from "../../src/shared/portal/types";
import { auditIfChanged, auditStatement, diff, newId, newRsvpCode, nowIso, parseJson } from "./db";
import { redactChanges, redactSnapshot } from "./redact";

type ColumnKind = "text" | "int" | "bool" | "json";

export interface EntityDef<T> {
    /** Audit entity type and API path segment, e.g. "household". */
    type: string;
    /** Human noun for audit summaries. */
    noun: string;
    table: string;
    idPrefix: string;
    columns: Record<string, { column: string; kind?: ColumnKind }>;
    create: z.ZodObject<z.ZodRawShape>;
    /** Optional SELECT with extra computed columns. Must alias the table as "t". */
    select?: string;
    /** Extra fields read from computed columns. */
    extra?: (row: Record<string, unknown>) => Partial<T>;
    orderBy: string;
    title: (entity: T) => string;
    read: Permission;
    write: Permission;
    flag?: FlagKey;
    /** Fields set on create that the client cannot supply. */
    onCreate?: () => Record<string, unknown>;
    /** Server-derived fields, given the validated input and the current row (null on create). */
    derive?: (data: Record<string, unknown>, before: T | null) => Record<string, unknown>;
    /** Cross-field checks on the merged record. Return an error message to reject. */
    validate?: (merged: Record<string, unknown>) => { path: string; message: string } | null;
    /** Fields that can be set on create but never changed. */
    immutable?: string[];
    /** SQL condition (on alias "t") that hides rows from lists, e.g. soft-deleted ones. */
    listWhere?: string;
    /** Delete through a dedicated soft-delete route instead of the generic one. */
    softDelete?: boolean;
}

/** Another person saved the record after this one was opened. */
export class ConflictError extends Error {}

/** Reads and removes the optimistic-concurrency token a client may send with an update. */
export const takeExpectedVersion = (input: unknown): string | null => {
    if (!input || typeof input !== "object") return null;
    const value = (input as Record<string, unknown>).expectedUpdatedAt;
    delete (input as Record<string, unknown>).expectedUpdatedAt;
    return typeof value === "string" ? value : null;
};

export const CONFLICT_MESSAGE = "Someone else changed this after you opened it. Close it and open it again to see their changes.";

export class ValidationError extends Error {
    constructor(
        message: string,
        readonly path: string,
    ) {
        super(message);
    }
}

export class NotFoundError extends Error {}

const opt = <S extends z.ZodTypeAny>(schema: S) => schema.nullable().optional();
const str = (max: number) => z.string().trim().max(max);
const optStr = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .transform((v) => (v === "" ? null : v))
        .nullable()
        .optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use YYYY-MM-DDTHH:MM");
const cents = z.number().int().min(0).max(10_000_000_00);
const email = z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .transform((v) => (v === "" ? null : v))
    .pipe(z.email().nullable())
    .nullable()
    .optional();
const httpUrl = z
    .string()
    .trim()
    .max(500)
    .transform((v) => (v === "" ? null : v))
    .pipe(
        z
            .url()
            .refine((u) => /^https?:\/\//.test(u), "Use an http(s) link")
            .nullable(),
    )
    .nullable()
    .optional();

export const fields = { opt, str, optStr, date, dateTime, cents, email, httpUrl };

export function toEntity<T>(def: EntityDef<T>, row: Record<string, unknown>): T {
    const out: Record<string, unknown> = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
    for (const [field, { column, kind }] of Object.entries(def.columns)) {
        const value = row[column];
        if (kind === "bool") out[field] = value === 1 || value === true;
        else if (kind === "json") out[field] = parseJson(value, null);
        else out[field] = value ?? null;
    }
    return { ...(out as T), ...(def.extra?.(row) ?? {}) };
}

const toColumnValue = (kind: ColumnKind | undefined, value: unknown) => {
    if (value === undefined) return undefined;
    if (kind === "bool") return value ? 1 : 0;
    if (kind === "json") return JSON.stringify(value ?? null);
    return value ?? null;
};

const selectSql = (def: EntityDef<unknown>) => def.select ?? `SELECT t.* FROM ${def.table} t`;

export async function listEntities<T>(db: D1Database, def: EntityDef<T>): Promise<T[]> {
    const where = def.listWhere ? ` WHERE ${def.listWhere}` : "";
    const rows = await db.prepare(`${selectSql(def as EntityDef<unknown>)}${where} ORDER BY ${def.orderBy}`).all<Record<string, unknown>>();
    return rows.results.map((row) => toEntity(def, row));
}

export async function getEntity<T>(db: D1Database, def: EntityDef<T>, id: string): Promise<T | null> {
    const row = await db
        .prepare(`${selectSql(def as EntityDef<unknown>)} WHERE t.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
    return row ? toEntity(def, row) : null;
}

export async function createEntity<T extends { id: string }>(db: D1Database, def: EntityDef<T>, input: unknown, actor: string): Promise<T> {
    const parsed = def.create.parse(input) as Record<string, unknown>;
    const data = { ...parsed, ...(def.onCreate?.() ?? {}), ...(def.derive?.(parsed, null) ?? {}) };
    const problem = def.validate?.(data);
    if (problem) throw new ValidationError(problem.message, problem.path);
    const id = newId(def.idPrefix);
    const now = nowIso();
    const columns = ["id", "created_at", "updated_at"];
    const values: unknown[] = [id, now, now];
    for (const [field, { column, kind }] of Object.entries(def.columns)) {
        const value = toColumnValue(kind, data[field]);
        if (value === undefined) continue;
        columns.push(column);
        values.push(value);
    }
    const created = { ...data, id } as Record<string, unknown>;
    await db.batch([
        db.prepare(`INSERT INTO ${def.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...values),
        auditStatement(db, {
            actor,
            action: `${def.type}.create`,
            entityType: def.type,
            entityId: id,
            summary: `Added ${def.noun} “${def.title(created as T)}”`,
        }),
    ]);
    const entity = await getEntity(db, def, id);
    if (!entity) throw new Error("Insert did not persist");
    return entity;
}

export async function updateEntity<T extends { id: string }>(db: D1Database, def: EntityDef<T>, id: string, input: unknown, actor: string): Promise<T> {
    const expected = takeExpectedVersion(input);
    const before = await getEntity(db, def, id);
    if (!before) throw new NotFoundError(`${def.noun} not found`);
    if (expected && expected !== (before as { updatedAt?: string }).updatedAt) throw new ConflictError(CONFLICT_MESSAGE);
    // zod 4 applies defaults inside .partial(), so keep only the keys the client actually sent.
    const sent = new Set(input && typeof input === "object" ? Object.keys(input) : []);
    for (const field of def.immutable ?? []) sent.delete(field);
    const parsed = def.create.partial().parse(input) as Record<string, unknown>;
    const patch = Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.has(key)));
    Object.assign(patch, def.derive?.(patch, before) ?? {});
    const problem = def.validate?.({ ...(before as Record<string, unknown>), ...patch });
    if (problem) throw new ValidationError(problem.message, problem.path);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, { column, kind }] of Object.entries(def.columns)) {
        if (!(field in patch)) continue;
        const value = toColumnValue(kind, patch[field]);
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value);
    }
    const changes = diff(
        before as Record<string, unknown>,
        Object.fromEntries(
            Object.keys(patch)
                .filter((k) => k in def.columns)
                .map((k) => [k, patch[k]]),
        ),
    );
    if (sets.length === 0 || Object.keys(changes).length === 0) return before;
    sets.push("updated_at = ?");
    values.push(nowIso());
    // The update only applies if nobody saved in between (compare-and-set on updated_at); the audit
    // entry is only written if it did.
    const [result] = await db.batch([
        db
            .prepare(`UPDATE ${def.table} SET ${sets.join(", ")} WHERE id = ? AND updated_at = ?`)
            .bind(...values, id, (before as unknown as { updatedAt: string }).updatedAt),
        auditIfChanged(db, {
            actor,
            action: `${def.type}.update`,
            entityType: def.type,
            entityId: id,
            summary: `Updated ${def.noun} “${def.title({ ...before, ...patch } as T)}”`,
            changes: redactChanges(changes),
        }),
    ]);
    if (!result.meta.changes) throw new ConflictError(CONFLICT_MESSAGE);
    return (await getEntity(db, def, id))!;
}

export async function deleteEntity<T extends { id: string }>(db: D1Database, def: EntityDef<T>, id: string, actor: string): Promise<void> {
    const before = await getEntity(db, def, id);
    if (!before) throw new NotFoundError(`${def.noun} not found`);
    await db.batch([
        db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).bind(id),
        auditStatement(db, {
            actor,
            action: `${def.type}.delete`,
            entityType: def.type,
            entityId: id,
            summary: `Deleted ${def.noun} “${def.title(before)}”`,
            // A snapshot (without personal values) so a mistaken delete can be re-entered by hand.
            changes: { deleted: redactSnapshot(before as Record<string, unknown>) },
        }),
    ]);
}

export const householdDef: EntityDef<Household> = {
    type: "household",
    noun: "household",
    table: "households",
    idPrefix: "hh",
    columns: {
        name: { column: "name" },
        rsvpCode: { column: "rsvp_code" },
        email: { column: "email" },
        phone: { column: "phone" },
        addressLine1: { column: "address_line1" },
        addressLine2: { column: "address_line2" },
        locality: { column: "locality" },
        region: { column: "region" },
        postcode: { column: "postcode" },
        country: { column: "country" },
        notes: { column: "notes" },
        inviteVersion: { column: "invite_version" },
        inviteRevokedAt: { column: "invite_revoked_at" },
    },
    create: z.object({
        name: str(120).min(1, "Name is required"),
        email,
        phone: optStr(40),
        addressLine1: optStr(200),
        addressLine2: optStr(200),
        locality: optStr(100),
        region: optStr(100),
        postcode: optStr(20),
        country: optStr(100),
        notes: optStr(4000),
    }),
    select: "SELECT t.*, (SELECT COUNT(*) FROM guests g WHERE g.household_id = t.id AND g.deleted_at IS NULL) AS guest_count FROM households t",
    listWhere: "t.deleted_at IS NULL",
    softDelete: true,
    extra: (row) => ({
        guestCount: Number(row.guest_count ?? 0),
        // Set by the importer and bulk invitation generation, never by the household form.
        externalId: (row.external_id as string | null) ?? null,
        invitationGeneratedAt: (row.invitation_generated_at as string | null) ?? null,
    }),
    orderBy: "t.name COLLATE NOCASE",
    title: (h) => h.name,
    read: "wedding.view",
    write: "wedding.guests.edit",
    onCreate: () => ({ rsvpCode: newRsvpCode() }),
};

export const eventDef: EntityDef<WeddingEvent> = {
    type: "event",
    noun: "event",
    table: "events",
    idPrefix: "evt",
    columns: {
        name: { column: "name" },
        startsAt: { column: "starts_at" },
        endsAt: { column: "ends_at" },
        venueName: { column: "venue_name" },
        address: { column: "address" },
        description: { column: "description" },
        dressCode: { column: "dress_code" },
        isPublic: { column: "is_public", kind: "bool" },
        rsvpEnabled: { column: "rsvp_enabled", kind: "bool" },
        sortOrder: { column: "sort_order", kind: "int" },
    },
    create: z.object({
        name: str(120).min(1, "Name is required"),
        startsAt: opt(dateTime),
        endsAt: opt(dateTime),
        venueName: optStr(200),
        address: optStr(400),
        description: optStr(4000),
        dressCode: optStr(200),
        isPublic: z.boolean().default(true),
        rsvpEnabled: z.boolean().default(true),
        sortOrder: z.number().int().min(0).max(1000).default(0),
    }),
    orderBy: "t.sort_order, t.starts_at, t.name",
    title: (e) => e.name,
    read: "wedding.view",
    write: "wedding.guests.edit",
};

export const customFieldDef: EntityDef<CustomField> = {
    type: "custom_field",
    noun: "custom field",
    table: "custom_fields",
    idPrefix: "cf",
    columns: {
        entity: { column: "entity" },
        key: { column: "key" },
        label: { column: "label" },
        type: { column: "type" },
        options: { column: "options", kind: "json" },
        help: { column: "help" },
        showInTable: { column: "show_in_table", kind: "bool" },
        sortOrder: { column: "sort_order", kind: "int" },
        archived: { column: "archived", kind: "bool" },
    },
    create: z.object({
        entity: z.literal("guest").default("guest"),
        key: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_]{0,39}$/, "Lower-case letters, digits and underscores, starting with a letter"),
        label: str(80).min(1, "Label is required"),
        type: z.enum(["text", "number", "boolean", "select", "date"]),
        options: z.array(str(80).min(1)).max(50).default([]),
        help: optStr(200),
        showInTable: z.boolean().default(false),
        sortOrder: z.number().int().min(0).max(1000).default(0),
        archived: z.boolean().default(false),
    }),
    validate: (f) =>
        f.type === "select" && !(Array.isArray(f.options) && f.options.length > 0)
            ? { path: "options", message: "A select field needs at least one option" }
            : null,
    // Stored values are keyed by `key` and interpreted by `type`, so neither can change later.
    immutable: ["key", "type", "entity"],
    orderBy: "t.archived, t.sort_order, t.label",
    title: (f) => f.label,
    read: "wedding.view",
    write: "portal.settings.manage",
};

export const templateDef: EntityDef<MessageTemplate> = {
    type: "template",
    noun: "template",
    table: "message_templates",
    idPrefix: "tpl",
    columns: { name: { column: "name" }, subject: { column: "subject" }, body: { column: "body" }, category: { column: "category" } },
    create: z.object({
        name: str(120).min(1, "Name is required"),
        subject: str(200).min(1, "Subject is required"),
        body: str(20_000).min(1, "Body is required"),
        category: z.enum(MESSAGE_CATEGORIES).default("update"),
    }),
    orderBy: "t.name COLLATE NOCASE",
    title: (t) => t.name,
    read: "wedding.view",
    write: "wedding.comms.edit",
    flag: "module.communications",
};

export const taskDef: EntityDef<Task> = {
    type: "task",
    noun: "task",
    table: "tasks",
    idPrefix: "tsk",
    columns: {
        title: { column: "title" },
        notes: { column: "notes" },
        status: { column: "status" },
        priority: { column: "priority" },
        category: { column: "category" },
        dueDate: { column: "due_date" },
        assignee: { column: "assignee" },
        completedAt: { column: "completed_at" },
    },
    create: z.object({
        title: str(200).min(1, "Title is required"),
        notes: optStr(4000),
        status: z.enum(["todo", "in_progress", "done"]).default("todo"),
        priority: z.enum(["low", "medium", "high"]).default("medium"),
        category: optStr(80),
        dueDate: opt(date),
        assignee: email,
    }),
    derive: (data, before) => {
        if (!("status" in data)) return {};
        if (data.status === "done") return { completedAt: before?.completedAt ?? nowIso() };
        return { completedAt: null };
    },
    orderBy:
        "CASE t.status WHEN 'done' THEN 1 ELSE 0 END, t.due_date IS NULL, t.due_date, CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.created_at",
    title: (t) => t.title,
    read: "wedding.view",
    write: "wedding.planning.edit",
    flag: "module.planning",
};

export const timelineDef: EntityDef<TimelineItem> = {
    type: "timeline_item",
    noun: "timeline item",
    table: "timeline_items",
    idPrefix: "tli",
    columns: {
        startsAt: { column: "starts_at" },
        endsAt: { column: "ends_at" },
        title: { column: "title" },
        location: { column: "location" },
        owner: { column: "owner" },
        notes: { column: "notes" },
    },
    create: z.object({
        startsAt: dateTime,
        endsAt: opt(dateTime),
        title: str(200).min(1, "Title is required"),
        location: optStr(200),
        owner: optStr(120),
        notes: optStr(2000),
    }),
    orderBy: "t.starts_at, t.title",
    title: (t) => t.title,
    read: "wedding.view",
    write: "wedding.planning.edit",
    flag: "module.planning",
};

export const supplierDef: EntityDef<Supplier> = {
    type: "supplier",
    noun: "supplier",
    table: "suppliers",
    idPrefix: "sup",
    columns: {
        name: { column: "name" },
        category: { column: "category" },
        status: { column: "status" },
        contactName: { column: "contact_name" },
        email: { column: "email" },
        phone: { column: "phone" },
        website: { column: "website" },
        notes: { column: "notes" },
    },
    create: z.object({
        name: str(160).min(1, "Name is required"),
        category: optStr(80),
        status: z.enum(["researching", "quoted", "booked", "cancelled"]).default("researching"),
        contactName: optStr(120),
        email,
        phone: optStr(40),
        website: httpUrl,
        notes: optStr(4000),
    }),
    orderBy: "t.name COLLATE NOCASE",
    title: (s) => s.name,
    read: "wedding.budget.view",
    write: "wedding.budget.edit",
    flag: "module.budget",
};

export const budgetItemDef: EntityDef<BudgetItem> = {
    type: "budget_item",
    noun: "budget item",
    table: "budget_items",
    idPrefix: "bud",
    columns: {
        category: { column: "category" },
        description: { column: "description" },
        supplierId: { column: "supplier_id" },
        estimatedCents: { column: "estimated_cents", kind: "int" },
        actualCents: { column: "actual_cents", kind: "int" },
        paidCents: { column: "paid_cents", kind: "int" },
        dueDate: { column: "due_date" },
        notes: { column: "notes" },
    },
    create: z.object({
        category: str(80).min(1, "Category is required"),
        description: str(200).min(1, "Description is required"),
        supplierId: opt(z.string().max(40)),
        estimatedCents: cents.default(0),
        actualCents: opt(cents),
        paidCents: cents.default(0),
        dueDate: opt(date),
        notes: optStr(2000),
    }),
    select: "SELECT t.*, s.name AS supplier_name FROM budget_items t LEFT JOIN suppliers s ON s.id = t.supplier_id",
    extra: (row) => ({ supplierName: (row.supplier_name as string | null) ?? null }),
    orderBy: "t.category COLLATE NOCASE, t.due_date IS NULL, t.due_date, t.description",
    title: (b) => b.description,
    read: "wedding.budget.view",
    write: "wedding.budget.edit",
    flag: "module.budget",
};

export const ENTITY_DEFS = {
    households: householdDef,
    events: eventDef,
    "custom-fields": customFieldDef,
    templates: templateDef,
    tasks: taskDef,
    timeline: timelineDef,
    suppliers: supplierDef,
    "budget-items": budgetItemDef,
} as const;
