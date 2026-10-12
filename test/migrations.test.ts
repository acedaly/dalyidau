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
