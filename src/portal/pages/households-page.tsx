// Households: the invitation units. Each row shows the household's RSVP progress next to its
// guests' attendance, so partly answered households stand out, with its signed invitation link one
// click from the clipboard. Invitations can be generated in bulk; sending them is a separate step
// in Communications and stays off until delivery is approved and switched on.
import { useState } from "react";
import { Building07, Download01, Link01, Mail01, Plus, RefreshCw01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ProgressBarBase } from "@/components/base/progress-indicators/progress-indicators";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { CopyCode } from "@/portal/components/copy-code";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { ConfirmDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { EntityPanel } from "@/portal/components/entity-panel";
import { FormGrid, FullWidth } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import { useCollection } from "@/portal/hooks/use-collection";
import { api, errorMessage } from "@/portal/lib/api";
import { percent, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { Household, HouseholdResponseStatus, HouseholdRow } from "@/shared/portal/types";

type Draft = Record<"name" | "email" | "phone" | "addressLine1" | "addressLine2" | "locality" | "region" | "postcode" | "country" | "notes", string>;

const toDraft = (h: Household | null): Draft => ({
    name: h?.name ?? "",
    email: h?.email ?? "",
    phone: h?.phone ?? "",
    addressLine1: h?.addressLine1 ?? "",
    addressLine2: h?.addressLine2 ?? "",
    locality: h?.locality ?? "",
    region: h?.region ?? "",
    postcode: h?.postcode ?? "",
    country: h?.country ?? "",
    notes: h?.notes ?? "",
});

export const RESPONSE_LABELS: Record<HouseholdResponseStatus, string> = {
    complete: "Complete",
    partial: "Partly answered",
    not_started: "No reply yet",
    not_invited: "Not invited",
};
const RESPONSE_COLOURS = { complete: "success", partial: "warning", not_started: "gray", not_invited: "gray" } as const;

const ResponseCell = ({ row }: { row: HouseholdRow }) => {
    const r = row.response;
    return (
        <div className="flex min-w-36 flex-col gap-1.5">
            <BadgeWithDot size="sm" type="pill-color" color={RESPONSE_COLOURS[r.status]} className="self-start">
                {RESPONSE_LABELS[r.status]}
            </BadgeWithDot>
            {r.invited > 0 && (
                <>
                    <ProgressBarBase value={percent(r.answeredInvitations, r.invitations)} className="h-1.5" />
                    <span className="text-xs text-tertiary">
                        {r.answered} of {r.invited} answered{r.partial ? ` · ${r.partial} part-way` : ""}
                    </span>
                </>
            )}
        </div>
    );
};

const AttendanceCell = ({ row }: { row: HouseholdRow }) => {
    const r = row.response;
    if (!r.invited) return <span className="text-quaternary">—</span>;
    return (
        <span className="flex flex-col text-sm">
            <span className="text-success-primary">{r.attending} attending</span>
            {r.declined > 0 && <span className="text-tertiary">{r.declined} declined</span>}
            {r.waiting + r.partial > 0 && <span className="text-warning-primary">{r.waiting + r.partial} still to answer</span>}
        </span>
    );
};

export const HouseholdsPage = ({ data }: { data: PageData<"households"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const households = useCollection<HouseholdRow>("households", data.households);
    const [editing, setEditing] = useState<HouseholdRow | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(toDraft(null));
    const [regenerate, setRegenerate] = useState<Household | null>(null);
    const [invitationAction, setInvitationAction] = useState<{ household: Household; action: "rotate" | "revoke" | "restore" } | null>(null);
    const [status, setStatus] = useState<HouseholdResponseStatus | "all">("all");
    const [generating, setGenerating] = useState(false);
    const canEdit = can("wedding.guests.edit");

    const refresh = async () => {
        const { households: rows } = await api<{ households: HouseholdRow[] }>("GET", "/api/portal/wedding/households/overview");
        households.setItems(rows);
        return rows;
    };
    const openPanel = (household: HouseholdRow | null) => {
        setEditing(household);
        setDraft(toDraft(household));
        setOpen(true);
    };
    const replace = (household: Household) => {
        households.setItems((list) => list.map((h) => (h.id === household.id ? { ...h, ...household } : h)));
        setEditing((current) => (current && current.id === household.id ? { ...current, ...household } : current));
    };
    const field = (key: keyof Draft, label: string, fieldError: (f: string) => string | undefined, props: Record<string, unknown> = {}) => (
        <Input
            label={label}
            value={draft[key]}
            onChange={(v) => setDraft({ ...draft, [key]: v })}
            isInvalid={!!fieldError(key)}
            hint={fieldError(key)}
            {...props}
        />
    );

    const generate = async (ids: string[], clear: () => void) => {
        setGenerating(true);
        try {
            const result = await api<{ generated: number; skipped: { name: string; reason: string }[]; households: HouseholdRow[] }>(
                "POST",
                "/api/portal/wedding/households/invitations",
                { ids },
            );
            households.setItems(result.households);
            clear();
            const skipped = result.skipped.length
                ? ` ${pluralise(result.skipped.length, "household")} skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`
                : "";
            if (result.generated) toast.success(`Invitations ready for ${pluralise(result.generated, "household")}`, `Nothing has been sent.${skipped}`);
            else toast.error("No invitations generated", skipped.trim());
        } catch (error) {
            toast.error("Couldn't generate invitations", errorMessage(error));
        } finally {
            setGenerating(false);
        }
    };

    const rows = status === "all" ? households.items : households.items.filter((h) => h.response.status === status);
    const counts = (s: HouseholdResponseStatus) => households.items.filter((h) => h.response.status === s).length;
    const invitedHouseholds = households.items.filter((h) => h.response.invited > 0).length;
    const ready = households.items.filter((h) => h.invitationGeneratedAt && !h.inviteRevokedAt).length;
    const sendHint = data.emailDelivery
        ? "Email delivery is on. Prepare and send invitations from Communications."
        : "Sending is switched off until it's approved. Invitations are ready to copy or download in the meantime.";

    const columns: DataColumn<HouseholdRow>[] = [
        {
            id: "name",
            label: "Household",
            isRowHeader: true,
            sortValue: (h) => h.name,
            render: (h) => (
                <div className="flex max-w-80 min-w-0 flex-col">
                    <span className="truncate font-medium text-primary">{h.name}</span>
                    <span className="truncate text-sm text-tertiary">{h.response.guestNames.join(", ") || "No guests yet"}</span>
                </div>
            ),
        },
        {
            id: "response",
            label: "Responses",
            tooltip: "How much of the household's RSVP is done, counting each guest and event.",
            sortValue: (h) => (h.response.invitations ? h.response.answeredInvitations / h.response.invitations : -1),
            render: (h) => <ResponseCell row={h} />,
        },
        {
            id: "attendance",
            label: "Attendance",
            sortValue: (h) => h.response.attending,
            render: (h) => <AttendanceCell row={h} />,
            className: "max-md:hidden",
        },
        {
            id: "link",
            label: "Invitation",
            render: (h) =>
                h.invitationUrl ? (
                    <span className="flex items-center gap-2">
                        <CopyCode code={h.invitationUrl} label={`Copy invitation link for ${h.name}`} hideCode />
                        {h.invitationGeneratedAt ? (
                            <span className="text-xs text-tertiary">Ready</span>
                        ) : (
                            <span className="text-xs text-quaternary">Not generated</span>
                        )}
                    </span>
                ) : (
                    <span className="text-sm text-quaternary">{h.inviteRevokedAt ? "Revoked" : "No link"}</span>
                ),
        },
        {
            id: "code",
            label: "RSVP code",
            tooltip: "Guests can also enter this code, if short codes are allowed.",
            render: (h) => <CopyCode code={h.rsvpCode} />,
            className: "max-xl:hidden",
        },
        {
            id: "place",
            label: "Location",
            sortValue: (h) => h.locality,
            render: (h) => [h.locality, h.region].filter(Boolean).join(", ") || <span className="text-quaternary">—</span>,
            className: "max-2xl:hidden",
        },
    ];

    return (
        <>
            <PageHeader
                title="Households"
                description="Invitations go to households. Each has a signed RSVP link; see who has answered and who still needs a nudge."
                breadcrumbs={[{ label: "Households" }]}
                actions={
                    <>
                        {can("wedding.export") && households.items.length > 0 && (
                            <Button color="secondary" iconLeading={Download01} href="/api/portal/export/invitations.csv" download>
                                Download invitation list
                            </Button>
                        )}
                        {canEdit && (
                            <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                Add household
                            </Button>
                        )}
                    </>
                }
            />

            {households.items.length > 0 && (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    <MetricCard
                        label="Complete"
                        value={counts("complete")}
                        progress={percent(counts("complete"), invitedHouseholds)}
                        progressLabel={`${percent(counts("complete"), invitedHouseholds)}% of invited households`}
                    />
                    <MetricCard label="Partly answered" value={counts("partial")} detail="Someone still to answer" />
                    <MetricCard label="No reply yet" value={counts("not_started")} detail={`${counts("not_invited")} not invited to an event`} />
                    <MetricCard label="Invitations ready" value={ready} detail={`of ${pluralise(households.items.length, "household")}`} />
                </div>
            )}

            <DataTable
                title="All households"
                rows={rows}
                columns={columns}
                searchText={(h) => [h.name, h.email, h.rsvpCode, h.locality, ...h.response.guestNames].filter(Boolean).join(" ")}
                searchPlaceholder="Search households or guests"
                initialSort={{ column: "name", direction: "ascending" }}
                onRowAction={openPanel}
                selectable={canEdit}
                activeFilterCount={status === "all" ? 0 : 1}
                onClearFilters={() => setStatus("all")}
                filters={
                    <Select
                        aria-label="Response"
                        label="Response"
                        size="sm"
                        className="w-full sm:w-52"
                        items={[
                            { id: "all", label: "All" },
                            ...(Object.keys(RESPONSE_LABELS) as HouseholdResponseStatus[]).map((id) => ({
                                id,
                                label: `${RESPONSE_LABELS[id]} (${counts(id)})`,
                            })),
                        ]}
                        value={status}
                        onChange={(v) => setStatus(v as typeof status)}
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                }
                bulkActions={(ids, clear) => (
                    <>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={Link01}
                            isLoading={generating}
                            showTextWhileLoading
                            isDisabled={!data.canGenerateLinks}
                            onClick={() => void generate(ids, clear)}
                        >
                            Generate invitations
                        </Button>
                        {data.emailDelivery ? (
                            <Button size="sm" color="secondary" iconLeading={Mail01} href="/portal/wedding/communications">
                                Send from Communications
                            </Button>
                        ) : (
                            <Tooltip title={sendHint}>
                                <TooltipTrigger className="cursor-not-allowed">
                                    <span className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-quaternary ring-1 ring-secondary ring-inset">
                                        <Mail01 className="size-4" aria-hidden="true" />
                                        Sending is off
                                    </span>
                                </TooltipTrigger>
                            </Tooltip>
                        )}
                    </>
                )}
                emptyState={
                    <Empty
                        icon={Building07}
                        title="No households yet"
                        description="Group guests who share an invitation (a couple, a family) so they can RSVP together. Importing a Say I Do guest list creates them for you."
                        actions={
                            canEdit && (
                                <>
                                    <Button color="secondary" href="/portal/wedding/guests/import">
                                        Import guests
                                    </Button>
                                    <Button iconLeading={Plus} onClick={() => openPanel(null)}>
                                        Add household
                                    </Button>
                                </>
                            )
                        }
                    />
                }
            />
            {!data.canGenerateLinks && (
                <p className="text-sm text-tertiary">Invitation links need RSVP_LINK_SECRET on this environment before they can be generated.</p>
            )}
            {households.items.length > 0 && <p className="text-sm text-tertiary">{sendHint}</p>}

            <EntityPanel
                isOpen={open}
                onOpenChange={setOpen}
                noun="household"
                name={editing?.name ?? null}
                description={
                    editing
                        ? `${pluralise(editing.guestCount, "guest")}${editing.response.guestNames.length ? `: ${editing.response.guestNames.join(", ")}` : ""}`
                        : "Guests are added to households from the guest list."
                }
                canEdit={canEdit}
                onSave={async () => {
                    const saved = await households.save(editing?.id ?? null, draft);
                    await refresh();
                    return saved;
                }}
                onDelete={editing ? () => households.remove(editing.id) : undefined}
                deleteWarning="Its RSVP code stops working straight away. Its guests stay on the guest list. You can restore the household from Settings → Privacy."
            >
                {(fieldError) => (
                    <>
                        {editing && (
                            <div className="flex flex-col gap-2 rounded-xl bg-secondary p-4">
                                <p className="text-sm font-semibold text-secondary">RSVP progress</p>
                                <ResponseCell row={editing} />
                                {editing.response.lastResponseAt && (
                                    <p className="text-xs text-tertiary">
                                        Last answer <Timestamp iso={editing.response.lastResponseAt} />
                                    </p>
                                )}
                                {editing.invitationGeneratedAt && (
                                    <p className="text-xs text-tertiary">
                                        Invitation generated <Timestamp iso={editing.invitationGeneratedAt} /> (not sent)
                                    </p>
                                )}
                            </div>
                        )}
                        {editing && (
                            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-secondary p-4">
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm font-semibold text-secondary">RSVP code</p>
                                    <CopyCode code={editing.rsvpCode} />
                                </div>
                                {canEdit && (
                                    <Button size="sm" color="secondary" iconLeading={RefreshCw01} onClick={() => setRegenerate(editing)}>
                                        Issue new code
                                    </Button>
                                )}
                            </div>
                        )}
                        {editing && (
                            <div className="flex flex-col gap-3 rounded-xl bg-secondary p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-secondary">Secure invitation link</p>
                                        <p className="text-sm text-tertiary">
                                            {editing.inviteRevokedAt
                                                ? "Revoked. The previous link no longer opens this household."
                                                : editing.invitationUrl
                                                  ? "Signed and unique to this household."
                                                  : "RSVP_LINK_SECRET is not configured for this environment."}
                                        </p>
                                    </div>
                                    {editing.invitationUrl && <CopyCode code={editing.invitationUrl} label="Copy invitation link" />}
                                </div>
                                {canEdit && (
                                    <div className="flex flex-wrap gap-2">
                                        {editing.inviteRevokedAt ? (
                                            <Button
                                                size="sm"
                                                color="secondary"
                                                iconLeading={Link01}
                                                onClick={() => setInvitationAction({ household: editing, action: "restore" })}
                                            >
                                                Issue link
                                            </Button>
                                        ) : (
                                            <>
                                                <Button
                                                    size="sm"
                                                    color="secondary"
                                                    iconLeading={RefreshCw01}
                                                    onClick={() => setInvitationAction({ household: editing, action: "rotate" })}
                                                >
                                                    Rotate link
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    color="tertiary-destructive"
                                                    onClick={() => setInvitationAction({ household: editing, action: "revoke" })}
                                                >
                                                    Revoke link
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                        <FormGrid>
                            <FullWidth>{field("name", "Household name", fieldError, { isRequired: true, placeholder: "The Smith family" })}</FullWidth>
                            {field("email", "Contact email", fieldError, { type: "email" })}
                            {field("phone", "Phone", fieldError, { type: "tel" })}
                            <FullWidth>{field("addressLine1", "Address", fieldError)}</FullWidth>
                            <FullWidth>{field("addressLine2", "Address line 2", fieldError)}</FullWidth>
                            {field("locality", "Suburb or town", fieldError)}
                            {field("region", "State", fieldError)}
                            {field("postcode", "Postcode", fieldError)}
                            {field("country", "Country", fieldError)}
                            <FullWidth>
                                <TextArea label="Notes" rows={3} value={draft.notes} onChange={(v) => setDraft({ ...draft, notes: v })} />
                            </FullWidth>
                        </FormGrid>
                    </>
                )}
            </EntityPanel>

            <ConfirmDialog
                isOpen={!!regenerate}
                onOpenChange={(o) => !o && setRegenerate(null)}
                title="Issue a new RSVP code?"
                description="The current code stops working straight away. Only do this if the old code was shared with the wrong people."
                confirmLabel="Issue new code"
                onConfirm={async () => {
                    if (!regenerate) return;
                    try {
                        const { household } = await api<{ household: Household }>("POST", `/api/portal/wedding/households/${regenerate.id}/code`, {});
                        replace(household);
                        toast.success("New code issued", household.rsvpCode);
                    } catch (error) {
                        toast.error("Couldn't issue a new code", errorMessage(error));
                    }
                }}
            />
            <ConfirmDialog
                isOpen={!!invitationAction}
                onOpenChange={(open) => !open && setInvitationAction(null)}
                title={
                    invitationAction?.action === "revoke"
                        ? "Revoke this invitation link?"
                        : invitationAction?.action === "rotate"
                          ? "Rotate this invitation link?"
                          : "Issue a new invitation link?"
                }
                description={
                    invitationAction?.action === "revoke"
                        ? "The current link stops working immediately. The short code is controlled separately in RSVP settings."
                        : invitationAction?.action === "rotate"
                          ? "The current link stops working immediately and a new signed link is created."
                          : "A signed invitation link will be created for this household."
                }
                confirmLabel={invitationAction?.action === "revoke" ? "Revoke link" : invitationAction?.action === "rotate" ? "Rotate link" : "Issue link"}
                destructive={invitationAction?.action === "revoke"}
                onConfirm={async () => {
                    if (!invitationAction) return;
                    const { household } = await api<{ household: Household }>(
                        "POST",
                        `/api/portal/wedding/households/${invitationAction.household.id}/invitation`,
                        { action: invitationAction.action },
                    );
                    replace(household);
                    toast.success(invitationAction.action === "revoke" ? "Invitation link revoked" : "Invitation link ready");
                }}
            />
        </>
    );
};
