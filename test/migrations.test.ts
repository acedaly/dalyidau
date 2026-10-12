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
