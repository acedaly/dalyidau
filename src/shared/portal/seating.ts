// Seating checks, shared by the planner, its print view and the CSV report. They warn; they never
// block. Separating a household, for example, can be exactly what the couple wants.
import type { SeatingGuest, SeatingTable } from "./types";

export type SeatingWarning =
    | { kind: "over_capacity"; tableId: string; message: string }
    | { kind: "declined_seated"; tableId: string; guestId: string; message: string }
    | { kind: "unseated"; guestId: string; message: string }
    | { kind: "household_split"; householdId: string; tableIds: string[]; message: string }
    | { kind: "plus_one_apart"; guestId: string; message: string };

/** Guests who need a seat: anyone attending or still to reply (declined and uninvited guests don't). */
export const needsSeat = (g: SeatingGuest) => g.status === "attending" || g.status === "pending";

export function seatingWarnings(tables: SeatingTable[], guests: SeatingGuest[]): SeatingWarning[] {
    const warnings: SeatingWarning[] = [];
    const tableName = new Map(tables.map((t) => [t.id, t.name]));
    for (const table of tables) {
        const seated = guests.filter((g) => g.tableId === table.id).length;
        if (seated > table.capacity)
            warnings.push({ kind: "over_capacity", tableId: table.id, message: `${table.name} has ${seated} guests for ${table.capacity} seats` });
    }
    for (const g of guests) {
        if (g.tableId && g.status === "declined") {
            warnings.push({
                kind: "declined_seated",
                tableId: g.tableId,
                guestId: g.id,
                message: `${g.name} declined but is seated at ${tableName.get(g.tableId)}`,
            });
        }
        if (!g.tableId && needsSeat(g)) warnings.push({ kind: "unseated", guestId: g.id, message: `${g.name} doesn't have a seat yet` });
    }
    const households = new Map<string, Set<string>>();
    for (const g of guests) {
        if (!g.householdId || !g.tableId || g.status === "declined") continue;
        households.set(g.householdId, (households.get(g.householdId) ?? new Set()).add(g.tableId));
    }
    for (const [householdId, ids] of households) {
        if (ids.size < 2) continue;
        const name = guests.find((g) => g.householdId === householdId)?.householdName ?? "A household";
        warnings.push({
            kind: "household_split",
            householdId,
            tableIds: [...ids],
            message: `${name} is split across ${[...ids].map((id) => tableName.get(id)).join(" and ")}`,
        });
    }
    const byId = new Map(guests.map((g) => [g.id, g]));
    for (const g of guests) {
        const partner = g.plusOneOf ? byId.get(g.plusOneOf) : undefined;
        if (partner && g.tableId && partner.tableId && g.tableId !== partner.tableId) {
            warnings.push({ kind: "plus_one_apart", guestId: g.id, message: `${g.name} isn't at the same table as ${partner.name}` });
        }
    }
    return warnings;
}
