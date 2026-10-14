// Courtesy bus and accommodation, for booking the Dubbo RSL bus: passenger estimates, where people
// are staying, who needs a follow-up, a CSV for the RSL and a manual edit for answers given by phone.
// Private to the Wedding Planner; the public site never shows any of it.
import { useState } from "react";
import { AlertCircle, ArrowRight, Bus, Download01, Edit03, HelpCircle, Home02, Moon02 } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { useSubmit } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { Timestamp } from "@/portal/components/timestamp";
import { api } from "@/portal/lib/api";
import { formatNumber } from "@/portal/lib/format";
import {
    BUS_CHOICES,
    BUS_LABELS,
    BUS_SHORT_LABELS,
    type BusChoice,
    EMPTY_TRAVEL,
    FOLLOW_UP_LABELS,
    type RsvpTravel,
    STAY_CHOICES,
    STAY_LABELS,
    STAY_LOCATION_MAX,
    type StayChoice,
    needsOutbound,
    needsReturn,
} from "@/shared/portal/travel";
import type { TravelHouseholdRow, TravelOverview } from "@/shared/portal/types";

type Row = TravelHouseholdRow & { id: string };
type View = "all" | "follow-up" | "unanswered";

const VIEWS: { id: View; label: string }[] = [
    { id: "all", label: "All households" },
    { id: "follow-up", label: "Needs follow-up" },
    { id: "unanswered", label: "No answer yet" },
];

const NONE = "none";
const busOptions = [{ id: NONE, label: "Not answered" }, ...BUS_CHOICES.map((c) => ({ id: c, label: BUS_LABELS[c] }))];
const stayOptions = [{ id: NONE, label: "Not answered" }, ...STAY_CHOICES.map((c) => ({ id: c, label: STAY_LABELS[c] }))];

const EditTravelDialog = ({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) => {
    const [draft, setDraft] = useState<RsvpTravel>(row.travel ?? EMPTY_TRAVEL);
    const counts = (n: number) => String(n || row.attending);
    const [outbound, setOutbound] = useState(counts(draft.outbound));
    const [back, setBack] = useState(counts(draft.return));
    const save = useSubmit(
        () =>
            api("PUT", `/api/portal/wedding/households/${row.householdId}/travel`, {
                ...draft,
                outbound: needsOutbound(draft.bus) ? Number(outbound) : 0,
                return: needsReturn(draft.bus) ? Number(back) : 0,
            }),
        { success: "Transport saved", onSuccess: onSaved },
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={`Transport for ${row.householdName}`}
            description={`${row.attending} ${row.attending === 1 ? "guest is" : "guests are"} attending. Use this for answers given by phone or message.`}
            icon={Bus}
            onSubmit={() => void save.submit()}
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="lg" isLoading={save.busy} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <Select
                label="Courtesy bus"
                items={busOptions}
                value={draft.bus ?? NONE}
                onChange={(key) => setDraft({ ...draft, bus: key === NONE ? null : (String(key) as BusChoice) })}
                isInvalid={!!save.fieldError("bus")}
                hint={save.fieldError("bus")}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            {(needsOutbound(draft.bus) || needsReturn(draft.bus)) && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {needsOutbound(draft.bus) && (
                        <Input
                            label="To Rhino Lodge (passengers)"
                            type="number"
                            inputMode="numeric"
                            value={outbound}
                            onChange={setOutbound}
                            isInvalid={!!save.fieldError("outbound")}
                            hint={save.fieldError("outbound") ?? `1 to ${row.attending}`}
                        />
                    )}
                    {needsReturn(draft.bus) && (
                        <Input
                            label="Home after (passengers)"
                            type="number"
                            inputMode="numeric"
                            value={back}
                            onChange={setBack}
                            isInvalid={!!save.fieldError("return")}
                            hint={save.fieldError("return") ?? `1 to ${row.attending}`}
                        />
                    )}
                </div>
            )}
            <Select
                label="Staying"
                items={stayOptions}
                value={draft.stay ?? NONE}
                onChange={(key) => setDraft({ ...draft, stay: key === NONE ? null : (String(key) as StayChoice) })}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            {draft.stay === "dubbo" && (
                <Input
                    label="Accommodation name or location"
                    maxLength={STAY_LOCATION_MAX}
                    value={draft.stayLocation ?? ""}
                    onChange={(stayLocation) => setDraft({ ...draft, stayLocation })}
                    isInvalid={!!save.fieldError("stayLocation")}
                    hint={save.fieldError("stayLocation") ?? "Helps plan possible pick-up points. Not shared on the website."}
                />
            )}
        </PortalDialog>
    );
};

export const TransportPanel = ({
    initial,
    collecting,
    canEdit,
    canExport,
}: {
    initial: TravelOverview;
    /** Whether the native form asks the travel questions (RSVPs → Settings). */
    collecting: boolean;
    canEdit: boolean;
    canExport: boolean;
}) => {
    const [overview, setOverview] = useState(initial);
    const [view, setView] = useState<View>("all");
    const [editing, setEditing] = useState<Row | null>(null);
    const refresh = async () => setOverview(await api<TravelOverview>("GET", "/api/portal/wedding/travel"));

    const rows: Row[] = overview.households.map((h) => ({ ...h, id: h.householdId }));
    const followUp = rows.filter((r) => r.followUp.length > 0);
    const unanswered = rows.filter((r) => r.attending > 0 && !r.travel?.bus && !r.travel?.stay);
    const shown = view === "follow-up" ? followUp : view === "unanswered" ? unanswered : rows;
    const locations = new Map<string, string[]>();
    for (const r of rows) {
        const place = r.travel?.stay === "dubbo" ? r.travel.stayLocation?.trim() : null;
        if (place && r.attending > 0) locations.set(place.toLocaleLowerCase(), [...(locations.get(place.toLocaleLowerCase()) ?? [place]), r.householdName]);
    }

    const columns: DataColumn<Row>[] = [
        {
            id: "household",
            label: "Household",
            isRowHeader: true,
            sortValue: (r) => r.householdName,
            render: (r) => (
                <div className="flex flex-col">
                    <span className="font-medium text-primary">{r.householdName}</span>
                    <span className="text-sm text-tertiary">{r.attending === 0 ? "Nobody attending now" : `${r.attending} attending`}</span>
                </div>
            ),
        },
        {
            id: "bus",
            label: "Courtesy bus",
            sortValue: (r) => (r.travel?.bus ? BUS_CHOICES.indexOf(r.travel.bus) : 99),
            render: (r) =>
                r.travel?.bus ? (
                    <Badge size="sm" color={r.travel.bus === "unsure" ? "warning" : r.travel.bus === "none" ? "gray" : "brand"}>
                        {BUS_SHORT_LABELS[r.travel.bus]}
                    </Badge>
                ) : (
                    <span className="text-quaternary">Not answered</span>
                ),
        },
        {
            id: "outbound",
            label: "To venue",
            tooltip: "Passengers to Rhino Lodge, capped at the guests attending now",
            sortValue: (r) => r.outbound,
            render: (r) => <span className="tabular-nums">{r.outbound || "—"}</span>,
        },
        {
            id: "return",
            label: "Home",
            tooltip: "Passengers back to town, capped at the guests attending now",
            sortValue: (r) => r.return,
            render: (r) => <span className="tabular-nums">{r.return || "—"}</span>,
        },
        {
            id: "stay",
            label: "Staying",
            sortValue: (r) => (r.travel?.stay ? STAY_CHOICES.indexOf(r.travel.stay) : 99),
            render: (r) =>
                r.travel?.stay ? (
                    <div className="flex max-w-64 flex-col">
                        <span className="text-secondary">{STAY_LABELS[r.travel.stay]}</span>
                        {r.travel.stayLocation && <span className="text-sm text-tertiary">{r.travel.stayLocation}</span>}
                    </div>
                ) : (
                    <span className="text-quaternary">—</span>
                ),
        },
        {
            id: "follow-up",
            label: "Follow up",
            sortValue: (r) => -r.followUp.length,
            className: "max-lg:hidden",
            render: (r) =>
                r.followUp.length ? (
                    <ul className="flex flex-col gap-1">
                        {r.followUp.map((reason) => (
                            <li key={reason}>
                                <BadgeWithDot size="sm" color={reason === "seats_exceed" || reason === "not_attending" ? "error" : "warning"}>
                                    {FOLLOW_UP_LABELS[reason]}
                                </BadgeWithDot>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <span className="text-quaternary">—</span>
                ),
        },
        {
            id: "updated",
            label: "Answered",
            sortValue: (r) => r.updatedAt,
            className: "max-xl:hidden",
            render: (r) =>
                r.updatedAt ? (
                    <div className="flex flex-col text-sm">
                        <Timestamp iso={r.updatedAt} />
                        <span className="text-tertiary">{r.source === "manual" ? "Entered by hand" : "Online RSVP"}</span>
                    </div>
                ) : (
                    <span className="text-quaternary">—</span>
                ),
        },
        ...(canEdit
            ? [
                  {
                      id: "edit",
                      label: "",
                      render: (r: Row) =>
                          r.attending > 0 ? (
                              <ButtonUtility
                                  size="sm"
                                  color="tertiary"
                                  icon={Edit03}
                                  tooltip={`Edit transport for ${r.householdName}`}
                                  onClick={() => setEditing(r)}
                              />
                          ) : null,
                  },
              ]
            : []),
    ];

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h2 className="text-md font-semibold text-primary">Courtesy bus and accommodation</h2>
                    <p className="max-w-2xl text-sm text-tertiary">
                        Estimates for booking the Dubbo RSL bus. Passenger counts are capped at the guests attending now. Nothing here books a seat; the RSL
                        needs an approximate passenger count and departure time.
                    </p>
                </div>
                {canExport && (
                    <Button color="secondary" iconLeading={Download01} href="/api/portal/export/transport.csv" download className="shrink-0">
                        Export for the RSL
                    </Button>
                )}
            </div>

            {!collecting && (
                <Notice color="warning" title="The native RSVP isn't asking about transport">
                    Turn on “Ask about the courtesy bus and accommodation” under Settings to collect answers. Answers already given are kept.
                </Notice>
            )}

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                    label="To Rhino Lodge"
                    icon={ArrowRight}
                    value={formatNumber(overview.outbound)}
                    detail="Passengers to the wedding (incl. both ways)"
                />
                <MetricCard label="Home after" icon={Moon02} value={formatNumber(overview.return)} detail="Passengers back to town (incl. both ways)" />
                <MetricCard label="Both ways" icon={Bus} value={formatNumber(overview.bothWays)} detail="Passengers travelling there and back" />
                <MetricCard
                    label="Not sure yet"
                    icon={HelpCircle}
                    value={formatNumber(overview.unsure.households)}
                    detail={`${overview.unsure.households === 1 ? "household" : "households"} · ${formatNumber(overview.unsure.guests)} ${
                        overview.unsure.guests === 1 ? "guest" : "guests"
                    } attending${overview.unanswered ? ` · ${formatNumber(overview.unanswered)} not answered` : ""}`}
                />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section aria-labelledby="stay-breakdown" className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                    <h3 id="stay-breakdown" className="flex items-center gap-2 text-sm font-semibold text-primary">
                        <Home02 className="size-5 text-fg-quaternary" aria-hidden="true" />
                        Where attending households are staying
                    </h3>
                    <dl className="flex flex-col divide-y divide-secondary">
                        {overview.byStay.map((s) => (
                            <div key={s.stay ?? "none"} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                                <dt className={s.stay ? "text-secondary" : "text-tertiary"}>{s.stay ? STAY_LABELS[s.stay] : "Not answered"}</dt>
                                <dd className="text-tertiary tabular-nums">
                                    <span className="font-medium text-primary">{formatNumber(s.households)}</span>{" "}
                                    {s.households === 1 ? "household" : "households"} · {formatNumber(s.guests)} {s.guests === 1 ? "guest" : "guests"}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>
                <section aria-labelledby="stay-locations" className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                    <h3 id="stay-locations" className="flex items-center gap-2 text-sm font-semibold text-primary">
                        <Bus className="size-5 text-fg-quaternary" aria-hidden="true" />
                        Accommodation in Dubbo (possible pick-up points)
                    </h3>
                    {locations.size === 0 ? (
                        <p className="text-sm text-tertiary">No accommodation names yet. Guests staying in Dubbo can add one when they RSVP.</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {[...locations.values()]
                                .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
                                .map(([place, ...households]) => (
                                    <li key={place} className="flex flex-col gap-0.5 py-2 text-sm">
                                        <span className="font-medium text-primary">{place}</span>
                                        <span className="text-tertiary">{households.join(", ")}</span>
                                    </li>
                                ))}
                        </ul>
                    )}
                    <p className="text-xs text-quaternary">
                        Pick-ups other than Dubbo RSL are only possible on the route to Rhino Lodge. Confirm with the RSL.
                    </p>
                </section>
            </div>

            <DataTable
                title="Transport by household"
                description="Households with someone attending, plus any whose answer needs attention."
                rows={shown}
                columns={columns}
                searchText={(r) => `${r.householdName} ${r.travel?.stayLocation ?? ""}`}
                searchPlaceholder="Search households or accommodation"
                filters={
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
                        {VIEWS.map((v) => (
                            <Button
                                key={v.id}
                                size="sm"
                                color={view === v.id ? "primary" : "secondary"}
                                onClick={() => setView(v.id)}
                                aria-pressed={view === v.id}
                            >
                                {v.label}
                                {v.id === "follow-up" && followUp.length > 0 && ` (${followUp.length})`}
                                {v.id === "unanswered" && unanswered.length > 0 && ` (${unanswered.length})`}
                            </Button>
                        ))}
                    </div>
                }
                activeFilterCount={view === "all" ? 0 : 1}
                onClearFilters={() => setView("all")}
                initialSort={{ column: "follow-up", direction: "ascending" }}
                emptyState={
                    <Empty
                        icon={view === "follow-up" ? AlertCircle : Bus}
                        title={view === "follow-up" ? "Nobody needs a follow-up" : "No transport answers yet"}
                        description="Households appear here once someone in them is attending."
                    />
                }
            />

            {editing && (
                <EditTravelDialog
                    key={editing.id}
                    row={editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        void refresh();
                    }}
                />
            )}
        </div>
    );
};
