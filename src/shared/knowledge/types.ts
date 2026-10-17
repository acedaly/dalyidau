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
    /** Set for daily notes: the calendar date the note belongs to. */
    dailyDate: string | null;
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
    /** After creating from a template: template values that couldn't be used with the type as it is now. */
    notices?: string[];
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

export interface KnowledgeTemplate {
    id: string;
    spaceId: string;
    typeId: string;
    name: string;
    description: string;
    /** The new object's title; {date} becomes today's date in the space. */
    title: string;
    content: DocNode;
    properties: PropertyValues;
    isDefault: boolean;
    archived: boolean;
    version: number;
    updatedBy: string;
    updatedAt: string;
}

export interface KnowledgeCollection {
    id: string;
    spaceId: string;
    name: string;
    description: string;
    archived: boolean;
    version: number;
    /** Objects in it that aren't in the trash. */
    itemCount: number;
    updatedAt: string;
}

export interface CollectionItem extends KnowledgeObjectSummary {
    position: number;
    pinned: boolean;
}

/** A light reference to an object, for navigation (favourites, pins, the sidebar). */
export type ObjectRef = Pick<KnowledgeObjectSummary, "id" | "spaceId" | "title" | "typeId" | "status" | "dailyDate" | "updatedAt">;

export interface KnowledgeSavedView {
    id: string;
    name: string;
    /** Shared with everyone in the space, or private to its creator. */
    shared: boolean;
    mine: boolean;
    definition: ListFilters;
    version: number;
}

export interface RelatedSuggestion {
    object: ObjectRef;
    score: number;
    /** "strong": several signals or a strong one. "possible": a single weaker signal, worth a look. */
    strength: "strong" | "possible";
    /** Plain-language reasons, e.g. "Shares 3 tags: wedding, venue, transport". */
    reasons: string[];
}

export interface DailyNoteDay {
    date: string;
    id: string;
    title: string;
    excerpt: string;
}

export type ListView = "all" | "inbox" | "archived" | "trashed";
export type ListSort = "updated" | "created" | "title";
/** For finding disconnected knowledge: objects with no links to or from other (untrashed) objects. */
export const LINK_FILTERS = ["any", "unlinked", "no_backlinks", "no_outgoing"] as const;
export type LinkFilter = (typeof LINK_FILTERS)[number];

export interface ListFilters {
    view: ListView;
    typeId: string | null;
    tag: string | null;
    sort: ListSort;
    links?: LinkFilter;
    /** Calendar dates (YYYY-MM-DD) in the space's time zone, inclusive. */
    createdFrom?: string | null;
    createdTo?: string | null;
    updatedFrom?: string | null;
    updatedTo?: string | null;
}

export type TemplateRef = Pick<KnowledgeTemplate, "id" | "name" | "typeId" | "isDefault">;

interface KnowledgeShell {
    space: KnowledgeSpace;
    spaces: KnowledgeSpace[];
    types: KnowledgeType[];
    /** Templates that aren't archived, for "New". */
    templates: TemplateRef[];
    /** The sidebar's own sections for this space. */
    nav: { favourites: ObjectRef[]; collections: Pick<KnowledgeCollection, "id" | "name">[]; today: string };
}

export type KnowledgeRoute =
    | (KnowledgeShell & {
          route: "knowledge-home";
          recent: KnowledgeObjectSummary[];
          inbox: KnowledgeObjectSummary[];
          pinned: ObjectRef[];
          collections: KnowledgeCollection[];
          todayNote: DailyNoteDay | null;
          counts: { active: number; inbox: number; archived: number; trashed: number };
      })
    | (KnowledgeShell & {
          route: "knowledge-list";
          filters: ListFilters;
          objects: KnowledgeObjectSummary[];
          total: number;
          tags: string[];
          views: KnowledgeSavedView[];
          savedView: KnowledgeSavedView | null;
      })
    | (KnowledgeShell & {
          route: "knowledge-object";
          detail: KnowledgeObjectDetail;
          state: { favourite: boolean; pinned: boolean };
          collections: { id: string; name: string }[];
      })
    | (KnowledgeShell & {
          route: "knowledge-daily";
          date: string;
          today: string;
          note: KnowledgeObjectDetail | null;
          recent: DailyNoteDay[];
          /** Dates near this one that have a note with something in it. */
          marked: string[];
      })
    | (KnowledgeShell & { route: "knowledge-collections"; collections: KnowledgeCollection[] })
    | (KnowledgeShell & { route: "knowledge-collection"; collection: KnowledgeCollection; items: CollectionItem[]; total: number })
    | (KnowledgeShell & { route: "knowledge-favourites"; favourites: ObjectRef[] })
    | (KnowledgeShell & { route: "knowledge-templates"; allTemplates: KnowledgeTemplate[] })
    | (KnowledgeShell & { route: "knowledge-template"; template: KnowledgeTemplate })
    | (KnowledgeShell & {
          route: "knowledge-discover";
          lists: Record<"unlinked" | "no_backlinks" | "no_outgoing", { objects: KnowledgeObjectSummary[]; total: number }>;
          /** Of the objects listed, those that are tagged or in a collection. */
          organised: string[];
      })
    | (KnowledgeShell & { route: "knowledge-search"; query: string; hits: KnowledgeSearchHit[]; typeId: string | null; allSpaces: boolean })
    | (KnowledgeShell & { route: "knowledge-types" })
    | (KnowledgeShell & { route: "knowledge-settings"; members: KnowledgeMember[]; audit: KnowledgeAuditEntry[] | null });
