// Subset of the Capacities API v1 schema (https://api.capacities.io/openapi.json) used by the sync.

export interface LabelOption {
    id: string;
    name: string;
    color?: string;
}

export interface PropertyDefinition {
    id: string;
    name: string;
    type: string;
    writable?: boolean;
    multiple?: boolean;
    labelSet?: LabelOption[];
}

export interface Structure {
    id: string;
    title: string;
    pluralName?: string;
    propertyDefinitions: PropertyDefinition[];
}

export interface DatePayload {
    dateResolution: "time" | "day";
    start: string | null;
    end: string | null;
}

export type PropertyValue =
    | { type: "title"; title: { value: string | null } }
    | { type: "text"; text: { value: string | null } }
    | { type: "number"; number: { value: number | null } }
    | { type: "boolean"; boolean: { value: boolean | null } }
    | { type: "url"; url: { value: string | null } }
    | { type: "date"; date: DatePayload }
    | { type: "label"; label: LabelOption[] }
    | { type: "entity"; entity: { id: string }[] }
    | { type: "aliases"; aliases: { value: string[] } }
    | { type: "icon"; icon: unknown }
    | { type: "createdAt"; createdAt: { value: string } }
    | { type: "lastUpdatedAt"; lastUpdatedAt: { value: string } }
    | { type: "richText"; richText: { value: Token[] } };

export interface TextStyle {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
}

export type Token =
    | { type: "TextToken"; text: string; style?: TextStyle; color?: string }
    | { type: "LinkToken"; text: string; url?: string; entityId?: string; date?: DatePayload }
    | { type: "MathToken"; text: string }
    | { type: "CodeToken"; text: string };

export type ListType = "bullet" | "alphabetical" | "numerical" | "roman";

export interface TextBlock {
    id: string;
    type: "TextBlock";
    tokens: Token[];
    blocks: Block[];
    hierarchy: { key: string; val: number };
    list?: { type: ListType } | null;
    todo?: { isDone: boolean };
    toggle?: { isOpen: boolean } | null;
    quote?: { layout: "normal" | "standout" };
    colorTheme?: string;
}

export interface GroupBlock {
    id: string;
    type: "GroupBlock";
    blocks: Block[];
    list?: { type: ListType } | null;
    todo?: { isDone: boolean };
    toggle?: { isOpen: boolean } | null;
    colorTheme?: string;
}

export interface GridBlock {
    id: string;
    type: "GridBlock";
    columns: Block[][];
    dividers: number[];
    gridLayout?: "columns" | "grid";
}

export interface CodeBlock {
    id: string;
    type: "CodeBlock";
    lang: string;
    text: string;
}

export interface MathBlock {
    id: string;
    type: "MathBlock";
    text: string;
}

export interface EntityBlock {
    id: string;
    type: "EntityBlock";
    entityId: string | null;
    date?: DatePayload;
}

export interface HorizontalLineBlock {
    id: string;
    type: "HorizontalLineBlock";
}

export interface UnsupportedBlock {
    id: string;
    type: "unsupported";
    blockType: string;
}

export type Block = TextBlock | GroupBlock | GridBlock | CodeBlock | MathBlock | EntityBlock | HorizontalLineBlock | UnsupportedBlock;

export interface CapacitiesObject {
    id: string;
    structureId: string;
    collections: string[];
    properties: Record<string, PropertyValue>;
    blocks?: Record<string, Block[]>;
    files?: { url: string; fileType: string; expirationDate?: string }[];
}

export interface ObjectSummary {
    id: string;
    structureId: string;
    title: string;
}
