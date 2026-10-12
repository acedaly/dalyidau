// A list of guests that guests can be dragged into, out of and within. Built on React Aria's
// GridList drag and drop, which includes keyboard and screen-reader dragging (focus a guest,
// press Enter, move to a list with Tab/arrows, press Enter to drop). The "Move to…" menu on every
// guest is a second, simpler alternative.
import type { ReactNode } from "react";
import { DropIndicator, GridList, GridListItem, isTextDropItem, useDragAndDrop } from "react-aria-components";
import type { SeatingGuest, SeatingTable } from "@/shared/portal/types";
import { cx } from "@/utils/cx";
import { GuestChip } from "./guest-chip";

export const GUEST_DRAG_TYPE = "application/x-wedding-guest";

interface GuestDropListProps {
    label: string;
    /** The table these guests sit at, or null for the unseated pool. */
    tableId: string | null;
    guests: SeatingGuest[];
    tables: SeatingTable[];
    canEdit: boolean;
    mealLabel: (guest: SeatingGuest) => string | null;
    householdWaiting: (guest: SeatingGuest) => string[];
    onMove: (guestIds: string[], tableId: string | null, position?: number) => void;
    empty: ReactNode;
    className?: string;
}

export const GuestDropList = ({ label, tableId, guests, tables, canEdit, mealLabel, householdWaiting, onMove, empty, className }: GuestDropListProps) => {
    const read = async (items: Parameters<NonNullable<Parameters<typeof useDragAndDrop>[0]["onRootDrop"]>>[0]["items"]) =>
        Promise.all(items.filter(isTextDropItem).map((item) => item.getText(GUEST_DRAG_TYPE)));

    const { dragAndDropHooks } = useDragAndDrop({
        isDisabled: !canEdit,
        getItems: (keys) => [...keys].map((key) => ({ [GUEST_DRAG_TYPE]: String(key), "text/plain": guests.find((g) => g.id === key)?.name ?? String(key) })),
        acceptedDragTypes: [GUEST_DRAG_TYPE],
        getDropOperation: () => "move",
        // Dropped from another list: insert at the drop position.
        onInsert: async (e) => {
            const ids = await read(e.items);
            const index = guests.findIndex((g) => g.id === e.target.key);
            onMove(ids, tableId, tableId ? index + (e.target.dropPosition === "after" ? 1 : 0) : undefined);
        },
        // Dropped on an empty list or its background: add at the end.
        onRootDrop: async (e) => onMove(await read(e.items), tableId),
        // Reordered within this table.
        onReorder: (e) => {
            if (!tableId) return;
            const ids = [...e.keys].map(String);
            const rest = guests.filter((g) => !ids.includes(g.id));
            const index = rest.findIndex((g) => g.id === e.target.key);
            onMove(ids, tableId, index + (e.target.dropPosition === "after" ? 1 : 0));
        },
        renderDropIndicator: (target) => (
            <DropIndicator target={target} className={({ isDropTarget }) => cx("h-0.5 rounded-full", isDropTarget && "bg-brand-solid")} />
        ),
    });

    return (
        <GridList
            aria-label={label}
            items={guests}
            selectionMode={canEdit ? "multiple" : "none"}
            selectionBehavior="replace"
            dragAndDropHooks={dragAndDropHooks}
            renderEmptyState={() => <div className="flex min-h-16 items-center justify-center p-3 text-center text-sm text-tertiary">{empty}</div>}
            className={({ isDropTarget }) =>
                cx(
                    "flex min-h-16 flex-col gap-1 rounded-lg p-1 outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2",
                    isDropTarget && "bg-brand-primary ring-2 ring-brand ring-inset",
                    className,
                )
            }
        >
            {(guest) => (
                <GridListItem
                    id={guest.id}
                    textValue={guest.name}
                    className={({ isSelected, isDragging, isFocusVisible }) =>
                        cx(
                            "flex cursor-grab items-center gap-2 rounded-md bg-primary px-2.5 py-2 shadow-xs ring-1 ring-secondary outline-hidden ring-inset",
                            isSelected && "bg-brand-primary ring-brand",
                            isDragging && "opacity-50",
                            isFocusVisible && "ring-2 ring-focus-ring",
                            !canEdit && "cursor-default",
                        )
                    }
                >
                    <GuestChip
                        guest={guest}
                        tables={tables}
                        canEdit={canEdit}
                        mealLabel={mealLabel(guest)}
                        householdIds={householdWaiting(guest)}
                        onMove={(ids, target) => onMove(ids, target)}
                    />
                </GridListItem>
            )}
        </GridList>
    );
};
