// Daly Knowledge: privacy between spaces, roles, the object engine, revisions, links, search and
// the audit trail. Every identity here is fictional.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import type { DocNode } from "../src/shared/knowledge/content";
import {
    HIGHLIGHT_END,
    HIGHLIGHT_START,
    type KnowledgeObjectDetail,
    type KnowledgeSearchHit,
    type KnowledgeSpace,
    type KnowledgeType,
} from "../src/shared/knowledge/types";
import type { PortalPageData } from "../src/shared/portal/types";
import { KNOWLEDGE_FTS_REBUILD } from "../worker/knowledge/search";
import { ORIGIN, OWNER, SECOND_OWNER, accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

const K = "/api/portal/knowledge";
const ADMIN = "admin@example.com";
const EDITOR = "wedding-editor@example.com";

beforeEach(resetPortal);

const spaces = async (email = OWNER) => (await apiCall<{ spaces: KnowledgeSpace[] }>("GET", `${K}/spaces`, undefined, { email })).json.spaces;
const personal = async (email = OWNER) => (await spaces(email)).find((s) => s.kind === "personal")!;
const typesOf = async (spaceId: string, email = OWNER) =>
    (await apiCall<{ types: KnowledgeType[] }>("GET", `${K}/spaces/${spaceId}/types`, undefined, { email })).json.types;
const typeId = async (spaceId: string, slug: string, email = OWNER) => (await typesOf(spaceId, email)).find((t) => t.slug === slug)!.id;

const paragraph = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
const text = (value: string, marks?: DocNode["marks"]): DocNode => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const objectLink = (id: string, label: string): DocNode => ({ type: "objectLink", attrs: { id, label } });
const doc = (...blocks: (string | DocNode)[]): DocNode => ({ type: "doc", content: blocks.map((b) => (typeof b === "string" ? paragraph(text(b)) : b)) });

const create = async (spaceId: string, body: Record<string, unknown>, email = OWNER) => {
    const result = await apiCall<KnowledgeObjectDetail>("POST", `${K}/spaces/${spaceId}/objects`, body, { email });
    expect(result.status, result.text).toBe(201);
    return result.json;
};
const patch = (id: string, body: Record<string, unknown>, email = OWNER) =>
    apiCall<KnowledgeObjectDetail & { current?: { version: number } }>("PATCH", `${K}/objects/${id}`, body, { email });
const search = async (q: string, params = "", email = OWNER) =>
    (await apiCall<{ hits: KnowledgeSearchHit[] }>("GET", `${K}/search?q=${encodeURIComponent(q)}${params}`, undefined, { email })).json.hits;
const auditRows = async () =>
    (await db().prepare("SELECT action, summary, changes FROM knowledge_audit ORDER BY id").all<{ action: string; summary: string; changes: string | null }>())
        .results;

const addPortalUser = (email: string, role: "admin" | "editor" | "viewer") => apiCall("POST", "/api/portal/users", { email, role });

/** A shared space owned by OWNER, with ADMIN as a member in the given role. */
const sharedSpace = async (role: "owner" | "editor" | "viewer") => {
    await addPortalUser(ADMIN, "admin");
    const created = await apiCall<{ space: KnowledgeSpace }>("POST", `${K}/spaces`, { name: "Household" });
    expect(created.status, created.text).toBe(201);
    const added = await apiCall("POST", `${K}/spaces/${created.json.space.id}/members`, { email: ADMIN, role });
    expect(added.status, added.text).toBe(201);
    return created.json.space;
};

describe("migration 0013", () => {
    it("lets the database itself refuse links, tags and revisions that cross spaces", async () => {
        const mine = await personal();
        const theirs = await personal(SECOND_OWNER);
        const a = await create(mine.id, { title: "Mine" });
        const b = await create(theirs.id, { title: "Theirs" }, SECOND_OWNER);
        const now = new Date().toISOString();
        // Even if application code were wrong, a relation between two spaces can't be written.
        await expect(
            db()
                .prepare(
                    "INSERT INTO knowledge_relations (id, space_id, source_id, target_id, relation_type, origin, created_by, created_at) VALUES ('krl_x', ?, ?, ?, 'related', 'manual', ?, ?)",
                )
                .bind(mine.id, a.object.id, b.object.id, OWNER, now)
                .run(),
        ).rejects.toThrow(/FOREIGN KEY/);
        // Nor an object whose type belongs to another space.
        const foreignType = await typeId(theirs.id, "page", SECOND_OWNER);
        await expect(db().prepare("UPDATE knowledge_objects SET type_id = ? WHERE id = ?").bind(foreignType, a.object.id).run()).rejects.toThrow(/FOREIGN KEY/);
    });

    it("allows only one personal space per person, even when two first visits race", async () => {
        await Promise.all([spaces(), spaces(), spaces()]);
        const rows = await db().prepare("SELECT COUNT(*) AS n FROM knowledge_spaces WHERE personal_owner = ?").bind(OWNER).first<{ n: number }>();
        expect(rows!.n).toBe(1);
        expect(await typesOf((await personal()).id)).toHaveLength(7);
        // One creation entry, for the space that was actually created.
        expect((await auditRows()).filter((r) => r.action === "space.create")).toHaveLength(1);
    });

    it("rebuilds the search index from the ordinary tables, as a restored backup does", async () => {
        const space = await personal();
        await create(space.id, { title: "Bushfire season planning", content: doc("Check the hydrants"), tags: ["seasonal"] });
        await db().prepare("DELETE FROM knowledge_fts").run();
        expect(await search("hydrants")).toEqual([]);
        await db().batch(KNOWLEDGE_FTS_REBUILD.map((sql) => db().prepare(sql)));
        expect((await search("hydrants")).map((h) => h.object.title)).toEqual(["Bushfire season planning"]);
        expect((await search("seasonal")).map((h) => h.object.title)).toEqual(["Bushfire season planning"]);
    });

    it("gives the backup script the same rebuild statements the Worker uses", async () => {
        const { default: script } = await import("../scripts/lib/virtual-tables.mjs?raw");
        const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();
        for (const statement of KNOWLEDGE_FTS_REBUILD) expect(flat(script)).toContain(flat(statement));
    });
});

describe("privacy between people", () => {
    it("never shows one person's knowledge to another, even another portal owner", async () => {
        const mine = await personal();
        const secret = await create(mine.id, { title: "Private journal", content: doc("Something personal"), tags: ["private"] });
        const id = secret.object.id;

        const theirs = await personal(SECOND_OWNER);
        expect(theirs.id).not.toBe(mine.id);
        expect((await spaces(SECOND_OWNER)).map((s) => s.id)).toEqual([theirs.id]);

        // Every way in looks like the object doesn't exist.
        for (const [method, path, body] of [
            ["GET", `${K}/objects/${id}`],
            ["PATCH", `${K}/objects/${id}`, { version: 1, title: "Mine now" }],
            ["GET", `${K}/objects/${id}/revisions`],
            ["POST", `${K}/objects/${id}/status/trash`],
            ["POST", `${K}/objects/${id}/relations`, { targetId: id }],
            ["GET", `${K}/spaces/${mine.id}/objects`],
            ["GET", `${K}/spaces/${mine.id}/types`],
            ["GET", `${K}/spaces/${mine.id}/lookup?q=Private`],
            ["GET", `${K}/spaces/${mine.id}/members`],
            ["POST", `${K}/spaces/${mine.id}/objects`, { title: "Planted" }],
            ["GET", `${K}/search?q=journal&space=${mine.id}`],
        ] as const) {
            const result = await apiCall(method, path, body, { email: SECOND_OWNER });
            expect(result.status, `${method} ${path}`).toBe(404);
            expect(result.text).not.toContain("Private journal");
        }
        expect(await search("journal", "", SECOND_OWNER)).toEqual([]);
        expect(await search("private", "", SECOND_OWNER)).toEqual([]);

        // The page is the ordinary 404 and carries nothing from the object.
        const page = await call(`/portal/knowledge/o/${id}`, { token: await accessToken({ email: SECOND_OWNER }) });
        expect(page.status).toBe(404);
        expect(await page.text()).not.toContain("Private journal");
        const spacePage = await call(`/portal/knowledge/all?space=${mine.id}`, { token: await accessToken({ email: SECOND_OWNER }) });
        expect(spacePage.status).toBe(404);

        // Nothing changed.
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${id}`)).json.object.title).toBe("Private journal");
    });

    it("keeps Knowledge closed to portal roles without it, and to no one signed in", async () => {
        await addPortalUser(EDITOR, "editor");
        expect((await apiCall("GET", `${K}/spaces`, undefined, { email: EDITOR })).status).toBe(403);
        expect((await call("/portal/knowledge", { token: await accessToken({ email: EDITOR }) })).status).toBe(403);
        const launcher = await (await call("/portal", { token: await accessToken({ email: EDITOR }) })).text();
        expect(launcher).not.toContain('"knowledge"');
        expect((await call(`${K}/spaces`)).status).toBe(401);
        expect((await call("/portal/knowledge")).status).toBe(401);
        // Only owners and admins get a personal space.
        expect(await db().prepare("SELECT COUNT(*) AS n FROM knowledge_spaces WHERE personal_owner = ?").bind(EDITOR).first()).toEqual({ n: 0 });
    });

    it("refuses cross-site requests", async () => {
        const space = await personal();
        const token = await accessToken();
        const result = await call(`${K}/spaces/${space.id}/objects`, {
            method: "POST",
            token,
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: JSON.stringify({ title: "x" }),
        });
        expect(result.status).toBe(403);
        const read = await call(`${K}/search?q=x`, { token, headers: { "Sec-Fetch-Site": "cross-site" } });
        expect(read.status).toBe(403);
    });

    it("writes knowledge to its own audit trail, without titles or text, never to the portal audit log", async () => {
        const space = await personal();
        const object = await create(space.id, { title: "Salary negotiation", content: doc("Ask for more") });
        await patch(object.object.id, { version: 1, content: doc("Ask for a lot more") });
        const rows = await auditRows();
        expect(rows.map((r) => r.action)).toEqual(["space.create", "object.create", "object.update"]);
        expect(JSON.stringify(rows)).not.toMatch(/Salary|Ask for/);
        expect(JSON.parse(rows[2].changes!)).toEqual({ fields: ["content"] });
        const portalAudit = await db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type LIKE 'knowledge%' OR action LIKE 'object.%'").first();
        expect(portalAudit).toEqual({ n: 0 });
    });
});

describe("shared spaces and roles", () => {
    it("lets viewers read and search but not change anything", async () => {
        const space = await sharedSpace("viewer");
        const note = await create(space.id, { title: "Grocery list", content: doc("Milk and eggs") });
        expect((await apiCall("GET", `${K}/objects/${note.object.id}`, undefined, { email: ADMIN })).status).toBe(200);
        expect((await search("eggs", "", ADMIN)).map((h) => h.object.title)).toEqual(["Grocery list"]);
        for (const [method, path, body] of [
            ["POST", `${K}/spaces/${space.id}/objects`, { title: "x" }],
            ["PATCH", `${K}/objects/${note.object.id}`, { version: 1, title: "x" }],
            ["POST", `${K}/objects/${note.object.id}/status/trash`, {}],
            ["POST", `${K}/spaces/${space.id}/types`, { name: "Recipe" }],
            ["POST", `${K}/spaces/${space.id}/objects/bulk`, { ids: [note.object.id], action: "archive" }],
            ["POST", `${K}/spaces/${space.id}/members`, { email: OWNER, role: "viewer" }],
        ] as const) {
            expect((await apiCall(method, path, body, { email: ADMIN })).status, `${method} ${path}`).toBe(403);
        }
    });

    it("lets editors edit and trash, but only owners delete permanently or manage members", async () => {
        const space = await sharedSpace("editor");
        const note = await create(space.id, { title: "Holiday plan" }, ADMIN);
        expect((await patch(note.object.id, { version: 1, title: "Holiday plan 2027" }, ADMIN)).status).toBe(200);
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/status/trash`, {}, { email: ADMIN })).status).toBe(200);
        expect((await apiCall("POST", `${K}/objects/${note.object.id}/delete`, { confirm: "DELETE" }, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("GET", `${K}/spaces/${space.id}/audit`, undefined, { email: ADMIN })).status).toBe(403);
        expect((await apiCall("PATCH", `${K}/spaces/${space.id}/members/${OWNER}`, { role: "viewer" }, { email: ADMIN })).status).toBe(403);
    });

    it("keeps at least one owner, refuses to share personal spaces and only adds people who can open Knowledge", async () => {
        const space = await sharedSpace("editor");
        expect((await apiCall("PATCH", `${K}/spaces/${space.id}/members/${OWNER}`, { role: "editor" })).status).toBe(422);
        expect((await apiCall("DELETE", `${K}/spaces/${space.id}/members/${OWNER}`)).status).toBe(422);
        // With a second owner, the first can step down.
        expect((await apiCall("PATCH", `${K}/spaces/${space.id}/members/${ADMIN}`, { role: "owner" })).status).toBe(200);
        expect((await apiCall("PATCH", `${K}/spaces/${space.id}/members/${OWNER}`, { role: "editor" })).status).toBe(200);

        const mine = await personal();
        expect((await apiCall("POST", `${K}/spaces/${mine.id}/members`, { email: ADMIN, role: "viewer" })).status).toBe(422);

        await addPortalUser(EDITOR, "editor");
        const refused = await apiCall("POST", `${K}/spaces/${space.id}/members`, { email: EDITOR, role: "viewer" }, { email: ADMIN });
        expect(refused.status).toBe(422);
        expect((await apiCall("POST", `${K}/spaces/${space.id}/members`, { email: "stranger@example.com", role: "viewer" }, { email: ADMIN })).status).toBe(
            422,
        );
        expect((await auditRows()).map((r) => r.action)).toEqual(expect.arrayContaining(["member.add", "member.role"]));
    });

    it("takes access away as soon as someone is removed", async () => {
        const space = await sharedSpace("editor");
        const note = await create(space.id, { title: "Shared note" });
        expect((await apiCall("GET", `${K}/objects/${note.object.id}`, undefined, { email: ADMIN })).status).toBe(200);
        expect((await apiCall("DELETE", `${K}/spaces/${space.id}/members/${ADMIN}`)).status).toBe(200);
        expect((await apiCall("GET", `${K}/objects/${note.object.id}`, undefined, { email: ADMIN })).status).toBe(404);
        expect(await search("Shared", "", ADMIN)).toEqual([]);
    });
});

describe("objects", () => {
    it("creates, edits, archives, trashes and restores objects", async () => {
        const space = await personal();
        const created = await create(space.id, {
            title: "  Weekly   review ",
            content: doc("Look back"),
            tags: ["Routine", "routine", "#habits"],
            inInbox: true,
        });
        expect(created.object).toMatchObject({ title: "Weekly review", status: "active", inInbox: true, version: 1, tags: ["habits", "Routine"] });
        expect(created.object.typeId).toBe(await typeId(space.id, "page"));

        const id = created.object.id;
        const edited = await patch(id, { version: 1, title: "Weekly review (Sunday)", inInbox: false });
        expect(edited.json.object).toMatchObject({ title: "Weekly review (Sunday)", inInbox: false, version: 2 });

        // A save that changes nothing writes nothing.
        expect((await patch(id, { version: 2, title: "Weekly review (Sunday)" })).json.object.version).toBe(2);

        await apiCall("POST", `${K}/objects/${id}/status/archive`);
        let list = await apiCall<{ objects: { id: string }[] }>("GET", `${K}/spaces/${space.id}/objects?view=archived`);
        expect(list.json.objects.map((o) => o.id)).toEqual([id]);
        expect((await apiCall("POST", `${K}/objects/${id}/status/archive`)).status).toBe(409);

        await apiCall("POST", `${K}/objects/${id}/status/trash`);
        expect((await patch(id, { version: 4, title: "Edited in the trash" })).status).toBe(409);
        list = await apiCall("GET", `${K}/spaces/${space.id}/objects?view=trashed`);
        expect(list.json.objects.map((o) => o.id)).toEqual([id]);
        expect(await search("Sunday")).toEqual([]);

        await apiCall("POST", `${K}/objects/${id}/status/restore`);
        expect((await search("Sunday")).map((h) => h.object.id)).toEqual([id]);
    });

    it("deletes permanently only from the trash, with confirmation, taking its history with it", async () => {
        const space = await personal();
        const a = await create(space.id, { title: "Old draft" });
        const b = await create(space.id, { title: "Index", content: doc(paragraph(objectLink(a.object.id, "Old draft"))) });
        const id = a.object.id;
        expect((await apiCall("POST", `${K}/objects/${id}/delete`, { confirm: "DELETE" })).status).toBe(409);
        await apiCall("POST", `${K}/objects/${id}/status/trash`);
        expect((await apiCall("POST", `${K}/objects/${id}/delete`, { confirm: "yes" })).status).toBe(422);
        expect((await apiCall("POST", `${K}/objects/${id}/delete`, { confirm: "DELETE" })).status).toBe(200);
        expect((await apiCall("GET", `${K}/objects/${id}`)).status).toBe(404);
        for (const table of ["knowledge_revisions", "knowledge_relations"]) {
            const column = table === "knowledge_relations" ? "target_id" : "object_id";
            expect(await db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(id).first(), table).toEqual({ n: 0 });
        }
        // Only the index, which still mentions it by name, is found now.
        expect((await search("draft")).map((h) => h.object.id)).toEqual([b.object.id]);
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${b.object.id}`)).json.outgoing).toEqual([]);
        expect((await auditRows()).at(-1)!.action).toBe("object.delete_permanently");
    });

    it("refuses to overwrite someone else's newer save, and says which version is current", async () => {
        const space = await sharedSpace("editor");
        const note = await create(space.id, { title: "Agenda", content: doc("1. Budget") });
        const id = note.object.id;
        expect((await patch(id, { version: 1, content: doc("1. Budget", "2. Venue") }, ADMIN)).status).toBe(200);

        const stale = await patch(id, { version: 1, content: doc("1. Budget", "2. Catering") });
        expect(stale.status).toBe(409);
        expect(stale.json.current).toMatchObject({ version: 2, updatedBy: ADMIN });
        const current = (await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${id}`)).json.object;
        expect(current.content).toEqual(doc("1. Budget", "2. Venue"));

        // Two saves from the same starting version at once: exactly one wins.
        const results = await Promise.all([patch(id, { version: 2, title: "A" }), patch(id, { version: 2, title: "B" }, ADMIN)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it("validates documents: unknown content is refused, unsafe links too, and text is never HTML", async () => {
        const space = await personal();
        const bad = [
            { type: "doc", content: [{ type: "script", content: [] }] },
            {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
            },
            {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "//evil.example" } }] }] }],
            },
            { type: "doc", content: [{ type: "text", text: "loose text" }] },
            { type: "doc", content: [{ type: "image", attrs: { src: "https://tracker.example/pixel.gif" } }] },
            "not a document",
        ];
        for (const content of bad)
            expect((await apiCall("POST", `${K}/spaces/${space.id}/objects`, { title: "x", content })).status, JSON.stringify(content)).toBe(422);

        const html = await create(space.id, {
            title: "<img src=x onerror=alert(1)>",
            content: doc(
                paragraph(text("<script>alert(1)</script>", [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com", onclick: "x" } }])),
            ),
        });
        expect(html.object.title).toBe("<img src=x onerror=alert(1)>");
        expect(html.object.content.content![0].content![0].marks).toEqual([{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }]);
        // The page embeds data as JSON that can't close its script tag.
        const page = await (await call(`/portal/knowledge/o/${html.object.id}`, { token: await accessToken() })).text();
        expect(page).not.toContain("<script>alert(1)</script>");
        expect(page).not.toContain("<img src=x onerror");
    });

    it("keeps one revision per editing session and restores old versions as new ones", async () => {
        const space = await sharedSpace("editor");
        const note = await create(space.id, { title: "Speech", content: doc("Draft one") });
        const id = note.object.id;
        const session = "session-tab-one";
        await patch(id, { version: 1, content: doc("Draft two"), session });
        await patch(id, { version: 2, content: doc("Draft three"), session });
        const list = async () =>
            (await apiCall<{ revisions: { id: string; version: number; kind: string; changedBy: string }[] }>("GET", `${K}/objects/${id}/revisions`)).json
                .revisions;
        // Autosaves in one session update one revision; the creation snapshot is kept as it was.
        expect((await list()).map((r) => [r.kind, r.version])).toEqual([
            ["edit", 3],
            ["create", 1],
        ]);
        // Another session, even the same person's other tab, always starts a new revision, so nobody's
        // work is folded into anyone else's; and so does a save that names no session at all.
        await patch(id, { version: 3, content: doc("Draft four"), session: "session-tab-two" });
        await patch(id, { version: 4, content: doc("Draft five"), session }, ADMIN);
        await patch(id, { version: 5, content: doc("Draft four") });
        expect((await list()).map((r) => [r.version, r.changedBy])).toEqual([
            [6, OWNER],
            [5, ADMIN],
            [4, OWNER],
            [3, OWNER],
            [1, OWNER],
        ]);

        const original = (await list()).find((r) => r.kind === "create")!;
        const old = await apiCall<{ revision: { content: DocNode } }>("GET", `${K}/objects/${id}/revisions/${original.id}`);
        expect(old.json.revision.content).toEqual(doc("Draft one"));

        expect((await apiCall("POST", `${K}/objects/${id}/revisions/${original.id}/restore`, { version: 1 })).status).toBe(409);
        const restored = await apiCall<KnowledgeObjectDetail>("POST", `${K}/objects/${id}/revisions/${original.id}/restore`, { version: 6 });
        expect(restored.json.object).toMatchObject({ version: 7, content: doc("Draft one") });
        expect((await list()).map((r) => [r.kind, r.version])[0]).toEqual(["restore", 7]);
        expect(await search("four")).toEqual([]);
        expect((await search("one")).map((h) => h.object.id)).toEqual([id]);
        // A revision belongs to its object: it can't be read or restored through another one.
        const other = await create(space.id, { title: "Other" });
        expect((await apiCall("GET", `${K}/objects/${other.object.id}/revisions/${original.id}`)).status).toBe(404);
    });

    it("bulk-archives, files and restores only what's in the space and in the right state", async () => {
        const space = await personal();
        const a = await create(space.id, { title: "A", inInbox: true });
        const b = await create(space.id, { title: "B", inInbox: true });
        const other = await create((await personal(SECOND_OWNER)).id, { title: "Not mine" }, SECOND_OWNER);
        const filed = await apiCall<{ changed: number }>("POST", `${K}/spaces/${space.id}/objects/bulk`, { ids: [a.object.id, b.object.id], action: "file" });
        expect(filed.json.changed).toBe(2);
        const archived = await apiCall<{ changed: number }>("POST", `${K}/spaces/${space.id}/objects/bulk`, {
            ids: [a.object.id, other.object.id],
            action: "archive",
        });
        expect(archived.json.changed).toBe(1);
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${other.object.id}`, undefined, { email: SECOND_OWNER })).json.object.status).toBe(
            "active",
        );
    });
});

describe("properties and types", () => {
    it("validates properties against the object's type on the server", async () => {
        const space = await personal();
        const project = await typeId(space.id, "project");
        const created = await create(space.id, { typeId: project, title: "Kitchen renovation", properties: { due: "2027-02-01" } });
        // Defaults apply on create.
        expect(created.object.properties).toEqual({ status: "planned", due: "2027-02-01" });

        const id = created.object.id;
        for (const [properties, message] of [
            [{ status: "abandoned" }, /Status/],
            [{ due: "2027-02-30" }, /Due/],
            [{ budget: 100 }, /no such property/],
            [{ area: ["kob_doesnotexist00"] }, /Area/],
        ] as const) {
            const result = await patch(id, { version: 1, properties });
            expect(result.status, JSON.stringify(properties)).toBe(422);
            expect(result.text).toMatch(message);
        }
        expect((await patch(id, { version: 1, properties: { status: "active", due: null } })).json.object.properties).toEqual({ status: "active" });
    });

    it("turns reference properties and links in the text into backlinks, only within the space", async () => {
        const space = await personal();
        const person = await create(space.id, { typeId: await typeId(space.id, "person"), title: "Jordan Sample" });
        const page = await create(space.id, { title: "Not a person" });
        const meetingType = await typeId(space.id, "meeting");
        const foreign = await create((await personal(SECOND_OWNER)).id, { title: "Elsewhere" }, SECOND_OWNER);

        expect(
            (await apiCall("POST", `${K}/spaces/${space.id}/objects`, { typeId: meetingType, title: "x", properties: { participants: [page.object.id] } }))
                .status,
        ).toBe(422);

        const meeting = await create(space.id, {
            typeId: meetingType,
            title: "Kick-off",
            properties: { participants: [person.object.id] },
            content: doc(
                paragraph(text("With "), objectLink(person.object.id, "Jordan Sample"), text(" and "), objectLink(foreign.object.id, "Elsewhere")),
                paragraph(text("Notes", [{ type: "link", attrs: { href: `/portal/knowledge/o/${page.object.id}` } }])),
            ),
        });
        expect(meeting.outgoing.map((l) => [l.object.title, l.relationType, l.origin])).toEqual([
            ["Jordan Sample", "mentions", "content"],
            ["Not a person", "mentions", "content"],
            ["Jordan Sample", "participants", "property"],
        ]);
        expect(meeting.referenced[person.object.id].title).toBe("Jordan Sample");

        const backlinks = (await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${person.object.id}`)).json.backlinks;
        expect(backlinks.map((l) => [l.object.title, l.relationType])).toEqual([
            ["Kick-off", "mentions"],
            ["Kick-off", "participants"],
        ]);
        // The other person's object learns nothing.
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${foreign.object.id}`, undefined, { email: SECOND_OWNER })).json.backlinks).toEqual(
            [],
        );

        // Removing the link from the text removes the backlink; trashed sources don't show.
        await patch(meeting.object.id, { version: 1, content: doc("Rescheduled") });
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${person.object.id}`)).json.backlinks.map((l) => l.relationType)).toEqual([
            "participants",
        ]);
        await apiCall("POST", `${K}/objects/${meeting.object.id}/status/trash`);
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${person.object.id}`)).json.backlinks).toEqual([]);
    });

    it("adds and removes typed links by hand", async () => {
        const space = await personal();
        const a = await create(space.id, { title: "Decision" });
        const b = await create(space.id, { title: "Rationale" });
        const linked = await apiCall<KnowledgeObjectDetail>("POST", `${K}/objects/${a.object.id}/relations`, {
            targetId: b.object.id,
            relationType: "Based on",
        });
        expect(linked.status).toBe(201);
        expect(linked.json.outgoing).toEqual([expect.objectContaining({ relationType: "based_on", origin: "manual" })]);
        expect((await apiCall("POST", `${K}/objects/${a.object.id}/relations`, { targetId: b.object.id, relationType: "based_on" })).status).toBe(409);
        expect((await apiCall("POST", `${K}/objects/${a.object.id}/relations`, { targetId: a.object.id })).status).toBe(422);
        const relationId = linked.json.outgoing[0].relationId;
        expect((await apiCall("DELETE", `${K}/relations/${relationId}`, undefined, { email: SECOND_OWNER })).status).toBe(404);
        expect((await apiCall("DELETE", `${K}/relations/${relationId}`)).status).toBe(200);
    });

    it("creates and changes types without losing stored values", async () => {
        const space = await personal();
        const created = await apiCall<{ type: KnowledgeType }>("POST", `${K}/spaces/${space.id}/types`, {
            name: "Recipe",
            icon: "star",
            schema: {
                properties: [
                    { key: "serves", label: "Serves", type: "number", required: true },
                    { key: "cuisine", label: "Cuisine", type: "select", options: [{ id: "thai", label: "Thai" }] },
                ],
            },
        });
        expect(created.status, created.text).toBe(201);
        const recipe = created.json.type;
        expect(recipe.slug).toBe("recipe");
        expect((await apiCall("POST", `${K}/spaces/${space.id}/objects`, { typeId: recipe.id, title: "Curry" })).status).toBe(422);
        const curry = await create(space.id, { typeId: recipe.id, title: "Curry", properties: { serves: 4, cuisine: "thai" } });

        const changeType = await apiCall("PATCH", `${K}/types/${recipe.id}`, {
            version: 1,
            schema: { properties: [{ key: "serves", label: "Serves", type: "text" }] },
        });
        expect(changeType.status).toBe(422);
        const removed = await apiCall<{ type: KnowledgeType }>("PATCH", `${K}/types/${recipe.id}`, {
            version: 1,
            name: "Recipes",
            schema: { properties: [{ key: "serves", label: "Serves", type: "number" }] },
        });
        expect(removed.status, removed.text).toBe(200);
        expect(removed.json.type).toMatchObject({ name: "Recipes", slug: "recipe", version: 2 });
        // The cuisine value stays on the object even though the type no longer shows it.
        expect((await apiCall<KnowledgeObjectDetail>("GET", `${K}/objects/${curry.object.id}`)).json.object.properties).toEqual({ serves: 4, cuisine: "thai" });
        expect((await apiCall("PATCH", `${K}/types/${recipe.id}`, { version: 1, name: "Stale" })).status).toBe(409);
        // The removed key still holds values, so it can't return as a different kind of property.
        const reused = await apiCall("PATCH", `${K}/types/${recipe.id}`, {
            version: 2,
            schema: {
                properties: [
                    { key: "serves", label: "Serves", type: "number" },
                    { key: "cuisine", label: "Cuisine", type: "url" },
                ],
            },
        });
        expect(reused.status).toBe(422);

        const theirType = await typeId((await personal(SECOND_OWNER)).id, "person", SECOND_OWNER);
        const crossSpace = await apiCall("POST", `${K}/spaces/${space.id}/types`, {
            name: "Bad",
            schema: { properties: [{ key: "who", label: "Who", type: "object", targetTypeId: theirType }] },
        });
        expect(crossSpace.status).toBe(422);
        expect((await apiCall("PATCH", `${K}/types/${theirType}`, { version: 1, name: "Mine" })).status).toBe(404);
    });
});

describe("search", () => {
    it("finds titles, text and tags by prefix, ranks titles first and highlights matches safely", async () => {
        const space = await personal();
        await create(space.id, { title: "Garden notes", content: doc("Plant tomatoes in spring") });
        await create(space.id, { title: "Tomato sauce", content: doc("Grandma's recipe") });
        await create(space.id, { title: "Shopping", tags: ["tomatoes"] });
        const hits = await search("tomat");
        expect(hits[0].object.title).toBe("Tomato sauce");
        expect(hits.map((h) => h.object.title).sort()).toEqual(["Garden notes", "Shopping", "Tomato sauce"]);
        expect(hits[0].titleSnippet).toBe(`${HIGHLIGHT_START}Tomato${HIGHLIGHT_END} sauce`);
        expect(hits.find((h) => h.object.title === "Garden notes")!.bodySnippet).toContain(`${HIGHLIGHT_START}tomatoes${HIGHLIGHT_END}`);
        expect((await search('"plant tomatoes"')).map((h) => h.object.title)).toEqual(["Garden notes"]);
        expect(await search('"tomatoes plant"')).toEqual([]);
    });

    it("treats FTS syntax in the query as text, never as an error or a way around the filters", async () => {
        const space = await personal();
        await create(space.id, { title: "Alpha" });
        for (const q of [
            'title:alpha OR "',
            "alpha) OR (*",
            "NEAR(alpha",
            "*",
            "-alpha",
            "alpha AND NOT beta",
            "^alpha",
            "'; DROP TABLE knowledge_objects; --",
        ]) {
            const result = await apiCall("GET", `${K}/search?q=${encodeURIComponent(q)}`);
            expect(result.status, q).toBe(200);
        }
        expect((await db().prepare("SELECT COUNT(*) AS n FROM knowledge_objects").first<{ n: number }>())!.n).toBe(1);
    });

    it("filters by type, tag, status and date", async () => {
        const space = await personal();
        const meeting = await typeId(space.id, "meeting");
        await create(space.id, { typeId: meeting, title: "Budget meeting", tags: ["finance"] });
        const archived = await create(space.id, { title: "Budget 2025" });
        await apiCall("POST", `${K}/objects/${archived.object.id}/status/archive`);
        expect((await search("budget")).map((h) => h.object.title)).toEqual(["Budget meeting"]);
        expect((await search("budget", "&status=any")).length).toBe(2);
        expect((await search("budget", "&status=archived")).map((h) => h.object.title)).toEqual(["Budget 2025"]);
        expect((await search("budget", `&type=${meeting}&status=any`)).map((h) => h.object.title)).toEqual(["Budget meeting"]);
        expect((await search("budget", "&tag=finance&status=any")).map((h) => h.object.title)).toEqual(["Budget meeting"]);
        expect(await search("budget", "&to=2000-01-01&status=any")).toEqual([]);
    });

    it("keeps hostile or malformed result limits bounded", async () => {
        const space = await personal();
        await Promise.all([
            create(space.id, { title: "Bounded alpha" }),
            create(space.id, { title: "Bounded beta" }),
            create(space.id, { title: "Bounded gamma" }),
        ]);
        expect(await search("bounded", "&limit=-1")).toHaveLength(1);
        expect(await search("bounded", "&limit=Infinity")).toHaveLength(3);
    });

    it("looks up titles for [[ links within one space", async () => {
        const space = await personal();
        await create(space.id, { title: "Project Phoenix" });
        await create(space.id, { title: "Phoenix retrospective" });
        await create((await personal(SECOND_OWNER)).id, { title: "Phoenix (theirs)" }, SECOND_OWNER);
        const lookup = await apiCall<{ results: { title: string }[] }>("GET", `${K}/spaces/${space.id}/lookup?q=phoe`);
        expect(lookup.json.results.map((r) => r.title)).toEqual(["Phoenix retrospective", "Project Phoenix"]);
        const escaped = await apiCall<{ results: unknown[] }>("GET", `${K}/spaces/${space.id}/lookup?q=%25`);
        expect(escaped.json.results).toEqual([]);
    });
});

describe("pages", () => {
    /** Pages render in the browser from the data the Worker embeds; render them here from exactly that. */
    const render = (html: string) => {
        const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
        const payload = JSON.parse(json!) as { data: PortalPageData; path: string };
        return renderToString(createElement(PortalApp, { data: payload.data, path: payload.path }));
    };

    it("serves and renders every Knowledge page for its owner", async () => {
        const space = await personal();
        const person = await create(space.id, { typeId: await typeId(space.id, "person"), title: "Riley Example" });
        const note = await create(space.id, {
            typeId: await typeId(space.id, "meeting"),
            title: "Hello",
            content: doc("World", paragraph(objectLink(person.object.id, "Riley Example"))),
            properties: { participants: [person.object.id], date: "2027-01-05" },
            tags: ["greeting"],
            inInbox: true,
        });
        const token = await accessToken();
        for (const path of [
            "/portal/knowledge",
            "/portal/knowledge/inbox",
            "/portal/knowledge/all",
            "/portal/knowledge/archive",
            "/portal/knowledge/trash",
            "/portal/knowledge/search?q=hello",
            "/portal/knowledge/types",
            "/portal/knowledge/settings",
            `/portal/knowledge/o/${note.object.id}`,
        ]) {
            const response = await call(path, { token, headers: { Origin: ORIGIN } });
            expect(response.status, path).toBe(200);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            const html = render(await response.text());
            expect(html, path).not.toContain("Page not found");
        }
        const page = render(await (await call(`/portal/knowledge/o/${note.object.id}`, { token })).text());
        expect(page).toContain("Riley Example");
        expect(page).toContain("greeting");
        const search = render(await (await call("/portal/knowledge/search?q=world", { token })).text());
        expect(search).toContain("<mark");
        expect((await call("/portal/knowledge/o/kob_aaaaaaaaaaaaaa", { token })).status).toBe(404);
    });
});
