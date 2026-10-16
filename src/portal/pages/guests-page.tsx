import { useMemo, useState } from "react";
import { Download01, Phone01, Plus, Upload01, Users01 } from "@untitledui/icons";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { PageHeader } from "@/portal/components/page-header";
import { RSVP_LABELS, RsvpBadge } from "@/portal/components/status";
import { BulkActions } from "@/portal/guests/bulk-actions";
import { GuestPanel } from "@/portal/guests/guest-panel";
import { MobileReviewDialog } from "@/portal/guests/mobile-review-dialog";
import { api } from "@/portal/lib/api";
import { initials, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { Guest, Side } from "@/shared/portal/types";

interface Filters {
    rsvp: string;
    side: string;
    event: string;
    group: string;
    tag: string;
}

const ALL = "all";
const EMPTY_FILTERS: Filters = { rsvp: ALL, side: ALL, event: ALL, group: ALL, tag: ALL };

export const GuestsPage = ({ data }: { data: PageData<"guests"> }) => {
    const { can, sideLabel } = usePortal();
    const [guests, setGuests] = useState<Guest[]>(data.guests);
    const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
    const [selected, setSelected] = useState<Guest | null>(null);
    const [panelOpen, setPanelOpen] = useState(false);
    const [mobileReviewOpen, setMobileReviewOpen] = useState(false);

    const groups = useMemo(() => [...new Set(guests.map((g) => g.groupName).filter(Boolean) as string[])].sort(), [guests]);
    const tags = useMemo(() => [...new Set(guests.flatMap((g) => g.tags))].sort(), [guests]);
    const eventName = useMemo(() => new Map(data.events.map((e) => [e.id, e.name])), [data.events]);
    const tableName = useMemo(() => new Map(data.tables.map((t) => [t.id, t.name])), [data.tables]);
    const tableFields = data.customFields.filter((f) => f.showInTable && !f.archived);

    const filtered = guests.filter((g) => {
        if (filters.event !== ALL) {
            const status = g.events.find((e) => e.eventId === filters.event);
            if (!status) return false;
            if (filters.rsvp !== ALL && status.status !== filters.rsvp) return false;
        } else if (filters.rsvp !== ALL && g.rsvp !== filters.rsvp) return false;
        if (filters.side !== ALL && g.side !== filters.side) return false;
        if (filters.group !== ALL && g.groupName !== filters.group) return false;
        if (filters.tag !== ALL && !g.tags.includes(filters.tag)) return false;
        return true;
    });
    const activeFilters = Object.values(filters).filter((v) => v !== ALL).length;

    const upsert = (guest: Guest) =>
        setGuests((list) => (list.some((g) => g.id === guest.id) ? list.map((g) => (g.id === guest.id ? guest : g)) : [...list, guest]));
    const openGuest = (guest: Guest | null) => {
        setSelected(guest);
        setPanelOpen(true);
    };

    const columns: DataColumn<Guest>[] = [
        {
            id: "name",
            label: "Name",
            isRowHeader: true,
            sortValue: (g) => `${g.lastName} ${g.firstName}`,
            render: (g) => (
                <div className="flex items-center gap-3">
                    <Avatar size="md" initials={initials(`${g.firstName} ${g.lastName}`)} />
                    <div className="min-w-0">
                        <p className="truncate font-medium text-primary">
                            {g.firstName} {g.lastName}
                            {g.isPlusOne && <span className="ml-1.5 text-xs font-normal text-tertiary">(plus one)</span>}
                        </p>
                        <p className="truncate text-tertiary">{g.email ?? "No email"}</p>
                    </div>
                </div>
            ),
        },
        {
            id: "household",
            label: "Household",
            sortValue: (g) => g.householdName,
            render: (g) => g.householdName ?? <span className="text-quaternary">—</span>,
            className: "max-md:hidden",
        },
        { id: "rsvp", label: "RSVP", sortValue: (g) => g.rsvp, render: (g) => <RsvpBadge status={g.rsvp} /> },
        {
            id: "events",
            label: "Invited to",
            render: (g) =>
                g.events.length === 0 ? (
                    <span className="text-quaternary">—</span>
                ) : (
                    <div className="flex flex-wrap gap-1">
                        {g.events.map((e) => (
                            <Badge key={e.eventId} size="sm" type="modern" color="gray">
                                {eventName.get(e.eventId)}
                            </Badge>
                        ))}
                    </div>
                ),
            className: "max-2xl:hidden",
        },
        { id: "side", label: "Side", sortValue: (g) => sideLabel(g.side), render: (g) => sideLabel(g.side), className: "max-lg:hidden" },
        {
            id: "group",
            label: "Group",
            sortValue: (g) => g.groupName,
            render: (g) => g.groupName ?? <span className="text-quaternary">—</span>,
            className: "max-2xl:hidden",
        },
        {
            id: "table",
            label: "Table",
            sortValue: (g) => (g.tableId ? tableName.get(g.tableId) : null),
            render: (g) => (g.tableId ? tableName.get(g.tableId) : <span className="text-quaternary">—</span>),
            className: "max-xl:hidden",
        },
        {
            id: "dietary",
            label: "Dietary",
            render: (g) =>
                g.dietary || g.allergies ? (
                    <span className="flex flex-col">
                        {g.dietary && <span>{g.dietary}</span>}
                        {g.allergies && <span className="font-medium text-error-primary">Allergy: {g.allergies}</span>}
                    </span>
                ) : (
                    <span className="text-quaternary">—</span>
                ),
            className: "max-xl:hidden",
        },
        ...tableFields.map<DataColumn<Guest>>((field) => ({
            id: `custom-${field.key}`,
            label: field.label,
            sortValue: (g) => {
                const v = g.custom[field.key];
                return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
            },
            render: (g) => {
                const v = g.custom[field.key];
                if (v === null || v === undefined || v === "") return <span className="text-quaternary">—</span>;
                return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
            },
            className: "max-2xl:hidden",
        })),
    ];

    const filterSelect = (key: keyof Filters, label: string, options: { id: string; label: string }[]) => (
        <Select
            aria-label={label}
            label={label}
            size="sm"
            className="w-[calc(50%-0.375rem)] sm:w-44"
            items={[{ id: ALL, label: `All` }, ...options]}
            value={filters[key]}
            onChange={(v) => setFilters({ ...filters, [key]: String(v) })}
        >
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
    );

    return (
        <>
            <PageHeader
                title="Guests"
                description={`${pluralise(guests.length, "guest")} across ${pluralise(data.households.length, "household")}.`}
                breadcrumbs={[{ label: "Guests" }]}
                actions={
                    <>
                        {can("wedding.export") && guests.length > 0 && (
                            <Button color="secondary" iconLeading={Download01} href="/api/portal/export/guests.csv" download>
                                Export CSV
                            </Button>
                        )}
                        {can("wedding.guests.edit") && (
                            <>
                                <Button color="secondary" iconLeading={Phone01} onClick={() => setMobileReviewOpen(true)}>
                                    Review mobiles
                                </Button>
                                <Button color="secondary" iconLeading={Upload01} href="/portal/wedding/guests/import">
                                    Import
                                </Button>
                                <Button iconLeading={Plus} onClick={() => openGuest(null)}>
                                    Add guest
                                </Button>
                            </>
                        )}
                    </>
                }
            />

            <DataTable
                title="Guest list"
                rows={filtered}
                columns={columns}
                searchText={(g) => [g.firstName, g.lastName, g.email, g.householdName, g.groupName, g.dietary, ...g.tags].filter(Boolean).join(" ")}
                searchPlaceholder="Search guests"
                initialSort={{ column: "name", direction: "ascending" }}
                selectable={can("wedding.guests.edit")}
                onRowAction={openGuest}
                activeFilterCount={activeFilters}
                onClearFilters={() => setFilters(EMPTY_FILTERS)}
                filters={
                    <>
                        {filterSelect(
                            "rsvp",
                            "RSVP",
                            Object.entries(RSVP_LABELS)
                                .filter(([id]) => filters.event === ALL || id !== "not_invited")
                                .map(([id, label]) => ({ id, label })),
                        )}
                        {data.events.length > 0 &&
                            filterSelect(
                                "event",
                                "Event",
                                data.events.map((e) => ({ id: e.id, label: e.name })),
                            )}
                        {filterSelect(
                            "side",
                            "Side",
                            (["partner_one", "partner_two", "shared"] as Side[]).map((s) => ({ id: s, label: sideLabel(s) })),
                        )}
                        {groups.length > 0 &&
                            filterSelect(
                                "group",
                                "Group",
                                groups.map((g) => ({ id: g, label: g })),
                            )}
                        {tags.length > 0 &&
                            filterSelect(
                                "tag",
                                "Tag",
                                tags.map((t) => ({ id: t, label: t })),
                            )}
                        {activeFilters > 0 && (
                            <Button size="sm" color="link-gray" onClick={() => setFilters(EMPTY_FILTERS)} className="sm:mb-2.5">
                                Clear filters
                            </Button>
                        )}
                    </>
                }
                bulkActions={(ids, clear) => <BulkActions ids={ids} clear={clear} events={data.events} households={data.households} onDone={setGuests} />}
                emptyState={
                    <Empty
                        icon={Users01}
                        title="No guests yet"
                        description="Add guests one at a time, or import a spreadsheet (including a Say I Do guest list export)."
                        actions={
                            can("wedding.guests.edit") && (
                                <>
                                    <Button color="secondary" iconLeading={Upload01} href="/portal/wedding/guests/import">
                                        Import CSV
                                    </Button>
                                    <Button iconLeading={Plus} onClick={() => openGuest(null)}>
                                        Add guest
                                    </Button>
                                </>
                            )
                        }
                    />
                }
            />

            <GuestPanel
                guest={selected}
                isOpen={panelOpen}
                onOpenChange={setPanelOpen}
                households={data.households}
                events={data.events}
                customFields={data.customFields}
                mealCategories={data.mealCategories}
                allGuests={guests}
                tables={data.tables}
                onSaved={(guest) => {
                    upsert(guest);
                    setSelected(guest);
                }}
                onDeleted={(id) => setGuests((list) => list.filter((g) => g.id !== id))}
            />

            <MobileReviewDialog
                isOpen={mobileReviewOpen}
                onOpenChange={setMobileReviewOpen}
                onApplied={() => {
                    api<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")
                        .then(({ guests }) => setGuests(guests))
                        .catch(() => {});
                }}
            />
        </>
    );
};
