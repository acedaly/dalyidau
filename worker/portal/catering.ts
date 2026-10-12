// Catering numbers, always derived from the guest list and RSVPs for the meal event.
//
// Adults without a chosen category count towards the adult default (the buffet). Children and
// infants never get a category automatically: some eat the adult buffet, some have a children's
// meal, so until someone chooses they're counted as "needs a decision".
import type { D1Database } from "@cloudflare/workers-types";
import type { CateringGuest, CateringSettings, CateringSummary, SeatingGuest } from "../../src/shared/portal/types";
import { eventDef, listEntities } from "./entities";
import { mealEvent, seatingGuests, seatingTableDef } from "./seating";
import { getSettings } from "./settings";

export const effectiveCategory = (guest: Pick<SeatingGuest, "ageGroup" | "mealCategory">, settings: CateringSettings): string | null => {
    if (guest.mealCategory && settings.categories.some((c) => c.id === guest.mealCategory)) return guest.mealCategory;
    return guest.ageGroup === "adult" ? settings.adultDefault : null;
};

export async function cateringSummary(db: D1Database): Promise<CateringSummary> {
    const [settings, events, tables] = await Promise.all([getSettings(db, "catering"), listEntities(db, eventDef), listEntities(db, seatingTableDef)]);
    const event = mealEvent(events, settings);
    const tableName = new Map(tables.map((t) => [t.id, t.name]));
    const all = event ? await seatingGuests(db, event.id) : [];
    const relevant = all.filter((g) => g.status === "attending" || g.status === "pending");

    const count = (status: "attending" | "pending") => {
        const list = relevant.filter((g) => g.status === status);
        const adults = list.filter((g) => g.ageGroup === "adult").length;
        const children = list.filter((g) => g.ageGroup === "child").length;
        const infants = list.filter((g) => g.ageGroup === "infant").length;
        return { adults, children, infants, total: list.length };
    };

    const guests: CateringGuest[] = relevant.map((g) => ({
        id: g.id,
        name: g.name,
        householdName: g.householdName,
        ageGroup: g.ageGroup,
        status: g.status as "attending" | "pending",
        category: effectiveCategory(g, settings),
        chosen: !!g.mealCategory && settings.categories.some((c) => c.id === g.mealCategory),
        dietary: g.dietary,
        allergies: g.allergies,
        tableName: g.tableId ? (tableName.get(g.tableId) ?? null) : null,
    }));

    return {
        event: event ? { id: event.id, name: event.name } : null,
        settings,
        attending: count("attending"),
        awaiting: count("pending"),
        byCategory: settings.categories.map((c) => ({
            id: c.id,
            label: c.label,
            attending: guests.filter((g) => g.status === "attending" && g.category === c.id).length,
            awaiting: guests.filter((g) => g.status === "pending" && g.category === c.id).length,
        })),
        undecided: guests.filter((g) => g.status === "attending" && g.category === null).length,
        guests,
    };
}
