import type { D1Database } from "@cloudflare/workers-types";
import type { Flags } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import { formatMobile } from "../../src/shared/portal/phone";
import { needsSeat } from "../../src/shared/portal/seating";
import { BUS_SHORT_LABELS, FOLLOW_UP_LABELS, STAY_LABELS } from "../../src/shared/portal/travel";
import type { AuditEntry, BudgetItem, Guest, Household, Supplier, Task } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { cateringSummary } from "./catering";
import { type CsvColumn, toCsv } from "./csv";
import { parseJson } from "./db";
import { budgetItemDef, customFieldDef, eventDef, householdDef, listEntities, supplierDef, taskDef } from "./entities";
import { listGuests } from "./guests";
import { invitationsCsv } from "./households";
import { seatingState } from "./seating";
import { getSettings } from "./settings";
import { travelOverview } from "./travel";

const money = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

const PORTAL_EXPORT_TABLES = [
    "portal_users",
    "audit_log",
    "feature_flags",
    "settings",
    "dashboard_layouts",
    "households",
    "guests",
    "events",
    "guest_events",
    "guest_imports",
    "guest_import_rows",
    "custom_fields",
    "rsvp_submissions",
    "rsvp_questions",
    "rsvp_answers",
    "rsvp_travel",
    "message_templates",
    "messages",
    "message_recipients",
    "tasks",
    "timeline_items",
    "suppliers",
    "budget_items",
    "seating_tables",
    "seat_assignments",
    "seating_snapshots",
    "website_media",
] as const;

/** Complete portable portal export. Rate-limit hashes and blog/sync data are intentionally excluded. */
export async function fullJsonExport(db: D1Database) {
    const results = await db.batch(PORTAL_EXPORT_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`)));
    return {
        format: "dalyidau-wedding-portal",
        version: 1,
        exportedAt: new Date().toISOString(),
        tables: Object.fromEntries(PORTAL_EXPORT_TABLES.map((table, index) => [table, results[index].results])),
    };
}

export interface ExportDef {
    label: string;
    permission: Permission;
    flag?: keyof Flags;
    build: (db: D1Database, env: Env) => Promise<string>;
}

export const EXPORTS: Record<string, ExportDef> = {
    invitations: {
        label: "Household invitations",
        permission: "wedding.export",
        build: (_db, env) => invitationsCsv(env),
    },
    guests: {
        label: "Guests",
        permission: "wedding.export",
        async build(db) {
            const [guests, events, custom, wedding] = await Promise.all([
                listGuests(db),
                listEntities(db, eventDef),
                listEntities(db, customFieldDef),
                getSettings(db, "wedding"),
            ]);
            const sideLabel = { partner_one: wedding.partnerOne, partner_two: wedding.partnerTwo, shared: "Both" };
            const columns: CsvColumn<Guest>[] = [
                { header: "First name", value: (g) => g.firstName },
                { header: "Last name", value: (g) => g.lastName },
                { header: "Email", value: (g) => g.email },
                { header: "Phone", value: (g) => formatMobile(g.phone) },
                { header: "Household", value: (g) => g.householdName },
                { header: "Side", value: (g) => sideLabel[g.side] },
                { header: "Group", value: (g) => g.groupName },
                { header: "Age group", value: (g) => g.ageGroup },
                { header: "Plus one", value: (g) => g.isPlusOne },
                { header: "RSVP", value: (g) => g.rsvp },
                ...events.map((e) => ({ header: e.name, value: (g: Guest) => g.events.find((s) => s.eventId === e.id)?.status ?? "not invited" })),
                { header: "Dietary", value: (g) => g.dietary },
                { header: "Accessibility", value: (g) => g.accessibility },
                { header: "Tags", value: (g) => g.tags.join("; ") },
                { header: "Notes", value: (g) => g.notes },
                ...custom.filter((f) => !f.archived).map((f) => ({ header: f.label, value: (g: Guest) => g.custom[f.key] ?? null })),
            ];
            return toCsv(guests, columns);
        },
    },
    households: {
        label: "Households and RSVP codes",
        permission: "wedding.export",
        async build(db) {
            const households = await listEntities(db, householdDef);
            const columns: CsvColumn<Household>[] = [
                { header: "Household", value: (h) => h.name },
                { header: "RSVP code", value: (h) => h.rsvpCode },
                { header: "Guests", value: (h) => h.guestCount },
                { header: "Email", value: (h) => h.email },
                { header: "Phone", value: (h) => formatMobile(h.phone) },
                { header: "Address line 1", value: (h) => h.addressLine1 },
                { header: "Address line 2", value: (h) => h.addressLine2 },
                { header: "Suburb / town", value: (h) => h.locality },
                { header: "State", value: (h) => h.region },
                { header: "Postcode", value: (h) => h.postcode },
                { header: "Country", value: (h) => h.country },
                { header: "Notes", value: (h) => h.notes },
            ];
            return toCsv(households, columns);
        },
    },
    rsvps: {
        label: "RSVP responses",
        permission: "wedding.export",
        async build(db) {
            const [guests, events] = await Promise.all([listGuests(db), listEntities(db, eventDef)]);
            const eventName = new Map(events.map((e) => [e.id, e.name]));
            const rows = guests.flatMap((g) => g.events.map((e) => ({ guest: g, event: e })));
            return toCsv(rows, [
                { header: "Guest", value: (r) => `${r.guest.firstName} ${r.guest.lastName}`.trim() },
                { header: "Household", value: (r) => r.guest.householdName },
                { header: "Event", value: (r) => eventName.get(r.event.eventId) ?? r.event.eventId },
                { header: "Status", value: (r) => r.event.status },
                { header: "Source", value: (r) => r.event.source },
                { header: "Responded at", value: (r) => r.event.respondedAt },
                { header: "Dietary", value: (r) => r.guest.dietary },
            ]);
        },
    },
    transport: {
        label: "Courtesy bus and accommodation",
        permission: "wedding.export",
        async build(db) {
            const overview = await travelOverview(db);
            return toCsv(overview.households, [
                { header: "Household", value: (r) => r.householdName },
                { header: "Guests attending", value: (r) => r.attending },
                { header: "Email", value: (r) => r.email },
                { header: "Phone", value: (r) => formatMobile(r.phone) },
                { header: "Courtesy bus", value: (r) => (r.travel?.bus ? BUS_SHORT_LABELS[r.travel.bus] : "Not answered") },
                { header: "To Rhino Lodge (passengers)", value: (r) => r.outbound },
                { header: "Home after (passengers)", value: (r) => r.return },
                { header: "Staying", value: (r) => (r.travel?.stay ? STAY_LABELS[r.travel.stay] : "") },
                { header: "Accommodation name or location", value: (r) => r.travel?.stayLocation },
                { header: "Follow up", value: (r) => r.followUp.map((reason) => FOLLOW_UP_LABELS[reason]).join("; ") },
                { header: "Answered", value: (r) => (r.source === "manual" ? "Entered by hand" : r.source === "native" ? "Online RSVP" : "") },
                { header: "Updated at", value: (r) => r.updatedAt },
            ]);
        },
    },
    seating: {
        label: "Seating plan",
        permission: "wedding.export",
        flag: "module.planning",
        async build(db) {
            const state = await seatingState(db);
            const order = new Map(state.tables.map((t, i) => [t.id, i]));
            const tableName = new Map(state.tables.map((t) => [t.id, t.name]));
            const category = new Map(state.categories.map((c) => [c.id, c.label]));
            const rows = [...state.guests]
                .filter((g) => g.tableId || needsSeat(g))
                .sort(
                    (a, b) =>
                        (a.tableId ? (order.get(a.tableId) ?? 999) : 1000) - (b.tableId ? (order.get(b.tableId) ?? 999) : 1000) || a.position - b.position,
                );
            return toCsv(rows, [
                { header: "Table", value: (g) => (g.tableId ? tableName.get(g.tableId) : "Not seated") },
                { header: "Seat order", value: (g) => (g.tableId ? g.position + 1 : null) },
                { header: "Guest", value: (g) => g.name },
                { header: "Household", value: (g) => g.householdName },
                { header: "Age group", value: (g) => g.ageGroup },
                { header: "RSVP", value: (g) => g.status },
                { header: "Meal", value: (g) => (g.mealCategory ? category.get(g.mealCategory) : "") },
                { header: "Dietary", value: (g) => g.dietary },
                { header: "Allergies", value: (g) => g.allergies },
            ]);
        },
    },
    catering: {
        label: "Catering list",
        permission: "wedding.export",
        flag: "module.planning",
        async build(db) {
            const summary = await cateringSummary(db);
            const label = new Map(summary.settings.categories.map((c) => [c.id, c.label]));
            return toCsv(summary.guests, [
                { header: "Guest", value: (g) => g.name },
                { header: "Household", value: (g) => g.householdName },
                { header: "RSVP", value: (g) => g.status },
                { header: "Age group", value: (g) => g.ageGroup },
                { header: "Meal", value: (g) => (g.category ? label.get(g.category) : "Needs a decision") },
                { header: "Meal chosen or default", value: (g) => (g.chosen ? "chosen" : g.category ? "default" : "") },
                { header: "Dietary", value: (g) => g.dietary },
                { header: "Allergies", value: (g) => g.allergies },
                { header: "Table", value: (g) => g.tableName },
            ]);
        },
    },
    tasks: {
        label: "Tasks",
        permission: "wedding.export",
        flag: "module.planning",
        async build(db) {
            const tasks = await listEntities(db, taskDef);
            const columns: CsvColumn<Task>[] = [
                { header: "Title", value: (t) => t.title },
                { header: "Status", value: (t) => t.status },
                { header: "Priority", value: (t) => t.priority },
                { header: "Category", value: (t) => t.category },
                { header: "Due", value: (t) => t.dueDate },
                { header: "Assignee", value: (t) => t.assignee },
                { header: "Completed", value: (t) => t.completedAt },
                { header: "Notes", value: (t) => t.notes },
            ];
            return toCsv(tasks, columns);
        },
    },
    budget: {
        label: "Budget",
        permission: "wedding.budget.view",
        flag: "module.budget",
        async build(db) {
            const items = await listEntities(db, budgetItemDef);
            const columns: CsvColumn<BudgetItem>[] = [
                { header: "Category", value: (b) => b.category },
                { header: "Description", value: (b) => b.description },
                { header: "Supplier", value: (b) => b.supplierName },
                { header: "Estimated", value: (b) => money(b.estimatedCents) },
                { header: "Actual", value: (b) => money(b.actualCents) },
                { header: "Paid", value: (b) => money(b.paidCents) },
                { header: "Outstanding", value: (b) => money(Math.max((b.actualCents ?? b.estimatedCents) - b.paidCents, 0)) },
                { header: "Due", value: (b) => b.dueDate },
                { header: "Notes", value: (b) => b.notes },
            ];
            return toCsv(items, columns);
        },
    },
    suppliers: {
        label: "Suppliers",
        permission: "wedding.budget.view",
        flag: "module.budget",
        async build(db) {
            const suppliers = await listEntities(db, supplierDef);
            const columns: CsvColumn<Supplier>[] = [
                { header: "Name", value: (s) => s.name },
                { header: "Category", value: (s) => s.category },
                { header: "Status", value: (s) => s.status },
                { header: "Contact", value: (s) => s.contactName },
                { header: "Email", value: (s) => s.email },
                { header: "Phone", value: (s) => s.phone },
                { header: "Website", value: (s) => s.website },
                { header: "Notes", value: (s) => s.notes },
            ];
            return toCsv(suppliers, columns);
        },
    },
    audit: {
        label: "Audit log",
        permission: "portal.audit.view",
        async build(db) {
            const rows = await db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 20000").all<Record<string, unknown>>();
            const entries: AuditEntry[] = rows.results.map((r) => ({
                id: r.id as number,
                at: r.at as string,
                actor: r.actor as string,
                action: r.action as string,
                entityType: r.entity_type as string,
                entityId: (r.entity_id as string | null) ?? null,
                summary: r.summary as string,
                changes: parseJson(r.changes, null),
            }));
            return toCsv(entries, [
                { header: "When (UTC)", value: (e) => e.at },
                { header: "Who", value: (e) => e.actor },
                { header: "Action", value: (e) => e.action },
                { header: "Type", value: (e) => e.entityType },
                { header: "Id", value: (e) => e.entityId },
                { header: "Summary", value: (e) => e.summary },
                { header: "Changes", value: (e) => (e.changes ? JSON.stringify(e.changes) : "") },
            ]);
        },
    },
};
