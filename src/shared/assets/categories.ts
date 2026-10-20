// Built-in asset categories. The household can add its own (asset_categories, acat_ ids) and add
// custom fields to any category, built-in or not. A category's group decides where it appears
// (Vehicles & Trailers, Home & Property) and whether its assets get vehicle details.

export const CATEGORY_GROUPS = ["vehicles", "home", "equipment", "personal", "other"] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export const CATEGORY_GROUP_LABELS: Record<CategoryGroup, string> = {
    vehicles: "Vehicles & trailers",
    home: "Home",
    equipment: "Equipment",
    personal: "Personal",
    other: "Other",
};

export interface BuiltinCategory {
    id: string;
    label: string;
    group: CategoryGroup;
    /** Assets in this category have vehicle details (registration, odometer, trailer masses). */
    vehicle?: "vehicle" | "trailer" | "caravan" | "motorcycle" | "boat";
}

export const BUILTIN_CATEGORIES = [
    { id: "vehicles", label: "Vehicles", group: "vehicles", vehicle: "vehicle" },
    { id: "trailers", label: "Trailers & caravans", group: "vehicles", vehicle: "trailer" },
    { id: "motorcycles", label: "Motorcycles", group: "vehicles", vehicle: "motorcycle" },
    { id: "boats", label: "Boats", group: "vehicles", vehicle: "boat" },
    { id: "camping", label: "Camping equipment", group: "equipment" },
    { id: "appliances", label: "Appliances", group: "home" },
    { id: "electronics", label: "Electronics", group: "home" },
    { id: "computers", label: "Computers", group: "equipment" },
    { id: "phones", label: "Phones & tablets", group: "personal" },
    { id: "cameras", label: "Cameras", group: "equipment" },
    { id: "tools", label: "Tools", group: "equipment" },
    { id: "furniture", label: "Furniture", group: "home" },
    { id: "outdoor", label: "Outdoor equipment", group: "equipment" },
    { id: "security", label: "Home security", group: "home" },
    { id: "valuables", label: "Personal valuables", group: "personal" },
    { id: "other", label: "Other", group: "other" },
] as const satisfies readonly BuiltinCategory[];

export type BuiltinCategoryId = (typeof BUILTIN_CATEGORIES)[number]["id"];

export const builtinCategory = (id: string): BuiltinCategory | undefined => BUILTIN_CATEGORIES.find((c) => c.id === id);

export const isBuiltinCategory = (id: string) => BUILTIN_CATEGORIES.some((c) => c.id === id);

/** A built-in id, or a household category's acat_ id. */
export const CATEGORY_ID = /^(?:[a-z][a-z0-9_]{1,39}|acat_[a-z0-9]{14})$/;

// --- Custom fields ---------------------------------------------------------------------------------

export const FIELD_TYPES = ["text", "number", "date", "boolean", "select"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface CustomFieldDef {
    key: string;
    label: string;
    type: FieldType;
    options?: string[];
}

export interface AssetCategory {
    id: string;
    label: string;
    group: CategoryGroup;
    builtin: boolean;
    vehicle: BuiltinCategory["vehicle"] | null;
    fields: CustomFieldDef[];
    archived: boolean;
    version: number;
}
