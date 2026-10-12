import { Edit01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import type { SeatingGuest, SeatingTable } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { GuestDropList } from "./guest-drop-list";

/** A small drawing of the table with one dot per seat, filled for seated guests. */
const TableShape = ({ table, seated }: { table: SeatingTable; seated: number }) => {
    const seats = Math.min(table.capacity, 24);
    const dots = Array.from({ length: seats }, (_, i) => {
        if (table.shape === "round") {
            const angle = (i / seats) * Math.PI * 2 - Math.PI / 2;
            return { x: 32 + Math.cos(angle) * 26, y: 32 + Math.sin(angle) * 26 };
        }
        const perSide = Math.ceil(seats / 2);
        const side = i < perSide ? 0 : 1;
        const index = side === 0 ? i : i - perSide;
        return { x: 8 + (48 / Math.max(perSide - 1, 1)) * index, y: side === 0 ? 14 : 50 };
    });
    return (
        <svg viewBox="0 0 64 64" className="size-12 shrink-0" aria-hidden="true">
            {table.shape === "round" ? (
                <circle cx="32" cy="32" r="17" className="fill-bg-secondary stroke-border-primary" strokeWidth="1.5" />
            ) : (
                <rect x="6" y="22" width="52" height="20" rx="3" className="fill-bg-secondary stroke-border-primary" strokeWidth="1.5" />
            )}
            {dots.map((d, i) => (
                <circle
                    key={i}
                    cx={d.x}
                    cy={d.y}
                    r="3.2"
                    className={
                        i < seated ? (seated > table.capacity ? "fill-fg-error-primary" : "fill-fg-brand-primary") : "fill-bg-primary stroke-border-primary"
                    }
                    strokeWidth="1"
                />
            ))}
        </svg>
    );
};

interface TableCardProps {
    table: SeatingTable;
    guests: SeatingGuest[];
    tables: SeatingTable[];
    canEdit: boolean;
    warnings: string[];
    mealLabel: (guest: SeatingGuest) => string | null;
    householdWaiting: (guest: SeatingGuest) => string[];
    onMove: (guestIds: string[], tableId: string | null, position?: number) => void;
    onEdit: () => void;
}

export const TableCard = ({ table, guests, tables, canEdit, warnings, mealLabel, householdWaiting, onMove, onEdit }: TableCardProps) => {
    const over = guests.length > table.capacity;
    const dietary = guests.filter((g) => g.dietary || g.allergies).length;
    return (
        <section
            aria-labelledby={`table-${table.id}`}
            className={cx("flex flex-col gap-3 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset", over && "ring-2 ring-error")}
        >
            <header className="flex items-start gap-3">
                <TableShape table={table} seated={guests.length} />
                <div className="min-w-0 flex-1">
                    <h2 id={`table-${table.id}`} className="truncate text-md font-semibold text-primary">
                        {table.name}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <BadgeWithDot size="sm" color={over ? "error" : guests.length === table.capacity ? "success" : "gray"}>
                            {guests.length} / {table.capacity}
                        </BadgeWithDot>
                        {dietary > 0 && <span className="text-xs text-tertiary">{dietary} dietary</span>}
                    </div>
                </div>
                {canEdit && <ButtonUtility size="xs" color="tertiary" icon={Edit01} tooltip={`Edit ${table.name}`} onClick={onEdit} />}
            </header>
            {warnings.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs text-error-primary">
                    {warnings.map((w) => (
                        <li key={w}>{w}</li>
                    ))}
                </ul>
            )}
            {table.notes && <p className="text-xs text-tertiary">{table.notes}</p>}
            <GuestDropList
                label={`Guests at ${table.name}`}
                tableId={table.id}
                guests={guests}
                tables={tables}
                canEdit={canEdit}
                mealLabel={mealLabel}
                householdWaiting={householdWaiting}
                onMove={onMove}
                empty={canEdit ? "Drag guests here, or use a guest's menu" : "Nobody seated yet"}
            />
        </section>
    );
};
