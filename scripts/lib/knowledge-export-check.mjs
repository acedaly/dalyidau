// Checks a Daly Knowledge export without a database: the ZIP's structure and checksums, entry names,
// the manifest's format and version, and that every reference inside it resolves. Plain JavaScript
// with no dependencies, so the CLI (scripts/knowledge-export-check.mjs), Vitest and Playwright all
// use the same checks. It reads the export; it never changes anything.
//
// The Worker's own validator (parseKnowledgeExport in src/shared/knowledge/export.ts) is stricter
// about field shapes; this one is for checking a downloaded file end to end.

export const EXPORT_FORMAT = "daly.knowledge.export.v1";

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

/** Whether a ZIP entry name is safe to extract: relative, no traversal, no odd characters. */
export const isSafeEntryName = (name) =>
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith("/") &&
    !/[\u0000-\u001F\u007F\\:*?"<>|]/.test(name) &&
    name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** Reads a stored (uncompressed) ZIP through its central directory, checking every CRC. */
export function readZip(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--)
        if (view.getUint32(i, true) === 0x06054b50) {
            end = i;
            break;
        }
    if (end < 0) throw new Error("Not a ZIP file: no end-of-directory record");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        const size = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const offset = view.getUint32(at + 42, true);
        const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
        if (method !== 0) throw new Error(`${name}: compressed entries aren't expected in a Daly export`);
        const localName = view.getUint16(offset + 26, true);
        const localExtra = view.getUint16(offset + 28, true);
        const start = offset + 30 + localName + localExtra;
        const body = data.subarray(start, start + size);
        if (crc32(body) !== crc) throw new Error(`${name}: checksum mismatch`);
        entries.push({ name, data: body, text: () => decoder.decode(body) });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/**
 * Problems with an export manifest: wrong format or version, missing sections, duplicate ids and
 * references that point at nothing. An empty list means it's consistent.
 */
export function checkManifest(manifest) {
    const problems = [];
    if (!manifest || typeof manifest !== "object") return ["The manifest isn't a JSON object"];
    const match = /^daly\.knowledge\.export\.v(\d+)$/.exec(manifest.format ?? "");
    if (!match) return ["Not a Daly Knowledge export"];
    if (match[1] !== "1") return [`Format version ${match[1]} isn't supported by this checker`];
    for (const key of ["types", "objects", "relations", "collections", "pins", "templates", "savedViews", "favourites", "revisions", "audit", "members", "linkedObjects"])
        if (!Array.isArray(manifest[key])) problems.push(`Missing section: ${key}`);
    if (problems.length) return problems;
    const ids = (list) => list.map((x) => x.id);
    const dupes = (label, list) => new Set(list).size !== list.length && problems.push(`Duplicate ${label} ids`);
    dupes("type", ids(manifest.types));
    dupes("object", ids(manifest.objects));
    dupes("relation", ids(manifest.relations));
    const types = new Set(ids(manifest.types));
    const objects = new Set(ids(manifest.objects));
    const linkable = new Set([...objects, ...ids(manifest.linkedObjects)]);
    const inside = manifest.scope === "space" ? objects : linkable;
    for (const o of manifest.objects) {
        if (!types.has(o.typeId)) problems.push(`Object ${o.id} has an unknown type`);
        if (o.contentFormat !== "daly.doc.v1" || o.content?.type !== "doc") problems.push(`Object ${o.id} has no editor document`);
    }
    for (const r of manifest.relations) if (!inside.has(r.sourceId) || !inside.has(r.targetId)) problems.push(`Relation ${r.id} points outside the export`);
    for (const c of manifest.collections) for (const item of c.items ?? []) if (!objects.has(item.objectId)) problems.push(`Collection ${c.id} holds an unknown object`);
    for (const p of manifest.pins) if (!objects.has(p.objectId)) problems.push("A pin points at an unknown object");
    for (const f of manifest.favourites) if (!objects.has(f.objectId)) problems.push("A favourite points at an unknown object");
    for (const t of manifest.templates) if (!types.has(t.typeId)) problems.push(`Template ${t.id} has an unknown type`);
    for (const r of manifest.revisions) if (!objects.has(r.objectId)) problems.push(`Revision ${r.id} belongs to an unknown object`);
    return problems;
}

/** Checks a whole ZIP export: entries, names, manifest, and one Markdown file per object. */
export function checkZip(bytes) {
    const entries = readZip(bytes);
    const problems = [];
    for (const e of entries) if (!isSafeEntryName(e.name)) problems.push(`Unsafe entry name: ${JSON.stringify(e.name)}`);
    const manifestEntry = entries.find((e) => e.name === "manifest.json");
    if (!manifestEntry) return { problems: [...problems, "No manifest.json"], manifest: null, entries };
    const manifest = JSON.parse(manifestEntry.text());
    problems.push(...checkManifest(manifest));
    const markdown = entries.filter((e) => e.name.endsWith(".md") && e.name !== "README.md");
    if (Array.isArray(manifest.objects) && markdown.length !== manifest.objects.length)
        problems.push(`${manifest.objects.length} objects but ${markdown.length} Markdown files`);
    for (const o of manifest.objects ?? []) if (!markdown.some((e) => e.text().includes(`id: ${JSON.stringify(o.id)}`))) problems.push(`No Markdown file for ${o.id}`);
    return { problems, manifest, entries };
}

/** Counts for a report, and the space name; never anything from the notes themselves. */
export const summarise = (manifest) => ({
    space: manifest.space?.name,
    exportedAt: manifest.exportedAt,
    types: manifest.types.length,
    objects: manifest.objects.length,
    relations: manifest.relations.length,
    collections: manifest.collections.length,
    templates: manifest.templates.length,
    revisions: manifest.revisions.length,
});
