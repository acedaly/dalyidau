// Print-only seating reports. Hidden on screen; when printed, the planner UI is hidden instead.
// Three parts, each starting on a new page: the plan by table, guests A–Z with their table, and
// dietary needs by table for the caterer.
import type { SeatingGuest, SeatingState } from "@/shared/portal/types";

export type PrintMode = "plan" | "guests" | "dietary";

export const SeatingPrint = ({ state, title, mode }: { state: SeatingState; title: string; mode: PrintMode }) => {
    const byTable = (id: string) => state.guests.filter((g) => g.tableId === id).sort((a, b) => a.position - b.position);
    const tableName = new Map(state.tables.map((t) => [t.id, t.name]));
    const category = new Map(state.categories.map((c) => [c.id, c.label]));
    const seated = state.guests.filter((g) => g.tableId).sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
    const marks = (g: SeatingGuest) =>
        [g.ageGroup !== "adult" ? (g.ageGroup === "child" ? "child" : "infant") : "", g.mealCategory ? category.get(g.mealCategory) : ""]
            .filter(Boolean)
            .join(", ");

    return (
        <div className="hidden text-black print:block">
            <h1 className="text-xl font-semibold">{title}</h1>
            {mode === "plan" && (
                <div className="mt-4 columns-2 gap-8">
                    {state.tables.map((table) => (
                        <section key={table.id} className="mb-6 break-inside-avoid">
                            <h2 className="border-b border-black pb-1 text-md font-semibold">
                                {table.name}{" "}
                                <span className="font-normal">
                                    ({byTable(table.id).length} of {table.capacity})
                                </span>
                            </h2>
                            <ol className="mt-2 list-decimal pl-5 text-sm">
                                {byTable(table.id).map((g) => (
                                    <li key={g.id}>
                                        {g.name}
                                        {marks(g) && <span className="text-xs"> ({marks(g)})</span>}
                                        {(g.dietary || g.allergies) && <span className="text-xs"> *</span>}
                                    </li>
                                ))}
                            </ol>
                        </section>
                    ))}
                    <p className="text-xs">* dietary requirements or allergies; see the dietary report.</p>
                </div>
            )}
            {mode === "guests" && (
                <table className="mt-4 w-full text-sm">
                    <thead>
                        <tr className="border-b border-black text-left">
                            <th className="py-1">Guest</th>
                            <th className="py-1">Table</th>
                        </tr>
                    </thead>
                    <tbody>
                        {seated.map((g) => (
                            <tr key={g.id} className="break-inside-avoid border-b border-secondary">
                                <td className="py-1">{g.name}</td>
                                <td className="py-1">{tableName.get(g.tableId!)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {mode === "dietary" && (
                <div className="mt-4">
                    {state.tables.map((table) => {
                        const needs = byTable(table.id).filter((g) => g.dietary || g.allergies || g.ageGroup !== "adult" || g.mealCategory);
                        if (needs.length === 0) return null;
                        return (
                            <section key={table.id} className="mb-5 break-inside-avoid">
                                <h2 className="border-b border-black pb-1 text-md font-semibold">{table.name}</h2>
                                <table className="mt-1 w-full text-sm">
                                    <tbody>
                                        {needs.map((g) => (
                                            <tr key={g.id} className="border-b border-secondary">
                                                <td className="w-1/4 py-1">{g.name}</td>
                                                <td className="w-1/5 py-1">{marks(g)}</td>
                                                <td className="py-1">{[g.dietary, g.allergies && `ALLERGY: ${g.allergies}`].filter(Boolean).join(" · ")}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
