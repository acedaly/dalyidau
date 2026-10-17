// Daly Knowledge, Milestone 3: daily notes, collections, pins, favourites, saved views, templates,
// related knowledge and orphan discovery, including every way they must refuse access. Every
// identity and note is fictional.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import { addDays, formatDailyTitle, localDate, startOfLocalDay } from "../src/shared/knowledge/dates";
import type {
    CollectionItem,
    KnowledgeCollection,
    KnowledgeObjectDetail,
    KnowledgeObjectSummary,
    KnowledgeSavedView,
    KnowledgeTemplate,
    ObjectRef,
    RelatedSuggestion,
} from "../src/shared/knowledge/types";
import type { PortalPageData } from "../src/shared/portal/types";
import { similarityQuery } from "../worker/knowledge/related";
import { ADMIN, K, auditRows, create, doc, objectLink, paragraph, personal, sharedSpace, text, typeId, typesOf } from "./knowledge-helpers";
import { OWNER, SECOND_OWNER, accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const list = async (spaceId: string, params: string, email = OWNER) =>
    (await apiCall<{ objects: KnowledgeObjectSummary[]; total: number }>("GET", `${K}/spaces/${spaceId}/objects?${params}`, undefined, { email })).json;

describe("dates", () => {
    it("works out the calendar date in the space's time zone, through daylight saving changes", () => {
        // Sydney's clocks went forward at 2am on Sunday 4 October 2026 (UTC+10 to UTC+11).
        expect(localDate(new Date("2026-10-03T13:59:00Z"), "Australia/Sydney")).toBe("2026-10-03"); // 23:59 AEST
        expect(localDate(new Date("2026-10-03T14:00:00Z"), "Australia/Sydney")).toBe("2026-10-04"); // 00:00 AEST
        expect(localDate(new Date("2026-10-04T12:59:00Z"), "Australia/Sydney")).toBe("2026-10-04"); // 23:59 AEDT
        expect(localDate(new Date("2026-10-04T13:00:00Z"), "Australia/Sydney")).toBe("2026-10-05"); // 00:00 AEDT
        // And back at 3am on Sunday 5 April 2026.
        expect(localDate(new Date("2026-04-04T12:59:00Z"), "Australia/Sydney")).toBe("2026-04-04");
        expect(localDate(new Date("2026-04-04T13:00:00Z"), "Australia/Sydney")).toBe("2026-04-05");
        expect(localDate(new Date("2026-04-05T13:59:00Z"), "Australia/Sydney")).toBe("2026-04-05");
        expect(localDate(new Date("2026-04-05T14:00:00Z"), "Australia/Sydney")).toBe("2026-04-06");
        // Brisbane never changes; Lord Howe moves by half an hour.
        expect(localDate(new Date("2026-10-04T13:30:00Z"), "Australia/Brisbane")).toBe("2026-10-04");
        expect(localDate(new Date("2026-10-04T13:00:00Z"), "Australia/Lord_Howe")).toBe("2026-10-05");
        expect(localDate(new Date("2026-10-04T12:59:00Z"), "Australia/Lord_Howe")).toBe("2026-10-04");
    });

    it("finds the start of a local day on either side of a change, and does date arithmetic without time zones", () => {
        expect(startOfLocalDay("2026-10-04", "Australia/Sydney")).toBe("2026-10-03T14:00:00.000Z");
        expect(startOfLocalDay("2026-10-05", "Australia/Sydney")).toBe("2026-10-04T13:00:00.000Z");
        expect(startOfLocalDay("2026-04-05", "Australia/Sydney")).toBe("2026-04-04T13:00:00.000Z");
        expect(startOfLocalDay("2026-04-06", "Australia/Sydney")).toBe("2026-04-05T14:00:00.000Z");
        expect(startOfLocalDay("2026-06-01", "UTC")).toBe("2026-06-01T00:00:00.000Z");
        expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
        expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
        expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
        expect(formatDailyTitle("2026-10-17")).toMatch(/^Saturday,? 17 October 2026$/);
    });
});

describe("daily notes", () => {
    it("makes one note per date however many requests race, and only when someone writes", async () => {
        const space = await personal();
        const before = await apiCall<{ note: null; date: string; today: string }>("GET", `${K}/spaces/${space.id}/daily/2026-10-17`);
        expect(before.json.note).toBeNull();
        expect(await db().prepare("SELECT COUNT(*) AS n FROM knowledge_objects").first()).toEqual({ n: 0 });

        const results = await Promise.all([
            ...Array.from({ length: 4 }, () => apiCall<KnowledgeObjectDetail>("POST", `${K}/spaces/${space.id}/daily/2026-10-17`)),
            apiCall<KnowledgeObjectDetail>("POST", `${K}/spaces/${space.id}/daily/append`, { text: "Spoke to the accommodation provider", date: "2026-10-17" }),
            apiCall<KnowledgeObjectDetail>("POST", `${K}/spaces/${space.id}/daily/append`, { text: "Need to confirm transport", date: "2026-10-17" }),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
        expect(new Set(results.map((r) => r.json.object.id)).size).toBe(1);
        const rows = await db().prepare("SELECT title, daily_date, type_id FROM knowledge_objects").all<{ title: string; daily_date: string }>();
        expect(rows.results).toHaveLength(1);
        expect(rows.results[0].daily_date).toBe("2026-10-17");
        expect(rows.results[0].title).toMatch(/17 October 2026/);
        // Both captures are in it, each stamped with the time, and the database refuses a second note for the date.
        const note = (await apiCall<{ note: KnowledgeObjectDetail }>("GET", `${K}/spaces/${space.id}/daily/2026-10-17`)).json.note;
        expect(note.object.excerpt).toMatch(/\d\d:\d\d Spoke to the accommodation provider/);
        expect(note.object.excerpt).toMatch(/\d\d:\d\d Need to confirm transport/);
        await expect(
            db()
                .prepare(
                    "INSERT INTO knowledge_objects (id, space_id, type_id, title, daily_date, search_rowid, created_by, updated_by, created_at, updated_at) VALUES ('kob_dupe0000000000', ?, ?, 'x', '2026-10-17', 999, 'x', 'x', 'x', 'x')",
                )
                .bind(space.id, note.object.typeId)
                .run(),
        ).rejects.toThrow(/UNIQUE/);
        // One "Daily note" type was made, on demand.
        expect((await typesOf(space.id)).filter((t) => t.slug === "daily_note")).toHaveLength(1);
    });

    it("is an ordinary object: edited with versions, searchable, linkable and in the history", async () => {
        const space = await personal();
        const venue = await create(space.id, { title: "Wedding planning" });
        const note = (await apiCall<KnowledgeObjectDetail>("POST", `${K}/spaces/${space.id}/daily/2026-10-17`)).json;
        const saved = await apiCall<KnowledgeObjectDetail>("PATCH", `${K}/objects/${note.object.id}`, {
            version: note.object.version,
            content: doc(paragraph(text("Called about "), objectLink(venue.object.id, "Wedding planning"))),
        });
        expect(saved.status).toBe(200);
        expect((await apiCall("PATCH", `${K}/objects/${note.object.id}`, { version: 1, content: doc("stale") })).status).toBe(409);
        const backlinks = (await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${venue.object.id}`)).json.backlinks;
        expect(backlinks.map((b) => b.object.id)).toEqual([note.object.id]);
        const hits = (await apiCall<{ hits: { object: { id: string } }[] }>("GET", `${K}/search?q=called`)).json.hits;
        expect(hits.map((h) => h.object.id)).toEqual([note.object.id]);
        const revisions = (await apiCall<{ revisions: unknown[] }>("GET", `${K}/objects/${note.object.id}/revisions`)).json.revisions;
        expect(revisions).toHaveLength(2);
        // The date can't be changed by editing.
        expect((await apiCall("PATCH", `${K}/objects/${note.object.id}`, { version: 2, dailyDate: "2020-01-01" })).status).toBe(422);
    });

    it("keeps old notes on their dates when the space's time zone changes", async () => {
        const space = await personal();
        const note = (await apiCall<KnowledgeObjectDetail>("POST", `${K}/spaces/${space.id}/daily/2026-10-17`)).json;
        expect((await apiCall("PATCH", `${K}/spaces/${space.id}`, { timeZone: "America/Los_Angeles" })).status).toBe(200);
        const again = (await apiCall<{ note: KnowledgeObjectDetail }>("GET", `${K}/spaces/${space.id}/daily/2026-10-17`)).json.note;
        expect(again.object.id).toBe(note.object.id);
        expect(again.object.dailyDate).toBe("2026-10-17");
        // "Today" now follows the new zone.
        const today = (await apiCall<{ today: string }>("GET", `${K}/spaces/${space.id}/daily/today`)).json.today;
        expect(today).toBe(localDate(new Date(), "America/Los_Angeles"));
    });

    it("refuses impossible dates, viewers writing and anyone outside the space", async () => {
        const space = await sharedSpace("viewer");
        expect((await apiCall("GET", `${K}/spaces/${space.id}/daily/2026-02-30`)).status).toBe(404);
        expect((await apiCall("GET", `${K}/spaces/${space.id}/daily/1700-01-01`)).status).toBe(404);
        expect((await apiCall("GET", `${K}/spaces/${space.id}/daily/today`, undefined, { email: ADMIN })).status).toBe(200);
        expect((await apiCall("POST", `${K}/spaces/${space.id}/daily/2026-10-17`, {}, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("POST", `${K}/spaces/${space.id}/daily/append`, { text: "x" }, { email: ADMIN })).status).toBe(403);
        await apiCall("POST", `${K}/spaces/${space.id}/daily/append`, { text: "Household news", date: "2026-10-17" });
        const outside = await apiCall("GET", `${K}/spaces/${space.id}/daily/2026-10-17`, undefined, { email: SECOND_OWNER });
        expect(outside.status).toBe(404);
        expect(outside.text).not.toContain("Household news");
        expect((await apiCall("POST", `${K}/spaces/${space.id}/daily/append`, { text: "x" }, { email: SECOND_OWNER })).status).toBe(404);
    });
});

describe("collections", () => {
    const newCollection = async (spaceId: string, name: string, email = OWNER) => {
        const result = await apiCall<{ collection: KnowledgeCollection }>("POST", `${K}/spaces/${spaceId}/collections`, { name }, { email });
        expect(result.status, result.text).toBe(201);
        return result.json.collection;
    };
    const items = async (id: string, email = OWNER) =>
        (await apiCall<{ items: CollectionItem[]; total: number }>("GET", `${K}/collections/${id}`, undefined, { email })).json.items;

    it("groups objects without copying them, in a chosen order, and deleting it keeps the objects", async () => {
        const space = await personal();
        const [a, b, c] = [await create(space.id, { title: "Venue" }), await create(space.id, { title: "Catering" }), await create(space.id, { title: "Music" })];
        const wedding = await newCollection(space.id, "Wedding");
        const reading = await newCollection(space.id, "Reading");
        expect((await apiCall("POST", `${K}/collections/${wedding.id}/items`, { objectIds: [a.object.id, b.object.id, c.object.id] })).status).toBe(201);
        // The same object can be in more than one collection, and adding twice changes nothing.
        expect((await apiCall<{ added: number }>("POST", `${K}/collections/${reading.id}/items`, { objectIds: [a.object.id] })).json.added).toBe(1);
        expect((await apiCall<{ added: number }>("POST", `${K}/collections/${wedding.id}/items`, { objectIds: [a.object.id] })).json.added).toBe(0);
        expect((await items(wedding.id)).map((i) => i.title)).toEqual(["Venue", "Catering", "Music"]);

        // Reorder: Music first, then Venue after Catering.
        expect((await apiCall("POST", `${K}/collections/${wedding.id}/move`, { objectId: c.object.id, afterId: null })).status).toBe(200);
        await apiCall("POST", `${K}/collections/${wedding.id}/move`, { objectId: a.object.id, afterId: b.object.id });
        expect((await items(wedding.id)).map((i) => i.title)).toEqual(["Music", "Catering", "Venue"]);
        // Many moves between the same two neighbours still keep a strict order.
        for (let i = 0; i < 60; i++)
            await apiCall("POST", `${K}/collections/${wedding.id}/move`, { objectId: i % 2 ? a.object.id : b.object.id, afterId: c.object.id });
        expect((await items(wedding.id)).map((i) => i.title)).toEqual(["Music", "Venue", "Catering"]);

        // Pinned items come first.
        await apiCall("POST", `${K}/collections/${wedding.id}/items/${b.object.id}/pin`, { pinned: true });
        expect((await items(wedding.id)).map((i) => [i.title, i.pinned])).toEqual([
            ["Catering", true],
            ["Music", false],
            ["Venue", false],
        ]);

        expect((await apiCall("DELETE", `${K}/collections/${wedding.id}/items/${c.object.id}`)).status).toBe(200);
        expect((await items(wedding.id)).map((i) => i.title)).toEqual(["Catering", "Venue"]);
        expect((await apiCall("DELETE", `${K}/collections/${wedding.id}`)).status).toBe(200);
        expect((await apiCall("GET", `${K}/collections/${wedding.id}`)).status).toBe(404);
        // Every object survived, and the other collection still has its item.
        expect((await list(space.id, "view=all")).total).toBe(3);
        expect((await items(reading.id)).map((i) => i.title)).toEqual(["Venue"]);
        expect((await auditRows()).map((r) => r.action)).toEqual(expect.arrayContaining(["collection.create", "collection.add", "collection.reorder", "collection.delete"]));
    });

    it("renames and archives with conflict protection, and hides trashed objects", async () => {
        const space = await personal();
        const collection = await newCollection(space.id, "Ideas");
        const note = await create(space.id, { title: "Shed" });
        await apiCall("POST", `${K}/collections/${collection.id}/items`, { objectIds: [note.object.id] });
        const renamed = await apiCall<{ collection: KnowledgeCollection }>("PATCH", `${K}/collections/${collection.id}`, { version: 1, name: "Big ideas" });
        expect(renamed.json.collection).toMatchObject({ name: "Big ideas", version: 2, itemCount: 1 });
        expect((await apiCall("PATCH", `${K}/collections/${collection.id}`, { version: 1, name: "Stale" })).status).toBe(409);
        // Trashing hides an item without removing it; restoring brings it back.
        await apiCall("POST", `${K}/objects/${note.object.id}/status/trash`);
        expect(await items(collection.id)).toEqual([]);
        await apiCall("POST", `${K}/objects/${note.object.id}/status/restore`);
        expect((await items(collection.id)).map((i) => i.title)).toEqual(["Shed"]);
        // Something already in the trash can't be added.
        const junk = await create(space.id, { title: "Junk" });
        await apiCall("POST", `${K}/objects/${junk.object.id}/status/trash`);
        expect((await apiCall("POST", `${K}/collections/${collection.id}/items`, { objectIds: [junk.object.id] })).status).toBe(422);
        const archived = await apiCall<{ collection: KnowledgeCollection }>("PATCH", `${K}/collections/${collection.id}`, { version: 2, archived: true });
        expect(archived.json.collection.archived).toBe(true);
        const live = (await apiCall<{ collections: KnowledgeCollection[] }>("GET", `${K}/spaces/${space.id}/collections`)).json.collections;
        expect(live).toEqual([]);
    });

    it("never takes in an object from another space, in code or in the database", async () => {
        const mine = await personal();
        const collection = await newCollection(mine.id, "Mine");
        const theirs = await create((await personal(SECOND_OWNER)).id, { title: "Their secret" }, SECOND_OWNER);
        expect((await apiCall("POST", `${K}/collections/${collection.id}/items`, { objectIds: [theirs.object.id] })).status).toBe(422);
        await expect(
            db()
                .prepare("INSERT INTO knowledge_collection_items (space_id, collection_id, object_id, position, added_by, added_at) VALUES (?, ?, ?, 1, 'x', 'x')")
                .bind(mine.id, collection.id, theirs.object.id)
                .run(),
        ).rejects.toThrow(/FOREIGN KEY/);
        // Nor can someone outside see, change or delete it.
        for (const [method, path, body] of [
            ["GET", `${K}/collections/${collection.id}`],
            ["PATCH", `${K}/collections/${collection.id}`, { version: 1, name: "x" }],
            ["DELETE", `${K}/collections/${collection.id}`],
            ["POST", `${K}/collections/${collection.id}/items`, { objectIds: [theirs.object.id] }],
            ["GET", `${K}/spaces/${mine.id}/collections`],
        ] as const)
            expect((await apiCall(method, path, body, { email: SECOND_OWNER })).status, `${method} ${path}`).toBe(404);
    });

    it("lets viewers browse a shared space's collections but not change them", async () => {
        const space = await sharedSpace("viewer");
        const collection = await newCollection(space.id, "Recipes");
        const note = await create(space.id, { title: "Pavlova" });
        await apiCall("POST", `${K}/collections/${collection.id}/items`, { objectIds: [note.object.id] });
        expect((await items(collection.id, ADMIN)).map((i) => i.title)).toEqual(["Pavlova"]);
        for (const [method, path, body] of [
            ["POST", `${K}/spaces/${space.id}/collections`, { name: "x" }],
            ["PATCH", `${K}/collections/${collection.id}`, { version: 1, name: "x" }],
            ["DELETE", `${K}/collections/${collection.id}`],
            ["POST", `${K}/collections/${collection.id}/move`, { objectId: note.object.id, afterId: null }],
            ["DELETE", `${K}/collections/${collection.id}/items/${note.object.id}`],
        ] as const)
            expect((await apiCall(method, path, body, { email: ADMIN })).status, `${method} ${path}`).toBe(403);
    });
});

describe("favourites and pins", () => {
    const favourites = async (email = OWNER) => (await apiCall<{ favourites: ObjectRef[] }>("GET", `${K}/favourites`, undefined, { email })).json.favourites;

    it("keeps favourites personal, even in a shared space", async () => {
        const space = await sharedSpace("viewer");
        const a = await create(space.id, { title: "Packing list" });
        const b = await create(space.id, { title: "Emergency contacts" });
        await apiCall("POST", `${K}/objects/${a.object.id}/favourite`, { favourite: true });
        // A viewer can favourite too: it changes nothing anyone else sees.
        expect((await apiCall("POST", `${K}/objects/${b.object.id}/favourite`, { favourite: true }, { email: ADMIN })).status).toBe(200);
        expect((await favourites()).map((f) => f.title)).toEqual(["Packing list"]);
        expect((await favourites(ADMIN)).map((f) => f.title)).toEqual(["Emergency contacts"]);
        await apiCall("POST", `${K}/objects/${a.object.id}/favourite`, { favourite: false });
        expect(await favourites()).toEqual([]);
        // Favouriting doesn't touch the object.
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${b.object.id}`)).json.object.version).toBe(1);
    });

    it("never shows a favourite once access has gone, and removes it with the membership", async () => {
        const space = await sharedSpace("editor");
        const note = await create(space.id, { title: "Surprise party plans" });
        await apiCall("POST", `${K}/objects/${note.object.id}/favourite`, { favourite: true }, { email: ADMIN });
        await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "Mine", definition: {} }, { email: ADMIN });
        // Even before the cleanup, reads go through the current membership.
        await db().prepare("DELETE FROM knowledge_memberships WHERE space_id = ? AND email = ?").bind(space.id, ADMIN).run();
        const stale = await apiCall("GET", `${K}/favourites`, undefined, { email: ADMIN });
        expect(stale.text).not.toContain("Surprise party");
        await db()
            .prepare("INSERT INTO knowledge_memberships (space_id, email, role, added_by, created_at, updated_at) VALUES (?, ?, 'editor', ?, 'x', 'x')")
            .bind(space.id, ADMIN, OWNER)
            .run();
        expect((await apiCall("DELETE", `${K}/spaces/${space.id}/members/${ADMIN}`)).status).toBe(200);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM knowledge_favourites WHERE email = ?").bind(ADMIN).first()).toEqual({ n: 0 });
        expect(await db().prepare("SELECT COUNT(*) AS n FROM knowledge_saved_views WHERE owner_email = ?").bind(ADMIN).first()).toEqual({ n: 0 });
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/favourite`, { favourite: true }, { email: ADMIN })).status).toBe(404);
    });

    it("leaves trashed objects out of favourites and pins", async () => {
        const space = await personal();
        const note = await create(space.id, { title: "Old idea" });
        await apiCall("POST", `${K}/objects/${note.object.id}/favourite`, { favourite: true });
        await apiCall("POST", `${K}/objects/${note.object.id}/pin`, { pinned: true });
        await apiCall("POST", `${K}/objects/${note.object.id}/status/trash`);
        expect(await favourites()).toEqual([]);
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/pin`, { pinned: true })).status).toBe(409);
        await apiCall("POST", `${K}/objects/${note.object.id}/status/restore`);
        expect((await favourites()).map((f) => f.title)).toEqual(["Old idea"]);
    });

    it("lets editors pin to a space's home, for everyone, and refuses viewers and outsiders", async () => {
        const space = await sharedSpace("viewer");
        const note = await create(space.id, { title: "House rules" });
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/pin`, { pinned: true }, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/pin`, { pinned: true }, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/favourite`, { favourite: true }, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/pin`, { pinned: true })).status).toBe(200);
        const pins = await db().prepare("SELECT object_id FROM knowledge_pins WHERE space_id = ?").bind(space.id).all();
        expect(pins.results).toEqual([{ object_id: note.object.id }]);
    });
});

describe("saved views", () => {
    it("saves filters as validated data, never SQL, and runs them through the ordinary list", async () => {
        const space = await personal();
        const person = await typeId(space.id, "person");
        await create(space.id, { typeId: person, title: "Sam Example", tags: ["wedding"] });
        await create(space.id, { typeId: person, title: "Alex Example" });
        await create(space.id, { title: "Wedding budget", tags: ["wedding"] });
        const created = await apiCall<{ view: KnowledgeSavedView }>("POST", `${K}/spaces/${space.id}/views`, {
            name: "Wedding people",
            definition: { typeId: person, tag: "wedding", sort: "title" },
        });
        expect(created.status, created.text).toBe(201);
        expect(created.json.view).toMatchObject({ name: "Wedding people", shared: false, mine: true });
        for (const definition of [
            { sort: "title; DROP TABLE knowledge_objects" },
            { where: "1=1" },
            { typeId: "kty_00000000000000' OR 1=1 --" },
            { createdFrom: "yesterday" },
            { links: "everything" },
        ]) {
            const result = await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "Bad", definition });
            expect(result.status, JSON.stringify(definition)).toBe(422);
        }
        // A type from someone else's space isn't accepted either.
        const foreign = await typeId((await personal(SECOND_OWNER)).id, "person", SECOND_OWNER);
        expect((await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "Bad", definition: { typeId: foreign } })).status).toBe(422);
        // Opening the view applies its filters.
        const page = await apiCall("GET", `/portal/knowledge/all?saved=${created.json.view.id}`);
        expect(page.status).toBe(200);
        expect(page.text).toContain("Sam Example");
        expect(page.text).not.toContain("Alex Example");
        expect(page.text).not.toContain("Wedding budget");
    });

    it("keeps private views private and lets only editors manage shared ones", async () => {
        const space = await sharedSpace("viewer");
        const mine = (await apiCall<{ view: KnowledgeSavedView }>("POST", `${K}/spaces/${space.id}/views`, { name: "My private view", definition: {} })).json.view;
        // A viewer can keep private views, but not add shared ones.
        expect((await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "Theirs", definition: {} }, { email: ADMIN })).status).toBe(201);
        expect((await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "For all", shared: true, definition: {} }, { email: ADMIN })).status).toBe(403);
        const shared = (await apiCall<{ view: KnowledgeSavedView }>("POST", `${K}/spaces/${space.id}/views`, { name: "Everyone", shared: true, definition: {} })).json
            .view;
        const seen = (await apiCall<{ views: KnowledgeSavedView[] }>("GET", `${K}/spaces/${space.id}/views`, undefined, { email: ADMIN })).json.views;
        expect(seen.map((v) => v.name).sort()).toEqual(["Everyone", "Theirs"]);
        expect((await apiCall("GET", `/portal/knowledge/all?saved=${mine.id}`, undefined, { email: ADMIN })).status).toBe(404);
        expect((await apiCall("PATCH", `${K}/views/${mine.id}`, { version: 1, name: "x" }, { email: ADMIN })).status).toBe(404);
        expect((await apiCall("DELETE", `${K}/views/${shared.id}`, undefined, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("PATCH", `${K}/views/${shared.id}`, { version: 1, name: "Everybody" })).status).toBe(200);
        expect((await apiCall("PATCH", `${K}/views/${shared.id}`, { version: 1, name: "Stale" })).status).toBe(409);
        expect((await apiCall("GET", `/portal/knowledge/all?saved=${shared.id}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
    });

    it("filters by creation date in the space's time zone and by links", async () => {
        const space = await personal();
        const a = await create(space.id, { title: "Linked from" });
        const b = await create(space.id, { title: "Linked to" });
        await create(space.id, { title: "On its own" });
        await apiCall("POST", `${K}/objects/${a.object.id}/relations`, { targetId: b.object.id });
        await apiCall("POST", `${K}/spaces/${space.id}/daily/append`, { text: "Daily notes don't count as orphans" });
        // Make "On its own" look like it was created just after midnight, Sydney time, on 1 October.
        await db().prepare("UPDATE knowledge_objects SET created_at = '2026-09-30T14:05:00.000Z' WHERE title = 'On its own'").run();
        expect((await list(space.id, "created_from=2026-10-01&created_to=2026-10-01")).objects.map((o) => o.title)).toEqual(["On its own"]);
        expect((await list(space.id, "created_from=2026-09-30&created_to=2026-09-30")).objects).toEqual([]);
        const titles = async (links: string) => (await list(space.id, `links=${links}&sort=title`)).objects.map((o) => o.title);
        expect(await titles("unlinked")).toEqual(["On its own"]);
        expect(await titles("no_backlinks")).toEqual(["Linked from", "On its own"]);
        expect(await titles("no_outgoing")).toEqual(["Linked to", "On its own"]);
        // A link to something in the trash doesn't count.
        await apiCall("POST", `${K}/objects/${b.object.id}/status/trash`);
        expect(await titles("unlinked")).toEqual(["Linked from", "On its own"]);
    });
});

describe("templates", () => {
    const meetingTemplate = async (spaceId: string, extra: Record<string, unknown> = {}) => {
        const meeting = await typeId(spaceId, "meeting");
        const result = await apiCall<{ template: KnowledgeTemplate }>("POST", `${K}/spaces/${spaceId}/templates`, {
            typeId: meeting,
            name: "Meeting notes",
            title: "Meeting {date}",
            content: doc(
                { type: "heading", attrs: { level: 2 }, content: [text("Purpose")] },
                { type: "heading", attrs: { level: 2 }, content: [text("Decisions")] },
            ),
            properties: { date: "2026-10-17" },
            ...extra,
        });
        expect(result.status, result.text).toBe(201);
        return result.json.template;
    };

    it("creates independent objects: editing one never changes the template", async () => {
        const space = await personal();
        const template = await meetingTemplate(space.id);
        const created = await create(space.id, { templateId: template.id });
        expect(created.object.title).toMatch(/^Meeting .*20\d\d$/);
        expect(created.object.typeId).toBe(template.typeId);
        expect(created.object.content).toEqual(template.content);
        expect(created.object.properties).toEqual({ date: "2026-10-17" });
        await apiCall("PATCH", `${K}/objects/${created.object.id}`, { version: 1, title: "Kick-off", content: doc("Changed"), properties: { date: "2026-11-01" } });
        const after = (await apiCall<{ template: KnowledgeTemplate }>("GET", `${K}/templates/${template.id}`)).json.template;
        expect(after).toEqual(template);
        // And the other way round.
        await apiCall("PATCH", `${K}/templates/${template.id}`, { version: 1, content: doc("New template text") });
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${created.object.id}`)).json.object.excerpt).toBe("Changed");
        // Request values win over the template's.
        const overridden = await create(space.id, { templateId: template.id, title: "Board meeting", properties: { date: "2027-01-01" } });
        expect(overridden.object).toMatchObject({ title: "Board meeting", properties: { date: "2027-01-01" } });
    });

    it("checks values against the type when saved, and again when used after the type changes", async () => {
        const space = await personal();
        const project = await typeId(space.id, "project");
        const bad = [
            { typeId: project, name: "x", properties: { status: "nonsense" } },
            { typeId: project, name: "x", properties: { nope: "x" } },
            { typeId: project, name: "x", properties: { area: ["kob_aaaaaaaaaaaaaa"] } },
            { typeId: project, name: "x", content: { type: "doc", content: [{ type: "script" }] } },
            { typeId: project, name: "<b>x</b>".repeat(20) },
        ];
        for (const body of bad) expect((await apiCall("POST", `${K}/spaces/${space.id}/templates`, body)).status, JSON.stringify(body)).toBe(422);
        const template = (await apiCall<{ template: KnowledgeTemplate }>("POST", `${K}/spaces/${space.id}/templates`, {
            typeId: project,
            name: "Project",
            properties: { status: "on_hold", due: "2027-01-01" },
        })).json.template;
        // The type loses "on hold" and the "due" property.
        const type = (await typesOf(space.id)).find((t) => t.id === project)!;
        const schema = {
            properties: type.schema.properties
                .filter((p) => p.key !== "due")
                .map((p) => (p.key === "status" ? { ...p, options: p.options!.filter((o) => o.id !== "on_hold") } : p)),
        };
        expect((await apiCall("PATCH", `${K}/types/${project}`, { version: type.version, schema })).status).toBe(200);
        const created = await create(space.id, { templateId: template.id });
        // Neither stale value was stored; the type's own default filled the status, and the caller was told.
        expect(created.object.properties).toEqual({ status: "planned" });
        expect(created.notices).toHaveLength(2);
        expect(created.notices!.join(" ")).toMatch(/Status.*no longer valid/);
        expect(created.notices!.join(" ")).toMatch(/“due”.*no longer has that property/);
    });

    it("uses a type's default template only when asked, and keeps one default per type", async () => {
        const space = await personal();
        const first = await meetingTemplate(space.id, { isDefault: true });
        const second = await meetingTemplate(space.id, { name: "Stand-up", isDefault: true, title: "Stand-up" });
        const all = (await apiCall<{ templates: KnowledgeTemplate[] }>("GET", `${K}/spaces/${space.id}/templates`)).json.templates;
        expect(all.filter((t) => t.isDefault).map((t) => t.id)).toEqual([second.id]);
        expect(all.find((t) => t.id === first.id)!.isDefault).toBe(false);
        const meeting = await typeId(space.id, "meeting");
        expect((await create(space.id, { typeId: meeting, useDefaultTemplate: true })).object.title).toBe("Stand-up");
        expect((await create(space.id, { typeId: meeting })).object.title).toBe("");
    });

    it("adds a template to an existing object without overwriting anything", async () => {
        const space = await personal();
        const template = await meetingTemplate(space.id);
        const meeting = await typeId(space.id, "meeting");
        const existing = await create(space.id, { typeId: meeting, title: "Mine", content: doc("My own notes"), properties: { date: "2026-01-01" } });
        const applied = await apiCall<KnowledgeObjectDetail>("POST", `${K}/objects/${existing.object.id}/apply-template`, { templateId: template.id, version: 1 });
        expect(applied.status, applied.text).toBe(200);
        expect(applied.json.object.title).toBe("Mine");
        expect(applied.json.object.content.content![0]).toEqual(paragraph(text("My own notes")));
        expect(applied.json.object.content.content).toHaveLength(3);
        expect(applied.json.object.properties).toEqual({ date: "2026-01-01" });
        expect(applied.json.notices).toEqual(["Date already had a value, so it was kept."]);
        // Based on an old version, it's refused like any stale edit.
        expect((await apiCall("POST", `${K}/objects/${existing.object.id}/apply-template`, { templateId: template.id, version: 1 })).status).toBe(409);
    });

    it("protects templates from stale saves, other spaces and viewers", async () => {
        const space = await sharedSpace("viewer");
        const template = await meetingTemplate(space.id);
        expect((await apiCall("PATCH", `${K}/templates/${template.id}`, { version: 1, name: "Renamed" })).status).toBe(200);
        expect((await apiCall("PATCH", `${K}/templates/${template.id}`, { version: 1, name: "Stale" })).status).toBe(409);
        expect((await apiCall("GET", `${K}/templates/${template.id}`, undefined, { email: ADMIN })).status).toBe(200);
        expect((await apiCall("PATCH", `${K}/templates/${template.id}`, { version: 2, name: "x" }, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("GET", `${K}/templates/${template.id}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
        const theirs = await personal(SECOND_OWNER);
        expect((await apiCall("POST", `${K}/spaces/${theirs.id}/objects`, { templateId: template.id }, { email: SECOND_OWNER })).status).toBe(422);
        // Deleting a template keeps what was made from it.
        const made = await create(space.id, { templateId: template.id });
        expect((await apiCall("DELETE", `${K}/templates/${template.id}`)).status).toBe(200);
        expect((await apiCall("GET", `${K}/objects/${made.object.id}`)).status).toBe(200);
    });
});

describe("related knowledge", () => {
    const related = async (id: string, email = OWNER) =>
        (await apiCall<{ related: RelatedSuggestion[] }>("GET", `${K}/objects/${id}/related`, undefined, { email })).json.related;

    it("ranks explainable suggestions and leaves out direct links, the trash and other spaces", async () => {
        const space = await personal();
        const hub = await create(space.id, { title: "Wedding planning" });
        const subject = await create(space.id, { title: "Transport options", tags: ["wedding", "logistics", "guests"], content: doc(paragraph(objectLink(hub.object.id, "Wedding planning"))) });
        await create(space.id, { title: "Accommodation", tags: ["wedding", "logistics"], content: doc(paragraph(objectLink(hub.object.id, "Wedding planning"))) });
        const tagOnly = await create(space.id, { title: "Seating chart", tags: ["guests"] });
        const wording = await create(space.id, { title: "Transport timetable" });
        const linked = await create(space.id, { title: "Bus company", tags: ["logistics"] });
        await apiCall("POST", `${K}/objects/${subject.object.id}/relations`, { targetId: linked.object.id });
        const trashed = await create(space.id, { title: "Old transport idea", tags: ["wedding", "logistics", "guests"] });
        await apiCall("POST", `${K}/objects/${trashed.object.id}/status/trash`);
        await create((await personal(SECOND_OWNER)).id, { title: "Transport (theirs)", tags: ["wedding"] }, SECOND_OWNER);

        const suggestions = await related(subject.object.id);
        const titles = suggestions.map((s) => s.object.title);
        expect(titles[0]).toBe("Accommodation");
        expect(titles).toEqual(expect.arrayContaining(["Seating chart", "Transport timetable"]));
        expect(titles).not.toContain("Wedding planning"); // linked directly
        expect(titles).not.toContain("Bus company"); // linked directly
        expect(titles).not.toContain("Old transport idea");
        expect(titles).not.toContain("Transport (theirs)");
        expect(new Set(titles).size).toBe(titles.length);
        const top = suggestions[0];
        expect(top.strength).toBe("strong");
        expect(top.reasons).toEqual(["Shares 2 tags: logistics, wedding", "Also links to “Wedding planning”"]);
        expect(suggestions.find((s) => s.object.id === tagOnly.object.id)!.reasons).toEqual(["Shares the tag guests"]);
        expect(suggestions.find((s) => s.object.id === wording.object.id)).toMatchObject({ strength: "possible", reasons: ["Similar wording"] });
        // Looking doesn't link anything.
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${subject.object.id}`)).json.outgoing).toHaveLength(2);
    });

    it("counts shared collections and notes that mention both, and is closed to outsiders", async () => {
        const space = await personal();
        const a = await create(space.id, { title: "Alpha" });
        const b = await create(space.id, { title: "Bravo" });
        const c = await create(space.id, { title: "Charlie" });
        await create(space.id, { title: "Index", content: doc(paragraph(objectLink(a.object.id, "Alpha"), text(" "), objectLink(b.object.id, "Bravo"))) });
        const collection = (await apiCall<{ collection: KnowledgeCollection }>("POST", `${K}/spaces/${space.id}/collections`, { name: "Phonetic" })).json.collection;
        await apiCall("POST", `${K}/collections/${collection.id}/items`, { objectIds: [a.object.id, c.object.id] });
        const suggestions = await related(a.object.id);
        expect(suggestions.find((s) => s.object.id === b.object.id)!.reasons).toEqual(["Mentioned alongside this in “Index”"]);
        expect(suggestions.find((s) => s.object.id === c.object.id)!.reasons).toEqual(["Also in “Phonetic”"]);
        expect((await apiCall("GET", `${K}/objects/${a.object.id}/related`, undefined, { email: SECOND_OWNER })).status).toBe(404);
        expect(await related(c.object.id)).toEqual([expect.objectContaining({ object: expect.objectContaining({ id: a.object.id }) })]);
    });

    it("builds similarity queries that can't carry FTS syntax", () => {
        expect(similarityQuery('Transport AND "options" OR NEAR(x)')).toBe('"transport"* OR "options"* OR "near"*');
        expect(similarityQuery("a to of")).toBeNull();
    });
});

describe("pages", () => {
    const render = (html: string) => {
        const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
        const payload = JSON.parse(json!) as { data: PortalPageData; path: string };
        return renderToString(createElement(PortalApp, { data: payload.data, path: payload.path }));
    };

    it("serves and renders every Milestone 3 page for its owner, and none of them to anyone else", async () => {
        const space = await personal();
        const note = await create(space.id, { title: "Packing list", tags: ["travel"] });
        await apiCall("POST", `${K}/objects/${note.object.id}/favourite`, { favourite: true });
        await apiCall("POST", `${K}/objects/${note.object.id}/pin`, { pinned: true });
        const collection = (await apiCall<{ collection: KnowledgeCollection }>("POST", `${K}/spaces/${space.id}/collections`, { name: "Trip to Hobart" })).json
            .collection;
        await apiCall("POST", `${K}/collections/${collection.id}/items`, { objectIds: [note.object.id] });
        const template = (
            await apiCall<{ template: KnowledgeTemplate }>("POST", `${K}/spaces/${space.id}/templates`, { typeId: note.object.typeId, name: "Checklist" })
        ).json.template;
        await apiCall("POST", `${K}/spaces/${space.id}/daily/append`, { text: "Booked the ferry", date: "2026-10-16" });
        const token = await accessToken();
        const pages: [string, string][] = [
            ["/portal/knowledge", "Trip to Hobart"],
            ["/portal/knowledge/daily", "Today"],
            ["/portal/knowledge/daily/2026-10-16", "Booked the ferry"],
            ["/portal/knowledge/collections", "Trip to Hobart"],
            [`/portal/knowledge/c/${collection.id}`, "Packing list"],
            ["/portal/knowledge/favourites", "Packing list"],
            ["/portal/knowledge/templates", "Checklist"],
            [`/portal/knowledge/templates/${template.id}`, "Checklist"],
            ["/portal/knowledge/discover", "Packing list"],
            ["/portal/knowledge/all?links=unlinked&created_from=2026-01-01", "Packing list"],
            [`/portal/knowledge/o/${note.object.id}`, "Trip to Hobart"],
            ["/portal/knowledge/settings", "Download ZIP"],
        ];
        for (const [path, expected] of pages) {
            const response = await call(path, { token });
            expect(response.status, path).toBe(200);
            const html = render(await response.text());
            expect(html, path).not.toContain("Page not found");
            expect(html, path).toContain(expected);
        }
        // The sidebar carries this space's favourites and collections.
        const home = render(await (await call("/portal/knowledge", { token })).text());
        expect(home).toContain(`/portal/knowledge/c/${collection.id}`);
        expect(home).toContain(`/portal/knowledge/o/${note.object.id}`);

        const outsider = await accessToken({ email: SECOND_OWNER });
        for (const path of [`/portal/knowledge/c/${collection.id}`, `/portal/knowledge/templates/${template.id}`, `/portal/knowledge/daily?space=${space.id}`]) {
            const response = await call(path, { token: outsider });
            expect(response.status, path).toBe(404);
            const text = await response.text();
            expect(text, path).not.toContain("Trip to Hobart");
            expect(text, path).not.toContain("Checklist");
        }
        // Their own pages never show my favourites, pins or collections.
        const theirs = await (await call("/portal/knowledge", { token: outsider })).text();
        expect(theirs).not.toContain("Packing list");
        expect(theirs).not.toContain("Trip to Hobart");
        expect((await call("/portal/knowledge/daily/2026-02-30", { token })).status).toBe(404);
    });
});
