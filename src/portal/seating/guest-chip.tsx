// One guest in the seating planner: name, household, age, dietary and allergy markers, and a
// "Move to…" menu, which is the keyboard- and touch-friendly alternative to dragging.
import { AlertTriangle, DotsVertical, InfoCircle } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { Badge } from "@/components/base/badges/badges";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import type { SeatingGuest, SeatingTable } from "@/shared/portal/types";
import { cx } from "@/utils/cx";

interface GuestChipProps {
    guest: SeatingGuest;
    tables: SeatingTable[];
    canEdit: boolean;
    showHousehold?: boolean;
    mealLabel?: string | null;
    onMove: (guestIds: string[], tableId: string | null) => void;
    /** Ids of the guest's household members still waiting for a seat, for "seat household". */
    householdIds: string[];
}

export const GuestChip = ({ guest, tables, canEdit, showHousehold = true, mealLabel, onMove, householdIds }: GuestChipProps) => (
    <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
            <p className={cx("truncate text-sm font-medium text-primary", guest.status === "declined" && "text-quaternary line-through")}>{guest.name}</p>
            <div className="flex flex-wrap items-center gap-1">
                {showHousehold && guest.householdName && <span className="truncate text-xs text-tertiary">{guest.householdName}</span>}
                {mealLabel && <span className="truncate text-xs text-tertiary">· {mealLabel}</span>}
            </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
            {guest.ageGroup !== "adult" && (
                <Badge size="sm" type="pill-color" color="blue">
                    {guest.ageGroup === "child" ? "Child" : "Infant"}
                </Badge>
            )}
            {guest.status === "pending" && (
                <Badge size="sm" type="pill-color" color="warning">
                    Awaiting
                </Badge>
            )}
            {guest.status === "declined" && (
                <Badge size="sm" type="pill-color" color="error">
                    Declined
                </Badge>
            )}
            {guest.dietary && (
                <Tooltip title="Dietary" description={guest.dietary}>
                    <TooltipTrigger className="text-fg-brand-secondary" aria-label={`Dietary: ${guest.dietary}`}>
                        <InfoCircle className="size-4" />
                    </TooltipTrigger>
                </Tooltip>
            )}
            {guest.allergies && (
                <Tooltip title="Allergies" description={guest.allergies}>
                    <TooltipTrigger className="text-fg-error-secondary" aria-label={`Allergies: ${guest.allergies}`}>
                        <AlertTriangle className="size-4" />
                    </TooltipTrigger>
                </Tooltip>
            )}
            {canEdit && (
                <Dropdown.Root>
                    <AriaButton
                        aria-label={`Move ${guest.name}`}
                        className="cursor-pointer rounded-md p-0.5 text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2"
                    >
                        <DotsVertical className="size-4" />
                    </AriaButton>
                    <Dropdown.Popover className="w-60">
                        <Dropdown.Menu
                            onAction={(key) => {
                                const [mode, target] = String(key).split(":");
                                const ids = mode === "household" ? householdIds : [guest.id];
                                onMove(ids, target === "none" ? null : target);
                            }}
                        >
                            <Dropdown.Section>
                                {tables
                                    .filter((t) => t.id !== guest.tableId)
                                    .map((t) => (
                                        <Dropdown.Item key={t.id} id={`one:${t.id}`} label={`Move to ${t.name}`} />
                                    ))}
                                {guest.tableId && <Dropdown.Item id="one:none" label="Unseat" />}
                            </Dropdown.Section>
                            {householdIds.length > 1 && tables.length > 0 && (
                                <>
                                    <Dropdown.Separator />
                                    <Dropdown.Section>
                                        {tables.map((t) => (
                                            <Dropdown.Item key={t.id} id={`household:${t.id}`} label={`Seat household at ${t.name}`} />
                                        ))}
                                    </Dropdown.Section>
                                </>
                            )}
                        </Dropdown.Menu>
                    </Dropdown.Popover>
                </Dropdown.Root>
            )}
        </div>
    </div>
);
