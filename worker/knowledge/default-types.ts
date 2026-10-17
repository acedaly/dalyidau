// The object types every new space starts with. People can rename, extend or archive them, and add
// their own, without code changes. Workplace-specific types (e.g. Incident, Shift) are deliberately
// not seeded: create them by hand once there's data-governance approval for what goes in them.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { PropertyDef } from "../../src/shared/knowledge/properties";
import type { TypeIcon } from "../../src/shared/knowledge/types";
import { newId } from "../portal/db";

export interface Seed {
    slug: string;
    name: string;
    icon: TypeIcon;
    description: string;
    properties: (ids: Record<string, string>) => PropertyDef[];
}

const prop = (def: Partial<PropertyDef> & Pick<PropertyDef, "key" | "label" | "type">): PropertyDef => ({ required: false, description: "", ...def });

export const DEFAULT_TYPES: Seed[] = [
    { slug: "page", name: "Page", icon: "file", description: "General notes and documents.", properties: () => [] },
    {
        slug: "person",
        name: "Person",
        icon: "user",
        description: "People you work with or know.",
        properties: () => [
            prop({ key: "organisation", label: "Organisation", type: "text" }),
            prop({ key: "role", label: "Role", type: "text" }),
            prop({ key: "email", label: "Email", type: "email" }),
            prop({ key: "phone", label: "Phone", type: "phone" }),
        ],
    },
    {
        slug: "project",
        name: "Project",
        icon: "folder",
        description: "Work with an outcome and an end.",
        properties: (ids) => [
            prop({
                key: "status",
                label: "Status",
                type: "select",
                options: [
                    { id: "planned", label: "Planned" },
                    { id: "active", label: "Active" },
                    { id: "on_hold", label: "On hold" },
                    { id: "done", label: "Done" },
                ],
                default: "planned",
            }),
            prop({ key: "due", label: "Due", type: "date" }),
            prop({ key: "area", label: "Area", type: "object", targetTypeId: ids.area }),
        ],
    },
    {
        slug: "meeting",
        name: "Meeting",
        icon: "calendar",
        description: "Meetings, with who was there and what came of them.",
        properties: (ids) => [
            prop({ key: "date", label: "Date", type: "date" }),
            prop({ key: "participants", label: "Participants", type: "person", multiple: true }),
            prop({ key: "project", label: "Project", type: "object", targetTypeId: ids.project }),
        ],
    },
    {
        slug: "decision",
        name: "Decision",
        icon: "check",
        description: "What was decided, why, and by whom.",
        properties: (ids) => [
            prop({
                key: "status",
                label: "Status",
                type: "select",
                options: [
                    { id: "proposed", label: "Proposed" },
                    { id: "decided", label: "Decided" },
                    { id: "superseded", label: "Superseded" },
                ],
                default: "proposed",
            }),
            prop({ key: "decided_on", label: "Decided on", type: "date" }),
            prop({ key: "project", label: "Project", type: "object", targetTypeId: ids.project }),
        ],
    },
    {
        slug: "resource",
        name: "Resource",
        icon: "book",
        description: "Articles, books, documents and links worth keeping.",
        properties: () => [prop({ key: "url", label: "Link", type: "url" }), prop({ key: "author", label: "Author", type: "text" })],
    },
    { slug: "area", name: "Area", icon: "compass", description: "Ongoing areas of responsibility.", properties: () => [] },
];

/** Inserts for the default types of a new space, optionally conditional (see ensurePersonalSpace). */
export function seedTypeStatements(db: D1Database, spaceId: string, actor: string, now: string, condition = ""): D1PreparedStatement[] {
    const ids = Object.fromEntries(DEFAULT_TYPES.map((seed) => [seed.slug, newId("kty")]));
    return DEFAULT_TYPES.map((seed, index) =>
        db
            .prepare(
                `INSERT INTO knowledge_object_types (id, space_id, name, slug, icon, description, schema_json, sort_order, created_by, updated_by, created_at, updated_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${condition}`,
            )
            .bind(
                ids[seed.slug],
                spaceId,
                seed.name,
                seed.slug,
                seed.icon,
                seed.description,
                JSON.stringify({ properties: seed.properties(ids) }),
                index,
                actor,
                actor,
                now,
                now,
                ...(condition ? [spaceId] : []),
            ),
    );
}

/** One type, added if the space doesn't already have its slug. */
export const seedTypeStatement = (db: D1Database, spaceId: string, actor: string, now: string, seed: Seed): D1PreparedStatement =>
    db
        .prepare(
            `INSERT OR IGNORE INTO knowledge_object_types (id, space_id, name, slug, icon, description, schema_json, sort_order, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM knowledge_object_types WHERE space_id = ?), ?, ?, ?, ?)`,
        )
        .bind(newId("kty"), spaceId, seed.name, seed.slug, seed.icon, seed.description, JSON.stringify({ properties: seed.properties({}) }), spaceId, actor, actor, now, now);
