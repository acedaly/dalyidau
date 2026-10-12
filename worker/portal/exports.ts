import type { D1Database } from "@cloudflare/workers-types";
import type { Flags } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import type { AuditEntry, BudgetItem, Guest, Household, Supplier, Task } from "../../src/shared/portal/types";
import { type CsvColumn, toCsv } from "./csv";
import { parseJson } from "./db";
import { budgetItemDef, customFieldDef, eventDef, householdDef, listEntities, supplierDef, taskDef } from "./entities";
import { listGuests } from "./guests";
import { getSettings } from "./settings";

const money = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

export interface ExportDef {
    label: string;
    permission: Permission;
    flag?: keyof Flags;
    build: (db: D1Database) => Promise<string>;
}

export const EXPORTS: Record<string, ExportDef> = {
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
                { header: "Phone", value: (g) => g.phone },
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
                { header: "Phone", value: (h) => h.phone },
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
