// Amplenote for AI assistants (docs/AMPLENOTE.md#ai-assistants, worker/mcp/amplenote.ts): the four
// amplenote_ MCP tools, through the portal's real MCP entrypoint, OAuth connection and write ledger.
// Amplenote is the invented stand-in in fixtures/amplenote; every identity, note and task is fictional.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_IDS, createAmplenoteMock } from "../fixtures/amplenote/mock-api.mjs";
import { TASK_PROPERTIES, type TaskPropertySupport, requestedProperties, selectNotes, taskNode, textNodes } from "../worker/amplenote/assistant";
import { ASSISTANT_SCOPE } from "../worker/amplenote/client";
import type { Env } from "../worker/env";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { OWNER, SECOND_OWNER, accessToken, apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const A = OWNER;
const B = SECOND_OWNER;

let mock: ReturnType<typeof createAmplenoteMock>;
let env: Env;

const setAssistant = (on: boolean) =>
    db()
        .prepare(
            "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('website.amplenote.assistant', ?1, '2026-01-01T00:00:00.000Z', 'test') ON CONFLICT(key) DO UPDATE SET enabled = ?1",
        )
        .bind(on ? 1 : 0)
        .run();

/** Connect in Portal settings as `email`, consent in "Amplenote", and follow the redirect back. */
async function connect(email = A) {
    const start = await apiCall<{ url: string }>("POST", "/api/portal/website/amplenote/connect", {}, { env, email });
    expect(start.status).toBe(200);
    const cookie = start.headers.get("Set-Cookie")!.split(";")[0];
    const login = await mock.handle(new Request(start.json.url));
    const callback = new URL(login.headers.get("Location")!);
    const response = await call(`${callback.pathname}${callback.search}`, { headers: { Cookie: cookie }, env });
    expect(response.status).toBeLessThan(400);
    return new URL(start.json.url).searchParams.get("scope");
}

async function mcp<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A) {
    const assertion = await accessToken({ email, aud: [MCP_AUD] });
    return (await handleMcpCall(env, { assertion, tool, input })) as PortalMcpResponse & { data: T };
}

async function ok<T = Record<string, unknown>>(tool: string, input: unknown = {}, email = A): Promise<T> {
    const response = await mcp<T>(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return (response as { data: T }).data;
}

async function refused(tool: string, input: unknown, code: string, email = A) {
    const response = await mcp(tool, input, email);
    expect(response.ok, JSON.stringify(response)).toBe(false);
    if (response.ok) throw new Error("expected a refusal");
    expect(response.error.code).toBe(code);
    return response.error;
}

const ledger = async () =>
    (await db().prepare("SELECT tool, status, entity_type, entity_id, error_code, request_key FROM mcp_writes ORDER BY created_at, id").all()).results;
const writesToAmplenote = () => mock.control.calls().filter((c) => c.startsWith("POST https://api.amplenote.com/v4/notes"));

beforeEach(async () => {
    await resetPortal();
    await db().batch(["amplenote_connection", "amplenote_oauth_states"].map((t) => db().prepare(`DELETE FROM ${t}`)));
    mock = createAmplenoteMock();
    env = await portalEnv({
        MCP_ACCESS_AUD: MCP_AUD,
        AMPLENOTE_CLIENT_ID: "test-client",
        AMPLENOTE_TOKEN_KEY: "test-amplenote-token-key-0123456789abcdef",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
        mock.handle(new Request(input as RequestInfo, init)),
    );
});

afterEach(() => vi.restoreAllMocks());

describe("connecting with the assistant scopes", () => {
    it("asks only to list notes while the switch is off, and for the write scopes once it's on", async () => {
        expect(await connect()).toBe("notes:list");
        await setAssistant(true);
        expect(await connect()).toBe(ASSISTANT_SCOPE);
        const row = await db().prepare("SELECT scope FROM amplenote_connection").first<{ scope: string }>();
        expect(row?.scope.split(" ").sort()).toEqual(["notes:create", "notes:create-content-action", "notes:list"]);
    });

    it("shows in Website settings whether assistants can add notes", async () => {
        await connect();
        let status = await apiCall<{ status: { connection: { canAdd: boolean } } }>("GET", "/api/portal/website/amplenote", undefined, { env });
        expect(status.json.status.connection.canAdd).toBe(false);
        await setAssistant(true);
        await connect();
        status = await apiCall("GET", "/api/portal/website/amplenote", undefined, { env });
        expect(status.json.status.connection.canAdd).toBe(true);
    });
});

describe("who may use the Amplenote tools", () => {
    it("refuses everything while the switch is off, without contacting Amplenote", async () => {
        await setAssistant(true);
        await connect();
        await setAssistant(false);
        const before = mock.control.calls().length;
        const error = await refused("amplenote_list_notes", {}, "forbidden");
        expect(error.message).toMatch(/switched off/);
        await refused("amplenote_create_note", { name: "Never made" }, "forbidden");
        expect(mock.control.calls().length).toBe(before);
    });

    it("refuses the other portal owner, saying nothing about the connection", async () => {
        await setAssistant(true);
        await connect(A);
        const before = mock.control.calls().length;
        for (const tool of ["amplenote_list_notes", "amplenote_create_note"]) {
            const error = await refused(tool, tool === "amplenote_list_notes" ? {} : { name: "Not mine" }, "forbidden", B);
            expect(error.message).toBe("Amplenote tools are only for the portal owner who connected Amplenote.");
        }
        expect(mock.control.calls().length).toBe(before);
    });

    it("says to connect when there's no connection", async () => {
        await setAssistant(true);
        const error = await refused("amplenote_list_notes", {}, "forbidden");
        expect(error.message).toMatch(/isn't connected/);
    });

    it("lists with a blog-only connection but refuses to write until reconnected", async () => {
        await connect(); // switch off: notes:list only
        await setAssistant(true);
        expect((await ok<{ count: number }>("amplenote_list_notes")).count).toBeGreaterThan(0);
        const error = await refused("amplenote_create_note", { name: "Too soon" }, "forbidden");
        expect(error.message).toMatch(/can only list notes/);
        expect(writesToAmplenote()).toHaveLength(0);
        expect(await ledger()).toMatchObject([{ tool: "amplenote_create_note", status: "failed", error_code: "forbidden" }]);
    });

    it("reports a revoked connection plainly", async () => {
        await setAssistant(true);
        await connect();
        // Amplenote stops accepting the access token before it was due to expire.
        mock.control.expireAccess();
        expect((await refused("amplenote_list_notes", {}, "forbidden")).message).toMatch(/refused this connection, so nothing was read or changed/);
        // And the grant is revoked: the refresh is refused too.
        mock.control.revokeRefresh();
        await db().prepare("UPDATE amplenote_connection SET expires_at = '2000-01-01T00:00:00.000Z'").run();
        expect((await refused("amplenote_list_notes", {}, "forbidden")).message).toMatch(/no longer accepts this connection/);
    });
});

describe("amplenote_list_notes", () => {
    beforeEach(async () => {
        await setAssistant(true);
        await connect();
    });

    it("returns titles, tags, times and links, never content, newest change first", async () => {
        const data = await ok<{ notes: Record<string, unknown>[]; count: number; contentAvailable: boolean }>("amplenote_list_notes");
        expect(data.contentAvailable).toBe(false);
        expect(data.count).toBe(3);
        expect(data.notes.map((n) => n.name)).toEqual(["A draft that isn't finished", "Private journal", "Notes from a small vegetable garden"]);
        expect(data.notes[1]).toMatchObject({ noteUuid: NOTE_IDS.private, url: `https://www.amplenote.com/notes/${NOTE_IDS.private}` });
        expect(Object.keys(data.notes[0]).sort()).toEqual(["created", "name", "noteUuid", "tags", "updated", "url"]);
        expect(JSON.stringify(data)).not.toContain("Secret draft text");
    });

    it("filters by words in titles and tags, and by a tag and its children", async () => {
        expect((await ok<{ notes: { name: string }[] }>("amplenote_list_notes", { query: "garden notes" })).notes.map((n) => n.name)).toEqual([
            "Notes from a small vegetable garden",
        ]);
        expect((await ok<{ count: number }>("amplenote_list_notes", { tag: "website" })).count).toBe(2);
        expect((await ok<{ count: number }>("amplenote_list_notes", { tag: "personal/journal" })).count).toBe(1);
    });

    it("bounds the list and says when it was cut short", async () => {
        const data = await ok<{ notes: unknown[]; count: number; truncated: boolean }>("amplenote_list_notes", { limit: 1 });
        expect(data).toMatchObject({ count: 3, truncated: true });
        expect(data.notes).toHaveLength(1);
    });

    it("asks Amplenote only for notes changed since the start of that day", async () => {
        await ok("amplenote_list_notes", { changedSince: "2026-10-03" });
        const listed = mock.control.calls().filter((c) => c.startsWith("GET https://api.amplenote.com/v4/notes"));
        expect(listed.length).toBeGreaterThan(0);
    });

    it("reports Amplenote being down as unavailable, never as an empty list", async () => {
        mock.control.failListing(1);
        await refused("amplenote_list_notes", {}, "unavailable");
    });

    it("writes nothing to the ledger for a read", async () => {
        await ok("amplenote_list_notes");
        expect(await ledger()).toHaveLength(0);
    });
});

describe("amplenote_create_note and amplenote_append", () => {
    beforeEach(async () => {
        await setAssistant(true);
        await connect();
    });

    it("creates a note in Amplenote and records only its id in the ledger", async () => {
        const data = await ok<{ noteUuid: string; url: string }>("amplenote_create_note", {
            name: "Station visit notes",
            tags: ["Work/RFS"],
            requestId: "create-note-0001",
        });
        expect(mock.control.note(data.noteUuid)).toMatchObject({ name: "Station visit notes", tags: ["work/rfs"] });
        expect(await ledger()).toEqual([
            {
                tool: "amplenote_create_note",
                status: "done",
                entity_type: "amplenote_note",
                entity_id: data.noteUuid,
                error_code: null,
                request_key: "create-note-0001",
            },
        ]);
        // Nothing about the note itself is stored in the portal.
        expect(JSON.stringify(await ledger())).not.toContain("Station visit");
    });

    it("returns the first note for a retried request id instead of creating another", async () => {
        const first = await ok<{ noteUuid: string }>("amplenote_create_note", { name: "Once only", requestId: "create-note-0002" });
        const again = await ok<{ noteUuid: string; replayed: boolean }>("amplenote_create_note", { name: "Once only", requestId: "create-note-0002" });
        expect(again).toMatchObject({ replayed: true, noteUuid: first.noteUuid });
        expect(writesToAmplenote()).toHaveLength(1);
    });

    it("adds text as plain paragraphs, one per line, and never as markup", async () => {
        await ok("amplenote_append", { noteUuid: NOTE_IDS.private, text: "First line\n\n<b>not bold</b>\r\nThird", requestId: "append-text-0001" });
        expect(mock.control.actions()).toEqual([
            {
                uuid: NOTE_IDS.private,
                body: {
                    type: "INSERT_NODES",
                    nodes: [
                        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
                        { type: "paragraph", content: [{ type: "text", text: "<b>not bold</b>" }] },
                        { type: "paragraph", content: [{ type: "text", text: "Third" }] },
                    ],
                },
            },
        ]);
    });

    it("says when the note doesn't exist", async () => {
        await refused("amplenote_append", { noteUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", text: "Hello" }, "not_found");
    });

    it("refuses a retry with the same id after an unconfirmed write, so nothing is added twice", async () => {
        mock.control.failWrites("timeout");
        const error = await refused("amplenote_append", { noteUuid: NOTE_IDS.private, text: "Maybe added", requestId: "append-text-0002" }, "unavailable");
        expect(error.message).toMatch(/may or may not have been added/);
        expect(error.details).toEqual({ outcome: "unknown" });
        mock.control.failWrites(null);
        await refused("amplenote_append", { noteUuid: NOTE_IDS.private, text: "Maybe added", requestId: "append-text-0002" }, "conflict");
        expect(mock.control.actions()).toHaveLength(0);
        // A new id is the person's decision to try again.
        await ok("amplenote_append", { noteUuid: NOTE_IDS.private, text: "Maybe added", requestId: "append-text-0003" });
    });

    it("treats a server error as possibly carried out, and a refusal as not", async () => {
        mock.control.failWrites(503);
        expect((await refused("amplenote_create_note", { name: "Unsure" }, "unavailable")).details).toEqual({ outcome: "unknown" });
        mock.control.failWrites(422);
        await refused("amplenote_create_note", { name: "Rejected", requestId: "create-note-0003" }, "validation");
        mock.control.failWrites(null);
        // A plain refusal frees the id for a corrected retry.
        await ok("amplenote_create_note", { name: "Accepted", requestId: "create-note-0003" });
    });

    it("validates input before contacting Amplenote", async () => {
        const before = writesToAmplenote().length;
        await refused("amplenote_append", { noteUuid: "not-a-uuid", text: "x" }, "validation");
        await refused("amplenote_append", { noteUuid: NOTE_IDS.private, text: "   " }, "validation");
        await refused("amplenote_create_note", { name: "Bad tag", tags: ["has space"] }, "validation");
        await refused("amplenote_create_note", { name: "x", email: A }, "validation");
        expect(writesToAmplenote().length).toBe(before);
    });
});

describe("amplenote_create_task", () => {
    beforeEach(async () => {
        await setAssistant(true);
        await connect();
    });

    it("adds a plain task to the note", async () => {
        const data = await ok("amplenote_create_task", { noteUuid: NOTE_IDS.private, text: "Renew the trailer rego", requestId: "create-task-0001" });
        expect(data).toMatchObject({ created: true, noteUuid: NOTE_IDS.private });
        expect(mock.control.actions()[0].body.nodes).toEqual([
            { type: "check_list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "Renew the trailer rego" }] }] },
        ]);
        expect(await ledger()).toMatchObject([{ tool: "amplenote_create_task", status: "done", entity_type: "amplenote_note", entity_id: NOTE_IDS.private }]);
    });

    it("refuses due dates, priority flags and reminders it can't set, creating nothing", async () => {
        const error = await refused(
            "amplenote_create_task",
            {
                noteUuid: NOTE_IDS.private,
                text: "Renew insurance",
                dueDate: "2026-11-01",
                important: true,
                reminderAt: "2026-10-31T09:00:00+11:00",
                requestId: "create-task-0002",
            },
            "validation",
        );
        expect(error.details).toEqual({ unsupported: ["dueDate", "important", "reminderAt"] });
        expect(error.message).toMatch(/no task was created/);
        expect(mock.control.actions()).toHaveLength(0);
        // The id is freed, so the same request can go again once the person has decided.
        await ok("amplenote_create_task", { noteUuid: NOTE_IDS.private, text: "Renew insurance", requestId: "create-task-0002" });
    });

    it("treats false and null as asking for nothing", async () => {
        await ok("amplenote_create_task", { noteUuid: NOTE_IDS.private, text: "No extras", dueDate: null, important: false, urgent: false, reminderAt: null });
        expect(mock.control.actions()).toHaveLength(1);
    });

    it("refuses a time without a date, and a multi-line task", async () => {
        await refused("amplenote_create_task", { noteUuid: NOTE_IDS.private, text: "Call", dueTime: "09:00" }, "validation");
        await refused("amplenote_create_task", { noteUuid: NOTE_IDS.private, text: "One\nTwo" }, "validation");
    });
});

describe("task properties (worker/amplenote/assistant.ts)", () => {
    it("starts with every property unconfirmed", () => {
        for (const property of Object.values(TASK_PROPERTIES)) expect(property.attr).toBeNull();
    });

    it("sets every confirmed property, in the person's time zone", () => {
        const confirmed: Record<keyof typeof TASK_PROPERTIES, TaskPropertySupport> = {
            dueDate: { label: "a due date", attr: "due" },
            important: { label: "the Important flag", attr: "important" },
            urgent: { label: "the Urgent flag", attr: "urgent" },
            reminderAt: { label: "a reminder", attr: "remind" },
        };
        const node = taskNode(
            { text: "Pay the bill", dueDate: "2026-11-02", dueTime: "17:30", important: true, reminderAt: "2026-11-01T09:00:00+11:00" },
            "Australia/Sydney",
            confirmed,
        );
        // 17:30 on 2 November 2026 in Sydney (daylight saving, UTC+11) is 06:30 UTC.
        expect(node.attrs).toEqual({ due: Date.UTC(2026, 10, 2, 6, 30) / 1000, important: true, remind: Date.UTC(2026, 9, 31, 22, 0) / 1000 });
    });

    it("refuses the whole task when any requested property is unconfirmed", () => {
        const partly = { ...TASK_PROPERTIES, important: { label: "the Important flag", attr: "important" } };
        expect(() => taskNode({ text: "x", important: true, urgent: true }, "UTC", partly)).toThrow(/the Urgent flag/);
    });

    it("lists only what was actually asked for", () => {
        expect(requestedProperties({ text: "x", dueDate: null, important: false, urgent: true })).toEqual(["urgent"]);
    });

    it("turns text into paragraphs without blank lines", () => {
        expect(textNodes("a\n\n  \nb  ")).toHaveLength(2);
    });

    it("leaves deleted notes out and orders by last change", () => {
        const picked = selectNotes(
            [
                { uuid: "1", name: "Old", tags: [], public: false, deleted: false, created: 1, updated: 10 },
                { uuid: "2", name: "Gone", tags: [], public: false, deleted: true, created: 1, updated: 30 },
                { uuid: "3", name: "New", tags: null, public: null, deleted: false, created: 20, updated: null },
            ],
            { limit: 10 },
        );
        expect(picked.items.map((n) => n.name)).toEqual(["New", "Old"]);
    });
});
