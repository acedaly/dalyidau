import { beforeEach, describe, expect, it } from "vitest";
import { db, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

describe("migration 0004", () => {
    it("creates every phase-two table, column and unique submission index from scratch", async () => {
        const tables = await db()
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('seating_tables', 'seat_assignments', 'seating_snapshots', 'rsvp_questions', 'rsvp_answers', 'website_media') ORDER BY name",
            )
            .all<{ name: string }>();
        expect(tables.results.map((row) => row.name)).toEqual([
            "rsvp_answers",
            "rsvp_questions",
            "seat_assignments",
            "seating_snapshots",
            "seating_tables",
            "website_media",
        ]);

        const columns = async (table: string) =>
            (await db().prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((column) => column.name);
        expect(await columns("households")).toEqual(expect.arrayContaining(["invite_version", "invite_revoked_at"]));
        expect(await columns("rsvp_submissions")).toContain("client_id");
        expect(await columns("messages")).toEqual(expect.arrayContaining(["category", "scheduled_at"]));
        expect(await columns("message_recipients")).toContain("provider_id");

        const indexes = await db().prepare("PRAGMA index_list(rsvp_submissions)").all<{ name: string; unique: number }>();
        expect(indexes.results).toContainEqual(expect.objectContaining({ name: "rsvp_submissions_client", unique: 1 }));
    });

    it("keeps the built-in courtesy bus question unpublished", async () => {
        expect(await db().prepare("SELECT type, scope, published, version FROM rsvp_questions WHERE id = 'q_bus'").first()).toEqual({
            type: "yes_no",
            scope: "guest",
            published: 0,
            version: 1,
        });
    });
});

describe("migration 0006", () => {
    it("adds the Say I Do ceremony only to a planner with no events, and only once", async () => {
        const { default: sql } = await import("../migrations/0006_say_i_do_ceremony.sql?raw");
        const statement = sql
            .split("\n")
            .filter((line: string) => !line.trim().startsWith("--"))
            .join("\n");
        await db().prepare(statement).run();
        await db().prepare(statement).run();
        expect((await db().prepare("SELECT name, starts_at, venue_name, dress_code, is_public FROM events").all()).results).toEqual([
            { name: "Ceremony", starts_at: "2027-10-23T14:00", venue_name: "Rhino Lodge", dress_code: "Smart casual", is_public: 1 },
        ]);

        // Events the couple already entered are never touched.
        await db().prepare("DELETE FROM events").run();
        await db().prepare("INSERT INTO events (id, name, created_at, updated_at) VALUES ('evt_mine', 'Our own ceremony', 'now', 'now')").run();
        await db().prepare(statement).run();
        expect((await db().prepare("SELECT id FROM events").all()).results).toEqual([{ id: "evt_mine" }]);
    });
});

describe("migration 0009", () => {
    it("adds household invitation names and changes only the old default greeting", async () => {
        const columns = (await db().prepare("PRAGMA table_info(households)").all<{ name: string }>()).results.map((column) => column.name);
        expect(columns).toEqual(expect.arrayContaining(["invitation_name", "invitation_list_names"]));

        const { default: sql } = await import("../migrations/0009_household_invitation_names.sql?raw");
        const update = sql
            .split("\n")
            .filter((line: string) => !line.trim().startsWith("--"))
            .join("\n")
            .split(";")
            .map((statement: string) => statement.trim())
            .find((statement: string) => statement.startsWith("UPDATE settings"))!;
        const store = (value: unknown) =>
            db()
                .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by) VALUES ('invitation', ?, 'now', 'test')")
                .bind(JSON.stringify(value))
                .run();
        const read = async () => JSON.parse((await db().prepare("SELECT value FROM settings WHERE key = 'invitation'").first<{ value: string }>())!.value);

        await store({ greetingPrefix: "For", accent: "rust" });
        await db().prepare(update).run();
        expect(await read()).toEqual({ greetingPrefix: "Dear", accent: "rust" });

        await store({ greetingPrefix: "Hello" });
        await db().prepare(update).run();
        expect(await read()).toEqual({ greetingPrefix: "Hello" });
    });
});

describe("migration 0010", () => {
    it("only creates the rsvp_travel table, with constraints that reject impossible answers", async () => {
        const { default: sql } = await import("../migrations/0010_rsvp_travel.sql?raw");
        const statements = sql
            .split("\n")
            .filter((line: string) => !line.trim().startsWith("--"))
            .join("\n")
            .split(";")
            .map((statement: string) => statement.trim())
            .filter(Boolean);
        // Additive: one CREATE TABLE, no ALTER, UPDATE, DELETE, DROP or INSERT of existing data.
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/^CREATE TABLE rsvp_travel/);
        expect(statements[0]).not.toMatch(/\b(ALTER|UPDATE|DROP|INSERT)\b|(?<!ON )\bDELETE\b/);

        const columns = (await db().prepare("PRAGMA table_info(rsvp_travel)").all<{ name: string }>()).results.map((column) => column.name);
        expect(columns).toEqual(["household_id", "bus", "outbound_count", "return_count", "stay", "stay_location", "source", "updated_at", "updated_by"]);

        await db().prepare("INSERT INTO households (id, name, rsvp_code, created_at, updated_at) VALUES ('hh_m', 'M', 'MMMMMMMM', 'now', 'now')").run();
        const insert = (bus: string, outbound: number) =>
            db()
                .prepare("INSERT OR REPLACE INTO rsvp_travel (household_id, bus, outbound_count, updated_at) VALUES ('hh_m', ?, ?, 'now')")
                .bind(bus, outbound)
                .run();
        await expect(insert("to", 2)).resolves.toBeTruthy();
        await expect(insert("taxi", 1)).rejects.toThrow();
        await expect(insert("to", -1)).rejects.toThrow();
    });
});

describe("migration 0020", () => {
    const statementsOf = (sql: string) =>
        sql
            .split("\n")
            .filter((line: string) => !line.trim().startsWith("--"))
            .join("\n")
            .split(";")
            .map((statement: string) => statement.trim())
            .filter(Boolean);

    it("adds a retry key to projects, unique per creator", async () => {
        const columns = (await db().prepare("PRAGMA table_info(task_projects)").all<{ name: string }>()).results.map((c) => c.name);
        expect(columns).toContain("client_id");
        const indexes = await db().prepare("PRAGMA index_list(task_projects)").all<{ name: string; unique: number }>();
        expect(indexes.results).toContainEqual(expect.objectContaining({ name: "task_projects_client", unique: 1 }));
        const insert = (id: string, by: string) =>
            db()
                .prepare(
                    "INSERT INTO task_projects (id, name, kind, created_by, updated_by, created_at, updated_at, client_id) VALUES (?, 'P', 'personal', ?, ?, 'now', 'now', 'retry-key-0001')",
                )
                .bind(id, by, by)
                .run();
        await insert("tpj_aaaaaaaaaaaaaa", "one@example.com");
        await expect(insert("tpj_bbbbbbbbbbbbbb", "one@example.com")).rejects.toThrow(/UNIQUE/);
        await expect(insert("tpj_cccccccccccccc", "two@example.com")).resolves.toBeTruthy();
    });

    it("rebuilds mcp_writes with every row, column and index kept, and accepts projects as an outcome", async () => {
        const { default: sql } = await import("../migrations/0020_mcp_projects.sql?raw");
        const all = statementsOf(sql);
        // Everything but the two ALTER/CREATE INDEX lines for task_projects; the rebuild is what's tested here.
        const rebuild = all.slice(all.findIndex((s: string) => s.startsWith("CREATE TABLE mcp_writes_next")));
        expect(rebuild.join("\n")).not.toMatch(/\bDELETE\b|\bUPDATE\b/);

        const rows = [
            [
                "mcw_aaaaaaaaaaaaaa",
                "one@example.com",
                "tasks_create",
                "req-one-000001",
                "done",
                "task",
                "tsk_aaaaaaaaaaaaaa",
                null,
                "2026-10-01T00:00:00.000Z",
                "2026-10-01T00:00:01.000Z",
            ],
            [
                "mcw_bbbbbbbbbbbbbb",
                "one@example.com",
                "knowledge_create_object",
                null,
                "failed",
                null,
                null,
                "validation",
                "2026-10-02T00:00:00.000Z",
                "2026-10-02T00:00:01.000Z",
            ],
            ["mcw_cccccccccccccc", "two@example.com", "tasks_link_knowledge", "req-two-000001", "pending", null, null, null, "2026-10-03T00:00:00.000Z", null],
        ];
        for (const row of rows)
            await db()
                .prepare(
                    "INSERT INTO mcp_writes (id, email, tool, request_key, status, entity_type, entity_id, error_code, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(...row)
                .run();
        const columnsBefore = (await db().prepare("PRAGMA table_info(mcp_writes)").all()).results;

        // Run the rebuild again over a populated table, as it would run over production's.
        await db().batch(rebuild.map((statement: string) => db().prepare(statement)));

        expect((await db().prepare("PRAGMA table_info(mcp_writes)").all()).results).toEqual(columnsBefore);
        const after = await db().prepare("SELECT * FROM mcp_writes ORDER BY id").all<Record<string, unknown>>();
        expect(after.results.map((r) => Object.values(r))).toEqual(rows);
        const indexes = (await db().prepare("PRAGMA index_list(mcp_writes)").all<{ name: string; unique: number }>()).results;
        expect(indexes).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "mcp_writes_request", unique: 1 }), expect.objectContaining({ name: "mcp_writes_email" })]),
        );
        expect((await db().prepare("SELECT name FROM sqlite_master WHERE name = 'mcp_writes_next'").all()).results).toHaveLength(0);

        const settle = (type: string) => db().prepare("UPDATE mcp_writes SET entity_type = ? WHERE id = 'mcw_cccccccccccccc'").bind(type).run();
        await expect(settle("task_project")).resolves.toBeTruthy();
        await expect(settle("anything_else")).rejects.toThrow(/CHECK/);
        // The request-id index still refuses a second use by the same person.
        await expect(
            db()
                .prepare(
                    "INSERT INTO mcp_writes (id, email, tool, request_key, created_at) VALUES ('mcw_dddddddddddddd', 'one@example.com', 'tasks_create', 'req-one-000001', 'now')",
                )
                .run(),
        ).rejects.toThrow(/UNIQUE/);
    });
});
