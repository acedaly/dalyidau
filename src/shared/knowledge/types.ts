// Data shapes for Daly Knowledge, shared by the Worker (worker/knowledge) and the browser.
import type { DocNode } from "./content";
import type { PropertyValues, TypeSchema } from "./properties";

export const SPACE_ROLES = ["owner", "editor", "viewer"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SPACE_ROLE_LABELS: Record<SpaceRole, { label: string; description: string }> = {
    owner: { label: "Owner", description: "Everything, including members, permanent deletion and the space's audit trail." },
    editor: { label: "Editor", description: "Create, edit, organise, archive and trash objects and types." },
    viewer: { label: "Viewer", description: "Read and search only." },
};

const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, owner: 3 };
export const roleAtLeast = (role: SpaceRole, minimum: SpaceRole) => RANK[role] >= RANK[minimum];

export interface KnowledgeSpace {
    id: string;
    name: string;
    kind: "personal" | "shared";
    timeZone: string;
    /** The signed-in person's role in this space. */
    role: SpaceRole;
}

export const TYPE_ICONS = [
    "file",
    "user",
    "folder",
    "calendar",
    "check",
    "book",
    "compass",
    "alert",
    "clock",
    "star",
    "lightbulb",
    "link",
    "building",
    "flag",
] as const;
export type TypeIcon = (typeof TYPE_ICONS)[number];

export interface KnowledgeType {
    id: string;
    spaceId: string;
    name: string;
    slug: string;
    icon: TypeIcon;
    description: string;
    schema: TypeSchema;
    sortOrder: number;
    archived: boolean;
    version: number;
    /** Objects of this type that aren't in the trash. */
    objectCount: number;
}

export type ObjectStatus = "active" | "archived" | "trashed";

export interface KnowledgeObjectSummary {
    id: string;
    spaceId: string;
    typeId: string;
    title: string;
    status: ObjectStatus;
    inInbox: boolean;
    /** The first couple of hundred characters of the text. */
    excerpt: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    updatedBy: string;
}

export interface KnowledgeObject extends KnowledgeObjectSummary {
    content: DocNode;
    contentFormat: string;
    properties: PropertyValues;
    version: number;
    createdBy: string;
    archivedAt: string | null;
    trashedAt: string | null;
}

export type RelationOrigin = "manual" | "content" | "property";

export interface KnowledgeLink {
    relationId: string;
    relationType: string;
    origin: RelationOrigin;
    object: Pick<KnowledgeObjectSummary, "id" | "title" | "typeId" | "status">;
}

export interface KnowledgeObjectDetail {
    object: KnowledgeObject;
    /** Links from this object (in its text, its properties or added by hand). */
    outgoing: KnowledgeLink[];
    /** Links to this object from other objects. */
    backlinks: KnowledgeLink[];
    /** Titles of objects referenced by reference properties, so they can be shown without another request. */
    referenced: Record<string, Pick<KnowledgeObjectSummary, "id" | "title" | "typeId" | "status">>;
}

export interface KnowledgeRevision {
    id: string;
    version: number;
    kind: "create" | "edit" | "restore" | "import";
    title: string;
    changedBy: string;
    startedAt: string;
    changedAt: string;
}

export interface KnowledgeRevisionDetail extends KnowledgeRevision {
    typeId: string;
    content: DocNode;
    properties: PropertyValues;
}

/** Search snippets mark matches with these characters; render them as highlights, never as HTML. */
export const HIGHLIGHT_START = "\u0002";
export const HIGHLIGHT_END = "\u0003";

export interface KnowledgeSearchHit {
    object: KnowledgeObjectSummary;
    titleSnippet: string;
    bodySnippet: string;
}

export interface KnowledgeMember {
    email: string;
    name: string | null;
    role: SpaceRole;
    addedBy: string;
    createdAt: string;
}

export interface KnowledgeAuditEntry {
    id: number;
    at: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string | null;
    summary: string;
}

export type ListView = "all" | "inbox" | "archived" | "trashed";
export type ListSort = "updated" | "created" | "title";

export interface ListFilters {
    view: ListView;
    typeId: string | null;
    tag: string | null;
    sort: ListSort;
}

interface KnowledgeShell {
    space: KnowledgeSpace;
    spaces: KnowledgeSpace[];
    types: KnowledgeType[];
}

export type KnowledgeRoute =
    | (KnowledgeShell & {
          route: "knowledge-home";
          recent: KnowledgeObjectSummary[];
          inbox: KnowledgeObjectSummary[];
          counts: { active: number; inbox: number; archived: number; trashed: number };
      })
    | (KnowledgeShell & { route: "knowledge-list"; filters: ListFilters; objects: KnowledgeObjectSummary[]; total: number; tags: string[] })
    | (KnowledgeShell & { route: "knowledge-object"; detail: KnowledgeObjectDetail })
    | (KnowledgeShell & { route: "knowledge-search"; query: string; hits: KnowledgeSearchHit[]; typeId: string | null; allSpaces: boolean })
    | (KnowledgeShell & { route: "knowledge-types" })
    | (KnowledgeShell & { route: "knowledge-settings"; members: KnowledgeMember[]; audit: KnowledgeAuditEntry[] | null });
