// Daly Knowledge exports: who may export what, the format, Markdown and ZIP output, and the round
// trip that proves an export is complete (export, delete, restore, export again, compare). Every
// identity and note is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import { checkZip, readZip } from "../scripts/lib/knowledge-export-check.mjs";
import { EXPORT_FORMAT, type KnowledgeExport, parseKnowledgeExport } from "../src/shared/knowledge/export";
import { documentToMarkdown } from "../src/shared/knowledge/markdown";
import type { KnowledgeSearchHit } from "../src/shared/knowledge/types";
import { restoreExport } from "../worker/knowledge/restore";
import { isSafeEntryName } from "../worker/knowledge/zip";
import { ADMIN, K, create, doc, objectLink, paragraph, personal, sharedSpace, text, typeId } from "./knowledge-helpers";
import { OWNER, SECOND_OWNER, accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const download = async (path: string, email = OWNER) => {
    const response = await call(path, { token: await accessToken({ email }) });
    return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
};
const exportJson = async (spaceId: string, email = OWNER) => {
    const result = await download(`${K}/spaces/${spaceId}/export?format=json`, email);
    expect(result.status).toBe(200);
    return JSON.parse(new TextDecoder().decode(result.bytes)) as KnowledgeExport;
};

/** A space using every feature an export has to carry. */
async function richSpace() {
    const space = await personal();
    const person = await typeId(space.id, "person");
    const meeting = await typeId(space.id, "meeting");
    const project = await typeId(space.id, "project");
    const ada = await create(space.id, { typeId: person, title: "Ada Example", properties: { organisation: "Example Co" }, tags: ["family"] });
    const plan = await create(space.id, { typeId: project, title: "Garden makeover", properties: { status: "active", due: "2027-03-01" }, tags: ["home", "outdoors"] });
    const notes = await create(space.id, {
        typeId: meeting,
        title: "Landscaper visit",
        properties: { date: "2026-10-12", participants: [ada.object.id], project: plan.object.id },
        content: doc(
            { type: "heading", attrs: { level: 2 }, content: [text("Decisions")] },
            paragraph(text("Talk to "), objectLink(ada.object.id, "Ada Example"), text(" about "), text("the budget", [{ type: "bold" }])),
            {
                type: "taskList",
                content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("Get three quotes"))] }],
            },
        ),
        tags: ["home"],
    });
    // A manual relation, an archived and a trashed object, a revision beyond the first.
    expect((await apiCall("POST", `${K}/objects/${plan.object.id}/relations`, { targetId: ada.object.id, relationType: "supports" })).status).toBe(201);
    const old = await create(space.id, { title: "Old shed plans" });
    await apiCall("POST", `${K}/objects/${old.object.id}/status/archive`);
    const junk = await create(space.id, { title: "Duplicate note" });
    await apiCall("POST", `${K}/objects/${junk.object.id}/status/trash`);
    await apiCall("PATCH", `${K}/objects/${plan.object.id}`, { version: plan.object.version, content: doc("Plant natives along the fence") });
    // Milestone 3: a daily note, a collection with a pinned item, a home pin, a favourite, a template, saved views.
    await apiCall("POST", `${K}/spaces/${space.id}/daily/append`, { text: "Rang the nursery", date: "2026-10-16" });
    const collection = (await apiCall<{ collection: { id: string } }>("POST", `${K}/spaces/${space.id}/collections`, { name: "Garden" })).json.collection;
    await apiCall("POST", `${K}/collections/${collection.id}/items`, { objectIds: [plan.object.id, notes.object.id] });
    await apiCall("POST", `${K}/collections/${collection.id}/items/${notes.object.id}/pin`, { pinned: true });
    await apiCall("POST", `${K}/objects/${plan.object.id}/pin`, { pinned: true });
    await apiCall("POST", `${K}/objects/${ada.object.id}/favourite`, { favourite: true });
    await apiCall("POST", `${K}/spaces/${space.id}/templates`, { typeId: meeting, name: "Site visit", title: "Visit {date}", content: doc("Purpose") });
    await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "Home projects", shared: false, definition: { typeId: project, tag: "home" } });
    return { space, ada, plan, notes, old, junk, collection };
}

describe("who can export", () => {
    it("lets a space's owners export it, and nobody else", async () => {
        const space = await sharedSpace("editor");
        await create(space.id, { title: "Shared plans" });
        expect((await download(`${K}/spaces/${space.id}/export`)).status).toBe(200);
        // An editor can read everything but can't take the whole space (members, audit trail) away.
        expect((await download(`${K}/spaces/${space.id}/export`, ADMIN)).status).toBe(403);
        // Someone outside it can't even tell it exists.
        const outside = await download(`${K}/spaces/${space.id}/export?format=json`, SECOND_OWNER);
        expect(outside.status).toBe(404);
        expect(new TextDecoder().decode(outside.bytes)).not.toContain("Shared plans");
    });

    it("never lets one person export another's personal space or objects, even another portal owner", async () => {
        const mine = await personal();
        const secret = await create(mine.id, { title: "Private medical notes", content: doc("Fictional details") });
        for (const path of [
            `${K}/spaces/${mine.id}/export`,
            `${K}/spaces/${mine.id}/export?format=json`,
            `${K}/objects/${secret.object.id}/export`,
            `${K}/objects/${secret.object.id}/export?format=json`,
        ]) {
            const result = await download(path, SECOND_OWNER);
            expect(result.status, path).toBe(404);
            expect(new TextDecoder().decode(result.bytes)).not.toContain("medical");
        }
        // Not signed in at all.
        expect((await call(`${K}/spaces/${mine.id}/export`)).status).toBe(401);
        // Not from another site, even signed in.
        const cross = await call(`${K}/spaces/${mine.id}/export`, { token: await accessToken(), headers: { "Sec-Fetch-Site": "cross-site" } });
        expect(cross.status).toBe(403);
    });

    it("lets a viewer export an object they can read", async () => {
        const space = await sharedSpace("viewer");
        const note = await create(space.id, { title: "Recipe: lemon tart" });
        const result = await download(`${K}/objects/${note.object.id}/export`, ADMIN);
        expect(result.status).toBe(200);
        expect(new TextDecoder().decode(result.bytes)).toContain("# Recipe: lemon tart");
    });

    it("leaves other people's favourites and private views out of a shared space's export", async () => {
        const space = await sharedSpace("editor");
        const note = await create(space.id, { title: "Holiday ideas" });
        await apiCall("POST", `${K}/objects/${note.object.id}/favourite`, { favourite: true }, { email: ADMIN });
        await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "Admin's private view", shared: false, definition: {} }, { email: ADMIN });
        await apiCall("POST", `${K}/spaces/${space.id}/views`, { name: "Everyone's view", shared: true, definition: {} }, { email: ADMIN });
        const data = await exportJson(space.id);
        expect(data.favourites).toEqual([]);
        expect(data.savedViews.map((v) => v.name)).toEqual(["Everyone's view"]);
        // Members are emails and roles only.
        expect(data.members).toEqual([
            { email: ADMIN, role: "editor" },
            { email: OWNER, role: "owner" },
        ]);
    });

    it("serves exports as private, uncached, unrendered downloads and records them without titles", async () => {
        const space = await personal();
        const note = await create(space.id, { title: "Tax return 2026" });
        for (const path of [`${K}/spaces/${space.id}/export`, `${K}/objects/${note.object.id}/export?format=json`]) {
            const { headers } = await download(path);
            expect(headers.get("Cache-Control")).toBe("private, no-store");
            expect(headers.get("Content-Disposition")).toMatch(/^attachment; filename="[a-z0-9-]+\.(zip|json)"$/);
            expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
            expect(headers.get("Content-Security-Policy")).toContain("sandbox");
        }
        const audit = await db().prepare("SELECT action, summary, changes FROM knowledge_audit WHERE action LIKE '%.export'").all();
        expect(audit.results.map((r) => r.action)).toEqual(["space.export", "object.export"]);
        expect(JSON.stringify(audit.results)).not.toContain("Tax");
    });
});

describe("the export format", () => {
    it("keeps the editor document, properties, tags, links and history, not just text", async () => {
        const { space, notes, ada, plan } = await richSpace();
        const data = await exportJson(space.id);
        expect(data.format).toBe(EXPORT_FORMAT);
        expect(parseKnowledgeExport(data)).toBeTruthy();
        const meeting = data.objects.find((o) => o.id === notes.object.id)!;
        expect(meeting.content).toEqual(notes.object.content);
        expect(meeting.properties).toEqual({ date: "2026-10-12", participants: [ada.object.id], project: [plan.object.id] });
        expect(meeting.tags).toEqual(["home"]);
        // Content links, property links and the manual link are all there, with their origins.
        const origins = data.relations.map((r) => `${r.sourceId === notes.object.id ? "meeting" : "project"}:${r.origin}:${r.relationType}`).sort();
        expect(origins).toEqual(["meeting:content:mentions", "meeting:property:participants", "meeting:property:project", "project:manual:supports"]);
        expect(data.objects.map((o) => o.status).sort()).toEqual(["active", "active", "active", "active", "archived", "trashed"]);
        expect(data.objects.find((o) => o.dailyDate)?.dailyDate).toBe("2026-10-16");
        expect(data.revisions.filter((r) => r.objectId === plan.object.id).map((r) => r.version)).toEqual([1, 2]);
        expect(data.collections[0].items.map((i) => [i.objectId, !!i.pinnedAt])).toEqual([
            [plan.object.id, false],
            [notes.object.id, true],
        ]);
        expect(data.templates.map((t) => t.name)).toEqual(["Site visit"]);
        expect(data.favourites.map((f) => f.objectId)).toEqual([ada.object.id]);
        expect(data.pins.map((p) => p.objectId)).toEqual([plan.object.id]);
        // The property schema travels with the type.
        expect(data.types.find((t) => t.slug === "meeting")!.schema.properties.map((p) => p.key)).toEqual(["date", "participants", "project"]);
    });

    it("can leave revisions out", async () => {
        const space = await personal();
        await create(space.id, { title: "A note" });
        const result = await download(`${K}/spaces/${space.id}/export?format=json&revisions=0`);
        const data = JSON.parse(new TextDecoder().decode(result.bytes)) as KnowledgeExport;
        expect(data.includes.revisions).toBe(false);
        expect(data.revisions).toEqual([]);
    });

    it("recognises newer versions and refuses them clearly, and refuses broken references", async () => {
        const space = await personal();
        await create(space.id, { title: "A note" });
        const data = await exportJson(space.id);
        expect(() => parseKnowledgeExport({ ...data, format: "daly.knowledge.export.v2" })).toThrow(/version 2/);
        expect(() => parseKnowledgeExport({ format: "something.else" })).toThrow(/isn't a Daly Knowledge export/);
        expect(() => parseKnowledgeExport({ ...data, objects: [{ ...data.objects[0], typeId: "kty_00000000000000" }] })).toThrow(/unknown type/);
        expect(() => parseKnowledgeExport({ ...data, extra: undefined, objects: "nope" })).toThrow(/invalid at objects/);
    });

    it("exports one object with its links by title, as JSON or Markdown", async () => {
        const { notes } = await richSpace();
        const json = await download(`${K}/objects/${notes.object.id}/export?format=json`);
        const data = parseKnowledgeExport(JSON.parse(new TextDecoder().decode(json.bytes)));
        expect(data.scope).toBe("object");
        expect(data.objects).toHaveLength(1);
        expect(data.linkedObjects.map((o) => o.title).sort()).toEqual(["Ada Example", "Garden makeover"]);
        expect(data.members).toEqual([]);

        const md = new TextDecoder().decode((await download(`${K}/objects/${notes.object.id}/export`)).bytes);
        expect(md).toContain(`id: "${notes.object.id}"`);
        expect(md).toContain('type: "Meeting"');
        expect(md).toContain('tags: ["home"]');
        expect(md).toContain('"Participants": ["Ada Example"]');
        expect(md).toContain("# Landscaper visit");
        expect(md).toContain("## Decisions");
        expect(md).toContain("Talk to [[Ada Example]] about **the budget**");
        expect(md).toContain("- [x] Get three quotes");
    });
});

describe("Markdown", () => {
    it("escapes text so nothing in a note becomes markup or HTML", () => {
        const md = documentToMarkdown(
            doc(
                paragraph(text("<script>alert(1)</script> *not bold* [not](a link) & more")),
                paragraph(text("# not a heading")),
                paragraph(text("1. not a list")),
                paragraph(text("click", [{ type: "link", attrs: { href: "https://example.com/a b" } }])),
                paragraph(text("bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])),
                { type: "codeBlock", attrs: { language: "js" }, content: [text("const a = ```;")] },
                { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("a|b"))] }] }] },
            ),
        );
        expect(md).not.toContain("<script>");
        expect(md).toContain("\\<script\\>alert(1)\\</script\\> \\*not bold\\* \\[not\\](a link) \\& more");
        expect(md).toContain("\\# not a heading");
        expect(md).toContain("1\\. not a list");
        expect(md).toContain("[click](<https://example.com/a%20b>)");
        expect(md).not.toContain("javascript:");
        expect(md).toContain("````js\nconst a = ```;\n````");
        expect(md).toContain("| a\\|b |");
    });
});

describe("ZIP export", () => {
    it("holds the manifest and one Markdown file per object, with safe names and working wiki links", async () => {
        const { space, ada } = await richSpace();
        await create(space.id, { title: "../../etc/passwd" });
        await create(space.id, { title: 'Con: a/b\\c*?"<>|' });
        const result = await download(`${K}/spaces/${space.id}/export`);
        expect(result.headers.get("Content-Type")).toBe("application/zip");
        const { problems, manifest, entries } = checkZip(result.bytes);
        expect(problems).toEqual([]);
        expect(entries.every((e) => isSafeEntryName(e.name))).toBe(true);
        expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(["README.md", "manifest.json", "Daily notes/2026-10-16.md"]));
        expect(entries.some((e) => e.name.startsWith("Archive/") && e.name.includes("Old shed plans"))).toBe(true);
        expect(entries.some((e) => e.name.startsWith("Trash/"))).toBe(true);
        const sneaky = entries.find((e) => e.text().includes('title: "../../etc/passwd"'))!;
        expect(sneaky.name).toMatch(/^Objects\/Page\/etc passwd \(kob_[a-z0-9]{14}\)\.md$/);
        // A link to Ada points at Ada's file.
        const meeting = entries.find((e) => e.name.includes("Landscaper visit"))!;
        const adaFile = entries.find((e) => e.text().includes(`id: "${ada.object.id}"`))!;
        expect(meeting.text()).toContain(`[[${adaFile.name.replace(/\.md$/, "")}|Ada Example]]`);
        // The manifest is the same document as the JSON export.
        expect(parseKnowledgeExport(manifest).objects).toHaveLength(manifest!.objects.length);
        expect(readZip(result.bytes).length).toBe(entries.length);
    });
});

describe("round trip", () => {
    it("rebuilds a space from its export exactly, with search working, then exports the same again", async () => {
        const { space } = await richSpace();
        const first = await exportJson(space.id);
        const objectIds = first.objects.map((o) => o.id);

        // Take the space away completely, as if this were an empty database.
        await db()
            .prepare(`DELETE FROM knowledge_fts WHERE rowid IN (SELECT search_rowid FROM knowledge_objects WHERE space_id = ?)`)
            .bind(space.id)
            .run();
        await db().prepare("DELETE FROM knowledge_spaces WHERE id = ?").bind(space.id).run();
        // The audit trail is deliberately not cascaded (it outlives what it records); clear it too.
        await db().prepare("DELETE FROM knowledge_audit WHERE space_id = ?").bind(space.id).run();
        for (const table of ["knowledge_objects", "knowledge_relations", "knowledge_revisions", "knowledge_collections", "knowledge_templates", "knowledge_favourites"])
            expect(await db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE space_id = ?`).bind(space.id).first(), table).toEqual({ n: 0 });

        const restored = await restoreExport(db(), first, OWNER);
        expect(restored).toEqual({ spaceId: space.id, objects: objectIds.length });

        const second = await exportJson(space.id);
        // Identical apart from when it was taken and the audit entry recording the restore itself.
        const comparable = (data: KnowledgeExport) => ({
            ...data,
            exportedAt: "",
            audit: data.audit.filter((a) => a.action !== "space.restore" && a.action !== "space.export"),
        });
        expect(comparable(second)).toEqual(comparable(first));

        // It works as a space again: search, backlinks, daily notes and the collection.
        const hits = (await apiCall<{ hits: KnowledgeSearchHit[] }>("GET", `${K}/search?q=natives`)).json.hits;
        expect(hits.map((h) => h.object.title)).toEqual(["Garden makeover"]);
        const ada = first.objects.find((o) => o.title === "Ada Example")!;
        const detail = (await apiCall<{ backlinks: { object: { title: string } }[] }>("GET", `${K}/objects/${ada.id}`)).json;
        // The meeting both mentions Ada and lists her as a participant: two links.
        expect(detail.backlinks.map((b) => b.object.title).sort()).toEqual(["Garden makeover", "Landscaper visit", "Landscaper visit"]);
        const daily = await apiCall<{ note: { object: { excerpt: string } } }>("GET", `${K}/spaces/${space.id}/daily/2026-10-16`);
        expect(daily.json.note.object.excerpt).toContain("Rang the nursery");
        // Nothing points outside the space.
        const crossing = await db()
            .prepare(
                `SELECT COUNT(*) AS n FROM knowledge_relations r JOIN knowledge_objects s ON s.id = r.source_id JOIN knowledge_objects t ON t.id = r.target_id
                 WHERE s.space_id <> t.space_id OR r.space_id <> s.space_id`,
            )
            .first();
        expect(crossing).toEqual({ n: 0 });
        expect(await db().prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
    });

    it("refuses to restore over a space or objects that already exist", async () => {
        const space = await personal();
        await create(space.id, { title: "A note" });
        const data = await exportJson(space.id);
        await expect(restoreExport(db(), data, OWNER)).rejects.toThrow(/already exists/);
        const other = { ...data, space: { ...data.space, id: "ksp_zzzzzzzzzzzzzz" } };
        await expect(restoreExport(db(), other, OWNER)).rejects.toThrow(/already exist/);
    });

    it("validates documents on the way in, like any save", async () => {
        const space = await personal();
        await create(space.id, { title: "A note" });
        const data = await exportJson(space.id);
        await db().prepare("DELETE FROM knowledge_spaces WHERE id = ?").bind(space.id).run();
        const tampered = { ...data, objects: [{ ...data.objects[0], content: { type: "doc", content: [{ type: "iframe" }] } }] };
        await expect(restoreExport(db(), tampered, OWNER)).rejects.toThrow(/Unsupported content: iframe/);
    });

    it("exports a shared space's members with their roles", async () => {
        const space = await sharedSpace("viewer", "Book club");
        await create(space.id, { title: "Reading list" });
        const data = await exportJson(space.id);
        expect(data.space.kind).toBe("shared");
        expect(data.members.map((m) => m.role).sort()).toEqual(["owner", "viewer"]);
    });
});
