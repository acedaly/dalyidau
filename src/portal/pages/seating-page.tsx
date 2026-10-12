import { useMemo, useState } from "react";
import { ChevronDown, Download01, FlipBackward, LayoutGrid01, Plus, Printer, Save01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth, useSubmit } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { api, errorMessage } from "@/portal/lib/api";
import { percent, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { GuestDropList } from "@/portal/seating/guest-drop-list";
import { type PrintMode, SeatingPrint } from "@/portal/seating/seating-print";
import { TableCard } from "@/portal/seating/table-card";
import { needsSeat, seatingWarnings } from "@/shared/portal/seating";
import type { SeatingGuest, SeatingSnapshot, SeatingState, SeatingTable } from "@/shared/portal/types";

/** One undo step: where each moved guest was before. */
type UndoStep = { label: string; previous: { guestId: string; tableId: string | null; position: number }[] };

interface TableDraft {
    name: string;
    shape: "round" | "rectangle";
    capacity: string;
    notes: string;
}

export const SeatingPage = ({ data }: { data: PageData<"seating"> }) => {
    const toast = useToast();
    const [state, setState] = useState<SeatingState>(data.state);
    const [undo, setUndo] = useState<UndoStep[]>([]);
    const [busy, setBusy] = useState(false);
    const [query, setQuery] = useState("");
    const [showAll, setShowAll] = useState(false);
    const [editing, setEditing] = useState<SeatingTable | null>(null);
    const [tableOpen, setTableOpen] = useState(false);
    const [tableDraft, setTableDraft] = useState<TableDraft>({ name: "", shape: "round", capacity: "10", notes: "" });
    const [snapshotOpen, setSnapshotOpen] = useState(false);
    const [snapshotName, setSnapshotName] = useState("");
    const [restoring, setRestoring] = useState<SeatingSnapshot | null>(null);
    const [printMode, setPrintMode] = useState<PrintMode>("plan");
    const canEdit = data.canEdit;

    const warnings = useMemo(() => seatingWarnings(state.tables, state.guests), [state]);
    const categoryLabel = useMemo(() => new Map(state.categories.map((c) => [c.id, c.label])), [state.categories]);
    const mealLabel = (g: SeatingGuest) => (g.mealCategory ? (categoryLabel.get(g.mealCategory) ?? null) : null);
    const householdWaiting = (g: SeatingGuest) =>
        g.householdId ? state.guests.filter((x) => x.householdId === g.householdId && x.status !== "declined").map((x) => x.id) : [g.id];

    const needing = state.guests.filter(needsSeat);
    const seatedNeeding = needing.filter((g) => g.tableId).length;
    const capacity = state.tables.reduce((n, t) => n + t.capacity, 0);
    const unseated = state.guests
        .filter((g) => !g.tableId && (showAll || needsSeat(g)))
        .filter((g) => !query || `${g.name} ${g.householdName ?? ""} ${g.groupName ?? ""}`.toLowerCase().includes(query.toLowerCase()));

    const move = async (guestIds: string[], tableId: string | null, position?: number, recordUndo = true) => {
        if (!canEdit || guestIds.length === 0) return;
        const previous = state.guests.filter((g) => guestIds.includes(g.id)).map((g) => ({ guestId: g.id, tableId: g.tableId, position: g.position }));
        setBusy(true);
        try {
            const next = await api<SeatingState>("PUT", "/api/portal/wedding/seating/assign", { guestIds, tableId, position });
            setState(next);
            if (recordUndo) {
                const target = tableId ? (state.tables.find((t) => t.id === tableId)?.name ?? "a table") : "unseated";
                setUndo((stack) => [...stack.slice(-29), { label: `${pluralise(guestIds.length, "guest")} to ${target}`, previous }]);
            }
        } catch (error) {
            toast.error("Couldn't move", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const undoLast = async () => {
        const step = undo.at(-1);
        if (!step) return;
        setUndo((stack) => stack.slice(0, -1));
        // Put each guest back where they were, table by table, in their old order.
        const groups = new Map<string | null, { guestId: string; position: number }[]>();
        for (const p of step.previous) groups.set(p.tableId, [...(groups.get(p.tableId) ?? []), p]);
        for (const [tableId, list] of groups) {
            for (const item of list.sort((a, b) => a.position - b.position)) await move([item.guestId], tableId, tableId ? item.position : undefined, false);
        }
        toast.success("Undone", step.label);
    };

    const openTable = (table: SeatingTable | null) => {
        setEditing(table);
        setTableDraft({
            name: table?.name ?? `Table ${state.tables.length + 1}`,
            shape: table?.shape ?? "round",
            capacity: String(table?.capacity ?? 10),
            notes: table?.notes ?? "",
        });
        setTableOpen(true);
    };

    const saveTable = async () => {
        const body = {
            name: tableDraft.name,
            shape: tableDraft.shape,
            capacity: Number.parseInt(tableDraft.capacity, 10),
            notes: tableDraft.notes,
            ...(editing ? {} : { sortOrder: (state.tables.length + 1) * 10 }),
        };
        if (editing) await api("PATCH", `/api/portal/wedding/seating-tables/${editing.id}`, { ...body, expectedUpdatedAt: editing.updatedAt });
        else await api("POST", "/api/portal/wedding/seating-tables", body);
        setState(await api<SeatingState>("GET", "/api/portal/wedding/seating"));
    };

    const deleteTable = async () => {
        if (!editing) return;
        await api("DELETE", `/api/portal/wedding/seating-tables/${editing.id}`);
        setState(await api<SeatingState>("GET", "/api/portal/wedding/seating"));
        setUndo([]);
    };

    const saveSnapshot = useSubmit(() => api<{ snapshots: SeatingSnapshot[] }>("POST", "/api/portal/wedding/seating/snapshots", { name: snapshotName }), {
        success: "Arrangement saved",
        onSuccess: ({ snapshots }) => {
            setState((s) => ({ ...s, snapshots }));
            setSnapshotOpen(false);
        },
    });

    const print = (mode: PrintMode) => {
        setPrintMode(mode);
        // Let React render the chosen report before the print dialog opens.
        requestAnimationFrame(() => window.print());
    };

    const tableWarnings = (tableId: string) =>
        warnings
            .filter((w) => ("tableId" in w && w.tableId === tableId) || (w.kind === "household_split" && w.tableIds.includes(tableId)))
            .map((w) => w.message);

    return (
        <>
            <div className="contents print:hidden">
                <PageHeader
                    title="Seating"
                    description={
                        state.event
                            ? `Seats for the ${state.event.name}. Drag guests onto tables, or use each guest's menu.`
                            : "Add the reception as an event to start seating guests."
                    }
                    breadcrumbs={[{ label: "Seating" }]}
                    actions={
                        <>
                            {canEdit && (
                                <Button color="secondary" iconLeading={FlipBackward} onClick={undoLast} isDisabled={undo.length === 0 || busy}>
                                    Undo
                                </Button>
                            )}
                            <Dropdown.Root>
                                <Button color="secondary" iconLeading={Printer} iconTrailing={ChevronDown}>
                                    Print or export
                                </Button>
                                <Dropdown.Popover className="w-64">
                                    <Dropdown.Menu
                                        onAction={(key) => {
                                            const k = String(key);
                                            if (k.startsWith("print-")) print(k.slice(6) as PrintMode);
                                            else window.location.assign(`/api/portal/export/${k}.csv`);
                                        }}
                                    >
                                        <Dropdown.Section>
                                            <Dropdown.Item id="print-plan" icon={Printer} label="Print seating plan" />
                                            <Dropdown.Item id="print-guests" icon={Printer} label="Print guests A–Z with tables" />
                                            <Dropdown.Item id="print-dietary" icon={Printer} label="Print dietary needs by table" />
                                        </Dropdown.Section>
                                        <Dropdown.Separator />
                                        <Dropdown.Section>
                                            <Dropdown.Item id="seating" icon={Download01} label="Seating plan (CSV)" />
                                            <Dropdown.Item id="catering" icon={Download01} label="Catering list (CSV)" />
                                        </Dropdown.Section>
                                    </Dropdown.Menu>
                                </Dropdown.Popover>
                            </Dropdown.Root>
                            {canEdit && (
                                <>
                                    <Dropdown.Root>
                                        <Button color="secondary" iconLeading={Save01} iconTrailing={ChevronDown}>
                                            Arrangements
                                        </Button>
                                        <Dropdown.Popover className="w-72">
                                            <Dropdown.Menu
                                                onAction={(key) => {
                                                    if (key === "save") {
                                                        setSnapshotName(`Arrangement ${state.snapshots.length + 1}`);
                                                        setSnapshotOpen(true);
                                                    } else setRestoring(state.snapshots.find((s) => s.id === key) ?? null);
                                                }}
                                            >
                                                <Dropdown.Item id="save" icon={Save01} label="Save current arrangement" />
                                                {state.snapshots.length > 0 && <Dropdown.Separator />}
                                                {state.snapshots.length > 0 && (
                                                    <Dropdown.Section>
                                                        {state.snapshots.map((s) => (
                                                            <Dropdown.Item key={s.id} id={s.id} textValue={s.name}>
                                                                <span className="flex flex-col">
                                                                    <span>Restore “{s.name}”</span>
                                                                    <span className="text-xs font-normal text-tertiary">
                                                                        {s.seated} seated · <Timestamp iso={s.createdAt} relative />
                                                                    </span>
                                                                </span>
                                                            </Dropdown.Item>
                                                        ))}
                                                    </Dropdown.Section>
                                                )}
                                            </Dropdown.Menu>
                                        </Dropdown.Popover>
                                    </Dropdown.Root>
                                    <Button iconLeading={Plus} onClick={() => openTable(null)}>
                                        Add table
                                    </Button>
                                </>
                            )}
                        </>
                    }
                />

                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-6">
                    <MetricCard label="Tables" value={state.tables.length} detail={`${capacity} seats`} />
                    <MetricCard
                        label="Seated"
                        value={`${seatedNeeding} / ${needing.length}`}
                        progress={percent(seatedNeeding, needing.length)}
                        progressLabel={`${percent(seatedNeeding, needing.length)}%`}
                    />
                    <MetricCard label="Free seats" value={Math.max(capacity - state.guests.filter((g) => g.tableId).length, 0)} />
                    <MetricCard label="Warnings" value={warnings.length} detail={warnings.length ? "See the list below" : "All good"} />
                </div>

                {warnings.length > 0 && (
                    <Notice color="warning" title={`${pluralise(warnings.length, "thing")} to check`}>
                        <details>
                            <summary className="cursor-pointer font-semibold text-secondary">Show</summary>
                            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                                {warnings.map((w, i) => (
                                    <li key={i}>{w.message}</li>
                                ))}
                            </ul>
                        </details>
                    </Notice>
                )}

                {!state.event ? (
                    <div className="rounded-xl py-10 ring-1 ring-secondary">
                        <Empty
                            icon={LayoutGrid01}
                            title="No events yet"
                            description="Seating follows the meal event. Add the reception on the Events page first."
                        />
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                        <aside
                            aria-labelledby="unseated-heading"
                            className="flex flex-col gap-3 self-start rounded-xl bg-secondary p-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto"
                        >
                            <div className="flex items-baseline justify-between gap-2">
                                <h2 id="unseated-heading" className="text-md font-semibold text-primary">
                                    Not seated
                                </h2>
                                <span className="text-sm text-tertiary">{unseated.length}</span>
                            </div>
                            <Input aria-label="Find a guest" placeholder="Find a guest" size="sm" value={query} onChange={setQuery} type="search" />
                            <Toggle size="sm" label="Include declined and uninvited" isSelected={showAll} onChange={setShowAll} />
                            <GuestDropList
                                label="Guests not seated"
                                tableId={null}
                                guests={unseated}
                                tables={state.tables}
                                canEdit={canEdit}
                                mealLabel={mealLabel}
                                householdWaiting={householdWaiting}
                                onMove={(ids, tableId, position) => move(ids, tableId, position)}
                                empty={needing.length && !query ? "Everyone has a seat" : "Nobody here"}
                            />
                        </aside>

                        {state.tables.length === 0 ? (
                            <div className="rounded-xl py-10 ring-1 ring-secondary">
                                <Empty
                                    icon={LayoutGrid01}
                                    title="No tables yet"
                                    description="Add tables with their number of seats, then drag guests onto them. Households stay together if you move them with “Seat household”."
                                    actions={
                                        canEdit && (
                                            <Button iconLeading={Plus} onClick={() => openTable(null)}>
                                                Add table
                                            </Button>
                                        )
                                    }
                                />
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {state.tables.map((table) => (
                                    <TableCard
                                        key={table.id}
                                        table={table}
                                        guests={state.guests.filter((g) => g.tableId === table.id).sort((a, b) => a.position - b.position)}
                                        tables={state.tables}
                                        canEdit={canEdit}
                                        warnings={tableWarnings(table.id)}
                                        mealLabel={mealLabel}
                                        householdWaiting={householdWaiting}
                                        onMove={(ids, tableId, position) => move(ids, tableId, position)}
                                        onEdit={() => openTable(table)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <p className="sr-only" aria-live="polite">
                    {busy ? "Saving seating" : ""}
                </p>
            </div>

            <SeatingPrint state={state} mode={printMode} title={`Seating${state.event ? ` · ${state.event.name}` : ""}`} />

            <EntityPanel
                isOpen={tableOpen}
                onOpenChange={setTableOpen}
                noun="table"
                name={editing?.name ?? null}
                canEdit={canEdit}
                onSave={saveTable}
                onDelete={editing ? deleteTable : undefined}
                deleteWarning="Guests at this table go back to “Not seated”."
            >
                {(fieldError) => (
                    <FormGrid>
                        <FullWidth>
                            <Input
                                label="Name"
                                isRequired
                                value={tableDraft.name}
                                onChange={(v) => setTableDraft({ ...tableDraft, name: v })}
                                isInvalid={!!fieldError("name")}
                                hint={fieldError("name")}
                            />
                        </FullWidth>
                        <Select
                            label="Shape"
                            items={[
                                { id: "round", label: "Round" },
                                { id: "rectangle", label: "Rectangular" },
                            ]}
                            value={tableDraft.shape}
                            onChange={(v) => setTableDraft({ ...tableDraft, shape: v as TableDraft["shape"] })}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Input
                            label="Seats"
                            type="number"
                            isRequired
                            value={tableDraft.capacity}
                            onChange={(v) => setTableDraft({ ...tableDraft, capacity: v })}
                            isInvalid={!!fieldError("capacity")}
                            hint={fieldError("capacity")}
                        />
                        <FullWidth>
                            <TextArea
                                label="Notes"
                                rows={3}
                                value={tableDraft.notes}
                                onChange={(v) => setTableDraft({ ...tableDraft, notes: v })}
                                hint="E.g. near the dance floor, high chair needed."
                            />
                        </FullWidth>
                    </FormGrid>
                )}
            </EntityPanel>

            <PortalDialog
                isOpen={snapshotOpen}
                onOpenChange={setSnapshotOpen}
                title="Save this arrangement"
                description="Saves the tables and who sits where, so you can try something else and come back to it."
                icon={Save01}
                size="sm"
                onSubmit={saveSnapshot.submit}
                footer={
                    <>
                        <Button color="secondary" size="lg" onClick={() => setSnapshotOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" size="lg" isLoading={saveSnapshot.busy} showTextWhileLoading>
                            Save
                        </Button>
                    </>
                }
            >
                <Input
                    label="Name"
                    value={snapshotName}
                    onChange={setSnapshotName}
                    isInvalid={!!saveSnapshot.fieldError("name")}
                    hint={saveSnapshot.fieldError("name")}
                />
            </PortalDialog>

            <ConfirmDialog
                isOpen={!!restoring}
                onOpenChange={(o) => !o && setRestoring(null)}
                title={`Restore “${restoring?.name ?? ""}”?`}
                description="The current tables and seats are replaced by the saved arrangement. Save the current one first if you might want it back."
                confirmLabel="Restore"
                onConfirm={async () => {
                    if (!restoring) return;
                    try {
                        setState(await api<SeatingState>("POST", `/api/portal/wedding/seating/snapshots/${restoring.id}/restore`, {}));
                        setUndo([]);
                        toast.success("Arrangement restored");
                    } catch (error) {
                        toast.error("Couldn't restore", errorMessage(error));
                    }
                }}
            />
        </>
    );
};
