import { beforeEach, describe, expect, it } from "vitest";
import type { DeletedRecord, Guest, Household, Message, WeddingEvent } from "../src/shared/portal/types";
import { ORIGIN, SECOND_OWNER, accessToken, apiCall, auditActions, call, db, resetPortal } from "./portal-helpers";

const ADMIN = "admin@example.com";
const EDITOR = "editor@example.com";

async function people() {
    await apiCall("POST", "/api/portal/users", { email: ADMIN, role: "admin" });
    await apiCall("POST", "/api/portal/users", { email: EDITOR, role: "editor" });
}

async function household() {
    const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony" })).json.item;
    const home = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Fictional Family", email: "family@example.com" }))
        .json.item;
    const guest = (
        await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
            firstName: "Quinn",
            lastName: "Fictional",
            email: "quinn@example.com",
            phone: "0400 000 000",
            dietary: "Peanut allergy",
            householdId: home.id,
            events: [event.id],
        })
    ).json.guest;
    return { event, home, guest };
}

const deletedList = async () => (await apiCall<{ deleted: DeletedRecord[] }>("GET", "/api/portal/privacy/deleted")).json.deleted;

beforeEach(resetPortal);

describe("soft deletion", () => {
    it("hides a deleted guest everywhere but lets it be restored", async () => {
        const { guest, home } = await household();
        await apiCall("DELETE", `/api/portal/wedding/guests/${guest.id}`);

        expect((await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests).toEqual([]);
        expect((await apiCall("GET", `/api/portal/wedding/guests/${guest.id}`)).status).toBe(404);
        const csv = await (await call("/api/portal/export/guests.csv", { token: await accessToken() })).text();
        expect(csv).not.toContain("Quinn");
        const households = (await apiCall<{ items: Household[] }>("GET", "/api/portal/wedding/households")).json.items;
        expect(households.find((h) => h.id === home.id)?.guestCount).toBe(0);
        const dashboard = await apiCall<{ stats: { guests: { total: number } } }>("GET", "/api/portal/dashboard");
        expect(dashboard.json.stats.guests.total).toBe(0);

        expect((await deletedList()).map((d) => d.name)).toEqual(["Quinn Fictional"]);
        await apiCall("POST", "/api/portal/privacy/restore", { type: "guest", id: guest.id });
        expect((await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests).toHaveLength(1);
        expect(await auditActions()).toContain("guest.restore");
    });

    it("revokes a deleted household's RSVP code", async () => {
        const { home } = await household();
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        await apiCall("PUT", "/api/portal/flags/rsvp.native", { enabled: true });
        const lookup = () =>
            call("/api/wedding/rsvp/lookup", {
                method: "POST",
                headers: { Origin: ORIGIN, "Content-Type": "application/json" },
                body: JSON.stringify({ code: home.rsvpCode }),
            });
        expect((await lookup()).status).toBe(200);
        expect((await apiCall("DELETE", `/api/portal/wedding/households/${home.id}`)).status).toBe(200);
        expect((await lookup()).status).toBe(404);
        // The generic route can't hard-delete records that hold personal data.
        const row = await db().prepare("SELECT deleted_at FROM households WHERE id = ?").bind(home.id).first<{ deleted_at: string | null }>();
        expect(row?.deleted_at).toBeTruthy();
    });
});

describe("permanent erasure", () => {
    it("is owner-only, needs the record deleted first and the name typed back", async () => {
        await people();
        const { guest } = await household();
        const body = { type: "guest", id: guest.id, confirm: "Quinn Fictional" };

        expect((await apiCall("POST", "/api/portal/privacy/erase", body)).status).toBe(409); // not deleted yet
        await apiCall("DELETE", `/api/portal/wedding/guests/${guest.id}`);
        expect((await apiCall("POST", "/api/portal/privacy/erase", body, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("POST", "/api/portal/privacy/erase", body, { email: EDITOR })).status).toBe(403);
        expect((await apiCall("POST", "/api/portal/privacy/erase", { ...body, confirm: "Quinn" })).status).toBe(422);
        // Either owner can do it.
        expect((await apiCall("POST", "/api/portal/privacy/erase", { ...body, confirm: " quinn  fictional " }, { email: SECOND_OWNER })).status).toBe(200);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>()).toEqual({ n: 0 });
    });

    it("scrubs the person from message history, RSVP submissions and the audit log", async () => {
        const { guest, home, event } = await household();
        // Leave traces: a message, an online RSVP and some audit entries.
        const message = (
            await apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", { subject: "Hi", body: "Hello {{first_name}}", audience: {} })
        ).json.message;
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        await apiCall("PUT", "/api/portal/flags/rsvp.native", { enabled: true });
        const submit = await call("/api/wedding/rsvp/submit", {
            method: "POST",
            headers: { Origin: ORIGIN, "Content-Type": "application/json" },
            body: JSON.stringify({ code: home.rsvpCode, guests: [{ guestId: guest.id, events: { [event.id]: "attending" }, dietary: "Peanut allergy" }] }),
        });
        expect(submit.status).toBe(200);
        // The RSVP audit entry never held the dietary note itself.
        const rsvpAudit = await db().prepare("SELECT changes FROM audit_log WHERE action = 'rsvp.submit'").first<{ changes: string }>();
        expect(rsvpAudit!.changes).not.toContain("Peanut");

        await apiCall("DELETE", `/api/portal/wedding/guests/${guest.id}`);
        await apiCall("POST", "/api/portal/privacy/erase", { type: "guest", id: guest.id, confirm: "Quinn Fictional" });

        const dump = JSON.stringify(
            await db().batch([
                db().prepare("SELECT * FROM audit_log"),
                db().prepare("SELECT * FROM message_recipients"),
                db().prepare("SELECT * FROM rsvp_submissions"),
                db().prepare("SELECT * FROM guest_events"),
            ]),
        );
        for (const trace of ["Quinn", "quinn@example.com", "0400 000 000", "Peanut"]) expect(dump).not.toContain(trace);
        // Accountability stays: the message still counts a recipient, and the erasure is recorded.
        const recipients = await db().prepare("SELECT name FROM message_recipients WHERE message_id = ?").bind(message.id).all();
        expect(recipients.results).toEqual([{ name: "[erased]" }]);
        const erasure = await db().prepare("SELECT actor, summary FROM audit_log WHERE action = 'privacy.erase'").first();
        expect(erasure).toEqual({ actor: "owner@example.com", summary: "Permanently erased a guest record" });
    });

    it("erases a household, keeping its guests but unlinking them", async () => {
        const { home } = await household();
        await apiCall("DELETE", `/api/portal/wedding/households/${home.id}`);
        expect((await apiCall("POST", "/api/portal/privacy/erase", { type: "household", id: home.id, confirm: "The Fictional Family" })).status).toBe(200);
        const guest = await db().prepare("SELECT household_id FROM guests").first<{ household_id: string | null }>();
        expect(guest?.household_id).toBeNull();
        const audit = JSON.stringify((await db().prepare("SELECT summary, changes FROM audit_log").all()).results);
        expect(audit).not.toContain("Fictional Family");
        expect(audit).not.toContain("family@example.com");
    });
});

describe("retention", () => {
    it("previews and applies retention only when an owner confirms", async () => {
        await people();
        const { guest } = await household();
        await apiCall("DELETE", `/api/portal/wedding/guests/${guest.id}`);
        // Old history: audit entries can't be back-dated (a trigger forbids it), so insert old ones.
        for (let i = 0; i < 5; i++) {
            await db()
                .prepare(
                    "INSERT INTO audit_log (at, actor, action, entity_type, summary) VALUES ('2020-01-01T00:00:00.000Z', 'owner@example.com', 'task.update', 'task', 'Old change')",
                )
                .run();
        }
        await db().prepare("UPDATE guests SET deleted_at = '2020-01-01T00:00:00.000Z'").run();
        const recent = (await auditActions()).filter((_, i, all) => i < all.length - 5);

        const preview = await apiCall<{ preview: { auditEntries: number; deletedRecords: number } }>("GET", "/api/portal/privacy/retention");
        expect(preview.json.preview).toMatchObject({ deletedRecords: 1, auditEntries: 5 });

        expect((await apiCall("POST", "/api/portal/privacy/retention", { confirm: "APPLY RETENTION" }, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("POST", "/api/portal/privacy/retention", { confirm: "yes" })).status).toBe(422);
        const applied = await apiCall<{ removed: number; erased: number }>("POST", "/api/portal/privacy/retention", { confirm: "APPLY RETENTION" });
        expect(applied.json).toMatchObject({ erased: 1, removed: 5 });
        // Recent history stays, plus records of the erasure and of applying retention.
        expect(await auditActions()).toEqual([...recent, "privacy.erase", "privacy.retention"]);
    });

    it("validates retention settings and restricts them to owners", async () => {
        await people();
        expect((await apiCall("PUT", "/api/portal/settings/privacy", { auditRetentionDays: 365, deletedRetentionDays: 30 }, { email: ADMIN })).status).toBe(
            403,
        );
        expect((await apiCall("PUT", "/api/portal/settings/privacy", { auditRetentionDays: 365, deletedRetentionDays: 1 })).status).toBe(422);
        expect((await apiCall("PUT", "/api/portal/settings/privacy", { auditRetentionDays: 0, deletedRetentionDays: 30 })).status).toBe(200);
        const preview = await apiCall<{ preview: { auditCutoff: string | null } }>("GET", "/api/portal/privacy/retention");
        expect(preview.json.preview.auditCutoff).toBeNull();
    });

    it("refuses to rewrite who did what in the audit log", async () => {
        await household();
        await expect(db().prepare("UPDATE audit_log SET actor = 'someone-else@example.com'").run()).rejects.toThrow(/cannot be rewritten/);
    });
});

describe("concurrent edits", () => {
    it("refuses a save based on an out-of-date copy", async () => {
        const { guest } = await household();
        const first = await apiCall<{ guest: Guest }>("PATCH", `/api/portal/wedding/guests/${guest.id}`, {
            notes: "First",
            expectedUpdatedAt: guest.updatedAt,
        });
        expect(first.status).toBe(200);
        const stale = await apiCall("PATCH", `/api/portal/wedding/guests/${guest.id}`, { notes: "Second", expectedUpdatedAt: guest.updatedAt });
        expect(stale.status).toBe(409);
        const fresh = await apiCall("PATCH", `/api/portal/wedding/guests/${guest.id}`, { notes: "Second", expectedUpdatedAt: first.json.guest.updatedAt });
        expect(fresh.status).toBe(200);

        const task = (await apiCall<{ item: { id: string; updatedAt: string } }>("POST", "/api/portal/wedding/tasks", { title: "Book band" })).json.item;
        await apiCall("PATCH", `/api/portal/wedding/tasks/${task.id}`, { title: "Book the band" });
        expect((await apiCall("PATCH", `/api/portal/wedding/tasks/${task.id}`, { title: "Book a DJ", expectedUpdatedAt: task.updatedAt })).status).toBe(409);
    });
});
