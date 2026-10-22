// Built-in categories and groups. They live in code, so nothing has to be written to the database
// for categorising to work; the household adds its own (finance_categories, fcat_ ids) on top.
// A category is income or expense. Transfers between the household's own accounts aren't a
// category at all: they're marked as transfers and never count as income or spending.

export type CategoryKind = "income" | "expense";

export interface CategoryGroup {
    id: string;
    name: string;
    kind: CategoryKind;
}

export interface CategoryDef {
    id: string;
    name: string;
    kind: CategoryKind;
    groupId: string;
    builtin: boolean;
    archived?: boolean;
    /** Household categories only: for compare-and-set edits. */
    version?: number;
}

export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
    { id: "income", name: "Income", kind: "income" },
    { id: "home", name: "Home", kind: "expense" },
    { id: "food", name: "Food & drink", kind: "expense" },
    { id: "transport", name: "Transport", kind: "expense" },
    { id: "bills", name: "Bills & utilities", kind: "expense" },
    { id: "health", name: "Health & wellbeing", kind: "expense" },
    { id: "personal", name: "Personal & family", kind: "expense" },
    { id: "lifestyle", name: "Lifestyle", kind: "expense" },
    { id: "financial", name: "Financial", kind: "expense" },
    { id: "other", name: "Other", kind: "expense" },
];

const c = (id: string, name: string, groupId: string, kind: CategoryKind = "expense"): CategoryDef => ({ id, name, kind, groupId, builtin: true });

export const BUILTIN_CATEGORIES: readonly CategoryDef[] = [
    c("salary", "Salary & wages", "income", "income"),
    c("interest", "Interest", "income", "income"),
    c("refunds", "Refunds & reimbursements", "income", "income"),
    c("gifts-received", "Gifts received", "income", "income"),
    c("government", "Government payments", "income", "income"),
    c("other-income", "Other income", "income", "income"),
    c("rent-mortgage", "Rent or mortgage", "home"),
    c("home-maintenance", "Home maintenance", "home"),
    c("furnishings", "Furniture & household", "home"),
    c("groceries", "Groceries", "food"),
    c("dining", "Eating out & takeaway", "food"),
    c("coffee", "Coffee", "food"),
    c("alcohol", "Alcohol", "food"),
    c("fuel", "Vehicle fuel", "transport"),
    c("vehicle", "Vehicle costs", "transport"),
    c("public-transport", "Public transport", "transport"),
    c("tolls-parking", "Tolls & parking", "transport"),
    c("rideshare", "Taxis & rideshare", "transport"),
    c("electricity-gas", "Electricity & gas", "bills"),
    c("water", "Water", "bills"),
    c("internet-phone", "Internet & phone", "bills"),
    c("insurance", "Insurance", "bills"),
    c("subscriptions", "Subscriptions", "bills"),
    c("council-strata", "Council rates & strata", "bills"),
    c("medical", "Medical & pharmacy", "health"),
    c("fitness", "Fitness", "health"),
    c("clothing", "Clothing", "personal"),
    c("personal-care", "Personal care", "personal"),
    c("pets", "Pets", "personal"),
    c("children", "Children", "personal"),
    c("education", "Education", "personal"),
    c("gifts-donations", "Gifts & donations", "personal"),
    c("entertainment", "Entertainment", "lifestyle"),
    c("holidays", "Holidays & travel", "lifestyle"),
    c("hobbies", "Hobbies", "lifestyle"),
    c("shopping", "General shopping", "lifestyle"),
    c("fees", "Bank fees & interest charged", "financial"),
    c("tax", "Tax", "financial"),
    c("wedding", "Wedding", "other"),
    c("other-expense", "Other spending", "other"),
];

export const BUILTIN_CATEGORY_IDS = new Set(BUILTIN_CATEGORIES.map((category) => category.id));
export const CATEGORY_GROUP_IDS = new Set(CATEGORY_GROUPS.map((group) => group.id));

export const groupName = (id: string) => CATEGORY_GROUPS.find((group) => group.id === id)?.name ?? "Other";
