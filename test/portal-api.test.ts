import { beforeEach, describe, expect, it } from "vitest";
import type { Guest, Household, Message, Task, WeddingEvent } from "../src/shared/portal/types";
import { OWNER, accessToken, apiCall, auditActions, call, db, portalEnv, resetPortal } from "./portal-helpers";

const makeEvent = async (name: string) =>
    (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name, startsAt: "2027-03-20T15:00" })).json.item;
const makeHousehold = async (name: string) => (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name })).json.item;
const makeGuest = async (body: Record<string, unknown>) => {
    const result = await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", body);
    expect(result.status, result.text).toBe(201);
    return result.json.guest;
};

beforeEach(resetPortal);

describe("guests", () => {
    it("creates, updates and deletes guests, auditing each change", async () => {
        const ceremony = await makeEvent("Ceremony");
        const household = await makeHousehold("The Smiths");
        const guest = await makeGuest({
            firstName: "Sam",
            lastName: "Smith",
            email: "SAM@EXAMPLE.COM",
            householdId: household.id,
            events: [ceremony.id],
            tags: ["family"],
        });

        expect(guest).toMatchObject({ email: "sam@example.com", householdName: "The Smiths", rsvp: "pending", tags: ["family"] });
        expect(guest.events).toEqual([expect.objectContaining({ eventId: ceremony.id, status: "pending" })]);

        const updated = await apiCall<{ guest: Guest }>("PATCH", `/api/portal/wedding/guests/${guest.id}`, { dietary: "Vegetarian" });
        expect(updated.json.guest.dietary).toBe("Vegetarian");
        // A partial update must not reset fields that weren't sent.
        expect(updated.json.guest).toMatchObject({ lastName: "Smith", side: "shared", tags: ["family"], householdId: household.id });

        // The audit log records that dietary changed, not the value.
        const audit = await db().prepare("SELECT changes FROM audit_log WHERE action = 'guest.update'").first<{ changes: string }>();
        expect(JSON.parse(audit!.changes)).toEqual({ dietary: ["[redacted]", "[redacted]"] });

        expect((await apiCall("DELETE", `/api/portal/wedding/guests/${guest.id}`)).status).toBe(200);
        const deletedEntry = await db().prepare("SELECT changes FROM audit_log WHERE action = 'guest.delete'").first<{ changes: string | null }>();
        expect(deletedEntry!.changes).toBeNull();
        expect(await auditActions()).toEqual(["event.create", "household.create", "guest.create", "guest.update", "guest.delete"]);
    });

    it("returns field errors for invalid input", async () => {
        const result = await apiCall<{ issues: { path: string }[] }>("POST", "/api/portal/wedding/guests", { firstName: "", email: "not-an-email" });
        expect(result.status).toBe(422);
        expect(result.json.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["firstName", "email"]));
        expect(await auditActions()).toEqual([]);
    });

    it("rejects references to households and events that don't exist", async () => {
        expect((await apiCall("POST", "/api/portal/wedding/guests", { firstName: "A", householdId: "hh_missing" })).status).toBe(422);
        expect((await apiCall("POST", "/api/portal/wedding/guests", { firstName: "A", events: ["evt_missing"] })).status).toBe(422);
    });

    it("validates custom fields by type and keeps their keys fixed", async () => {
        const field = await apiCall<{ item: { id: string } }>("POST", "/api/portal/wedding/custom-fields", {
            key: "meal",
            label: "Meal",
            type: "select",
            options: ["Beef", "Fish"],
        });
        expect(field.status).toBe(201);
        expect((await apiCall("POST", "/api/portal/wedding/custom-fields", { key: "x", label: "X", type: "select", options: [] })).status).toBe(422);

        const bad = await apiCall("POST", "/api/portal/wedding/guests", { firstName: "A", custom: { meal: "Pizza" } });
        expect(bad.status).toBe(422);
        const good = await makeGuest({ firstName: "A", custom: { meal: "Fish", unknown_field: "dropped" } });
        expect(good.custom).toEqual({ meal: "Fish" });

        await apiCall("PATCH", `/api/portal/wedding/custom-fields/${field.json.item.id}`, { key: "renamed", label: "Main course" });
        const row = await db().prepare("SELECT key, label FROM custom_fields").first();
        expect(row).toEqual({ key: "meal", label: "Main course" });
    });

    it("records RSVPs entered by hand, including Say I Do replies", async () => {
        const reception = await makeEvent("Reception");
        const guest = await makeGuest({ firstName: "Kim", events: [reception.id] });
        const result = await apiCall<{ guest: Guest }>("PUT", `/api/portal/wedding/guests/${guest.id}/rsvp`, {
            eventId: reception.id,
            status: "attending",
            source: "sayido",
        });
        expect(result.json.guest.rsvp).toBe("attending");
        expect(result.json.guest.events[0]).toMatchObject({ status: "attending", source: "sayido" });
        // Not invited → refused.
        const other = await makeEvent("Brunch");
        expect((await apiCall("PUT", `/api/portal/wedding/guests/${guest.id}/rsvp`, { eventId: other.id, status: "attending" })).status).toBe(422);
    });

    it("applies bulk actions and audits them as one entry", async () => {
        const ceremony = await makeEvent("Ceremony");
        const a = await makeGuest({ firstName: "A" });
        const b = await makeGuest({ firstName: "B", tags: ["friends"] });

        const invite = await apiCall<{ affected: number }>("POST", "/api/portal/wedding/guests/bulk", {
            action: "invite",
            ids: [a.id, b.id, "gst_missing"],
            eventId: ceremony.id,
        });
        expect(invite.json.affected).toBe(2);
        await apiCall("POST", "/api/portal/wedding/guests/bulk", { action: "set-rsvp", ids: [a.id], eventId: ceremony.id, status: "declined" });
        await apiCall("POST", "/api/portal/wedding/guests/bulk", { action: "add-tag", ids: [a.id, b.id], tag: "friends" });
        const { json } = await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests");
        const byName = Object.fromEntries(json.guests.map((g) => [g.firstName, g]));
        expect(byName.A.rsvp).toBe("declined");
        expect(byName.B.rsvp).toBe("pending");
        expect(byName.A.tags).toEqual(["friends"]);
        expect(byName.B.tags).toEqual(["friends"]); // not duplicated

        await apiCall("POST", "/api/portal/wedding/guests/bulk", { action: "delete", ids: [a.id] });
        const audit = await db().prepare("SELECT changes FROM audit_log WHERE action = 'guest.bulk.delete'").first<{ changes: string }>();
        expect(JSON.parse(audit!.changes)).toEqual({ ids: [a.id] });
        const remaining = await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests");
        expect(remaining.json.guests.map((g) => g.firstName)).toEqual(["B"]);

        // The guest's activity includes bulk changes that named them.
        const activity = await apiCall<{ entries: { action: string }[] }>("GET", `/api/portal/audit?entityId=${b.id}`);
        expect(activity.json.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["guest.bulk.invite", "guest.bulk.add-tag", "guest.create"]));
    });
});

describe("CSV", () => {
    it("exports guests with formula injection neutralised, and audits the export", async () => {
        await makeGuest({ firstName: '=HYPERLINK("https://evil")', lastName: "O'Neil, Jr", notes: "line one\nline two" });
        const response = await call("/api/portal/export/guests.csv", { token: await accessToken() });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("text/csv");
        expect(response.headers.get("Content-Disposition")).toMatch(/attachment; filename="wedding-guests-\d{4}-\d{2}-\d{2}\.csv"/);
        const bytes = new Uint8Array(await response.arrayBuffer());
        // A UTF-8 byte order mark so Excel reads names correctly.
        expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const csv = new TextDecoder().decode(bytes);
        expect(csv.startsWith("First name,Last name")).toBe(true);
        expect(csv).toContain(`"'=HYPERLINK(""https://evil"")"`);
        expect(csv).toContain(`"O'Neil, Jr"`);
        expect(csv).toContain(`"line one\nline two"`);
        expect(await auditActions()).toContain("export.guests");
    });

    it("previews an import without writing, then imports", async () => {
        const ceremony = await makeEvent("Ceremony");
        await makeGuest({ firstName: "Existing", lastName: "Person", email: "existing@example.com" });
        const csv = [
            "First name,Last name,Email,Household,RSVP,Events,Dietary,Shoe size",
            "Existing,Person,existing@example.com,The Persons,yes,Ceremony,,",
            "New,Guest,new@example.com,The Persons,,Ceremony,Vegan,",
            ",Nameless,,,,,,",
            "Bad,Email,not-an-email,,,,,",
            "Wrong,Event,,,,Brunch,,",
        ].join("\n");

        const dry = await apiCall<{ result: { summary: Record<string, number>; rows: { action: string; message: string | null }[] } }>(
            "POST",
            "/api/portal/wedding/guests/import",
            { csv, dryRun: true, rsvpSource: "sayido" },
        );
        expect(dry.status, dry.text).toBe(200);
        expect(dry.json.result.summary).toEqual({ create: 1, update: 1, skip: 0, error: 3, newHouseholds: 1 });
        expect((await db().prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>())?.n).toBe(1);

        const real = await apiCall<{ guests: Guest[] }>("POST", "/api/portal/wedding/guests/import", { csv, dryRun: false, rsvpSource: "sayido" });
        expect(real.status).toBe(200);
        const existing = real.json.guests.find((g) => g.email === "existing@example.com")!;
        expect(existing).toMatchObject({ householdName: "The Persons", rsvp: "attending" });
        expect(existing.events[0]).toMatchObject({ eventId: ceremony.id, source: "sayido" });
        expect(real.json.guests.find((g) => g.email === "new@example.com")).toMatchObject({ dietary: "Vegan", rsvp: "pending" });
        expect(await auditActions()).toContain("guest.import");
    });
});

describe("other modules", () => {
    it("issues RSVP codes and can replace them", async () => {
        const household = await makeHousehold("The Lees");
        expect(household.rsvpCode).toMatch(/^[346789ABCDEFGHJKMNPQRTWXY]{8}$/);
        const replaced = await apiCall<{ household: Household }>("POST", `/api/portal/wedding/households/${household.id}/code`, {});
        expect(replaced.json.household.rsvpCode).not.toBe(household.rsvpCode);
        expect(await auditActions()).toContain("household.code");
    });

    it("stamps tasks when they're completed and clears it when reopened", async () => {
        const task = (await apiCall<{ item: Task }>("POST", "/api/portal/wedding/tasks", { title: "Book celebrant", dueDate: "2026-11-01" })).json.item;
        expect(task.completedAt).toBeNull();
        const done = (await apiCall<{ item: Task }>("PATCH", `/api/portal/wedding/tasks/${task.id}`, { status: "done" })).json.item;
        expect(done.completedAt).toMatch(/^\d{4}-/);
        expect(done.priority).toBe("medium");
        const reopened = (await apiCall<{ item: Task }>("PATCH", `/api/portal/wedding/tasks/${task.id}`, { status: "todo" })).json.item;
        expect(reopened.completedAt).toBeNull();
    });

    it("rejects links to records that don't exist", async () => {
        const result = await apiCall("POST", "/api/portal/wedding/budget-items", { category: "Venue", description: "Deposit", supplierId: "sup_missing" });
        expect(result.status).toBe(422);
    });

    it("hides switched-off modules from the API and pages", async () => {
        await apiCall("PUT", "/api/portal/flags/module.budget", { enabled: false });
        expect((await apiCall("GET", "/api/portal/wedding/budget-items")).status).toBe(404);
        expect((await call("/portal/wedding/budget", { token: await accessToken() })).status).toBe(404);
        expect(await auditActions()).toContain("flag.update");
    });

    it("validates and audits settings", async () => {
        const bad = await apiCall("PUT", "/api/portal/settings/wedding", {
            partnerOne: "A",
            partnerTwo: "B",
            date: "20/03/2027",
            location: "",
            timeZone: "Australia/Sydney",
        });
        expect(bad.status).toBe(422);
        const good = await apiCall("PUT", "/api/portal/settings/wedding", {
            partnerOne: "Alex",
            partnerTwo: "Sam",
            date: "2027-03-20",
            location: "",
            timeZone: "Australia/Sydney",
        });
        expect(good.status).toBe(200);
        const http = await apiCall("PUT", "/api/portal/settings/rsvp", {
            externalUrl: "http://insecure.example",
            deadline: "",
            collectDietary: true,
            collectMessage: true,
        });
        expect(http.status).toBe(422);
        expect(await auditActions()).toEqual(["settings.update"]);
    });

    it("saves personal dashboard layouts and rejects unknown widgets", async () => {
        const saved = await apiCall<{ widgets: unknown[] }>("PUT", "/api/portal/dashboard", { widgets: [{ id: "w-1", type: "countdown", size: "lg" }] });
        expect(saved.json.widgets).toHaveLength(1);
        expect((await apiCall("PUT", "/api/portal/dashboard", { widgets: [{ id: "w-1", type: "crypto-ticker", size: "lg" }] })).status).toBe(422);
        const reset = await apiCall<{ widgets: unknown[] }>("PUT", "/api/portal/dashboard", { reset: true });
        expect(reset.json.widgets.length).toBeGreaterThan(5);
    });
});

describe("communications", () => {
    const prepare = async () => {
        const household = await makeHousehold("The Parks");
        await makeGuest({ firstName: "Jo", email: "jo@example.com", householdId: household.id });
        await makeGuest({ firstName: "Lee" }); // no email → skipped
        const result = await apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
            subject: "Save the date, {{first_name}}",
            body: "Your code is {{rsvp_code}}. RSVP at {{rsvp_link}}",
            audience: {},
        });
        expect(result.status, result.text).toBe(201);
        return { message: result.json.message, household };
    };

    it("freezes recipients and renders merge fields per guest", async () => {
        const { message, household } = await prepare();
        expect(message).toMatchObject({ status: "draft", recipientCount: 2 });
        const recipients = await db().prepare("SELECT name, status FROM message_recipients ORDER BY name").all();
        expect(recipients.results).toEqual([
            { name: "Jo", status: "pending" },
            { name: "Lee", status: "skipped" },
        ]);
        const merge = await call(`/api/portal/wedding/messages/${message.id}/merge.csv`, { token: await accessToken() });
        const csv = await merge.text();
        expect(csv).toContain("Save the date, Jo");
        expect(csv).toContain(`Your code is ${household.rsvpCode}`);
        expect(csv).not.toContain("Lee");
    });

    it("refuses unknown merge fields", async () => {
        await makeGuest({ firstName: "Jo", email: "jo@example.com" });
        const result = await apiCall("POST", "/api/portal/wedding/messages", { subject: "Hi {{frist_name}}", body: "x", audience: {} });
        expect(result.status).toBe(422);
    });

    it("never sends while delivery is off, even with the flag on", async () => {
        const { message } = await prepare();
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, {})).status).toBe(422);
        await apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, {})).status).toBe(422);
        const status = await db().prepare("SELECT status FROM messages").first<{ status: string }>();
        expect(status?.status).toBe("draft");
    });

    it("sends once through the log provider outside production", async () => {
        const env = await portalEnv({ EMAIL_DELIVERY: "log" });
        const { message } = await prepare();
        await apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });
        const sent = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env });
        expect(sent.status, sent.text).toBe(200);
        expect(sent.json.message.status).toBe("sent");
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env })).status).toBe(422);
        // The log provider is never used in production.
        const prod = await portalEnv({ EMAIL_DELIVERY: "log", ENVIRONMENT: "production" });
        const { deliveryProvider } = await import("../worker/portal/comms");
        expect(deliveryProvider(prod)).toBeNull();
    });
});

describe("portal pages", () => {
    it.each([
        "/portal/wedding",
        "/portal/wedding/guests",
        "/portal/wedding/households",
        "/portal/wedding/events",
        "/portal/wedding/rsvps",
        "/portal/wedding/communications",
        "/portal/wedding/tasks",
        "/portal/wedding/timeline",
        "/portal/wedding/budget",
        "/portal/wedding/suppliers",
        "/portal/wedding/website",
        "/portal/settings",
        "/portal/settings/people",
        "/portal/settings/privacy",
        "/portal/audit",
        "/portal/wedding/website/preview",
        "/portal/wedding/website/preview/rsvp",
    ])("server-renders %s", async (path) => {
        // Some data so tables, charts and lists render rows rather than empty states.
        const event = await makeEvent("Ceremony");
        const household = await makeHousehold("The Smiths");
        await makeGuest({ firstName: "Sam", email: "sam@example.com", householdId: household.id, events: [event.id] });
        await apiCall("POST", "/api/portal/wedding/tasks", { title: "Book celebrant", dueDate: "2026-11-01" });
        await apiCall("POST", "/api/portal/wedding/budget-items", { category: "Venue", description: "Deposit", estimatedCents: 500000, paidCents: 100000 });

        const response = await call(path, { token: await accessToken({ email: OWNER }) });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain('id="page-data"');
        expect(html).toMatch(/<h1[^>]*>/);
    });

    it("redirects /portal to the wedding dashboard and 404s unknown pages", async () => {
        const token = await accessToken();
        const root = await call("/portal", { token });
        expect(root.status).toBe(302);
        expect(root.headers.get("Location")).toBe("https://daly.id.au/portal/wedding");
        expect((await call("/portal/wedding/nope", { token })).status).toBe(404);
    });
});
