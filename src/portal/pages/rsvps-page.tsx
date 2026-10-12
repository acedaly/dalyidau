import { useState } from "react";
import { CalendarCheck01, CheckCircle, Clock, Download01, Eye, LinkExternal01, MessageChatCircle, XCircle } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Toggle } from "@/components/base/toggle/toggle";
import { AttendanceBars } from "@/portal/components/charts";
import { CopyCode } from "@/portal/components/copy-code";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { DateField } from "@/portal/components/date-field";
import { Empty } from "@/portal/components/empty";
import { FormSection, useSubmit } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { api } from "@/portal/lib/api";
import { formatDate, formatNumber, percent } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { RsvpSettings, RsvpSubmission } from "@/shared/portal/types";

type HouseholdRow = PageData<"rsvps">["households"][number];

export const RsvpsPage = ({ data }: { data: PageData<"rsvps"> }) => {
    const { can, isOn } = usePortal();
    const [settings, setSettings] = useState<RsvpSettings>(data.settings);
    const [draft, setDraft] = useState<RsvpSettings>(data.settings);
    const native = isOn("rsvp.native");
    const { rsvp } = data.stats;
    const invited = rsvp.attending + rsvp.declined + rsvp.pending;
    const eventNames = new Map(data.events.map((e) => [e.id, e.name]));

    const save = useSubmit(() => api<{ value: RsvpSettings }>("PUT", "/api/portal/settings/rsvp", draft), {
        success: "RSVP settings saved",
        onSuccess: ({ value }) => {
            setSettings(value);
            setDraft(value);
        },
    });

    const householdColumns: DataColumn<HouseholdRow>[] = [
        {
            id: "name",
            label: "Household",
            isRowHeader: true,
            sortValue: (h) => h.name,
            render: (h) => <span className="font-medium text-primary">{h.name}</span>,
        },
        {
            id: "progress",
            label: "Replied",
            sortValue: (h) => (h.guests ? h.responded / h.guests : -1),
            render: (h) =>
                h.guests === 0 ? (
                    <span className="text-quaternary">No guests</span>
                ) : h.responded === h.guests ? (
                    <BadgeWithDot size="sm" color="success">
                        All {h.guests} replied
                    </BadgeWithDot>
                ) : (
                    <BadgeWithDot size="sm" color={h.responded ? "warning" : "gray"}>
                        {h.responded} of {h.guests}
                    </BadgeWithDot>
                ),
        },
        { id: "code", label: "RSVP code", render: (h) => <CopyCode code={h.rsvpCode} /> },
    ];

    const submissionColumns: DataColumn<RsvpSubmission>[] = [
        {
            id: "household",
            label: "Household",
            isRowHeader: true,
            sortValue: (s) => s.householdName,
            render: (s) => <span className="font-medium text-primary">{s.householdName}</span>,
        },
        { id: "at", label: "Received", sortValue: (s) => s.submittedAt, render: (s) => <Timestamp iso={s.submittedAt} /> },
        {
            id: "answers",
            label: "Answers",
            render: (s) => (
                <ul className="flex flex-col gap-1">
                    {s.payload.guests.map((g) => (
                        <li key={g.guestId} className="text-sm">
                            <span className="font-medium text-secondary">{g.name}: </span>
                            {Object.entries(g.events)
                                .map(([eventId, status]) => `${eventNames.get(eventId) ?? "Event"} ${status === "attending" ? "✓" : "✗"}`)
                                .join(", ")}
                            {g.dietary && <span className="text-tertiary"> · {g.dietary}</span>}
                        </li>
                    ))}
                </ul>
            ),
        },
        {
            id: "message",
            label: "Message",
            render: (s) => (s.message ? <p className="max-w-80 whitespace-pre-line">{s.message}</p> : <span className="text-quaternary">—</span>),
            className: "max-lg:hidden",
        },
    ];

    return (
        <>
            <PageHeader
                title="RSVPs"
                description="Replies across every event, from Say I Do, the native form and anything entered by hand."
                breadcrumbs={[{ label: "RSVPs" }]}
                actions={
                    can("wedding.export") && (
                        <Button color="secondary" iconLeading={Download01} href="/api/portal/export/rsvps.csv" download>
                            Export responses
                        </Button>
                    )
                }
            />

            <section
                aria-label="Live RSVP form"
                className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset md:flex-row md:items-center md:justify-between"
            >
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-md font-semibold text-primary">Live RSVP form</h2>
                        <Badge size="sm" type="pill-color" color={native ? "success" : "brand"}>
                            {native ? "Native form" : "Say I Do"}
                        </Badge>
                    </div>
                    <p className="text-sm text-tertiary">
                        {native
                            ? "Guests reply at /wedding/rsvp with their household code. Responses update the guest list immediately."
                            : settings.externalUrl
                              ? "Guests are sent to Say I Do. Record their replies here by hand or by importing a Say I Do export from the guest list."
                              : "No RSVP link is set yet. Add the Say I Do link below so the website can point guests to it."}
                    </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-3">
                    {!native && settings.externalUrl && (
                        <Button color="secondary" iconTrailing={LinkExternal01} href={settings.externalUrl} target="_blank" rel="noreferrer">
                            Open Say I Do
                        </Button>
                    )}
                    {can("wedding.rsvp.edit") && (
                        <Button color="secondary" iconLeading={Eye} href="/portal/wedding/website/preview/rsvp" target="_blank">
                            {native ? "Preview the form" : "Test the native form"}
                        </Button>
                    )}
                </div>
            </section>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Attending" icon={CheckCircle} value={formatNumber(rsvp.attending)} detail="Guests coming to at least one event" />
                <MetricCard label="Declined" icon={XCircle} value={formatNumber(rsvp.declined)} detail="Guests who declined everything" />
                <MetricCard
                    label="Awaiting reply"
                    icon={Clock}
                    value={formatNumber(rsvp.pending)}
                    detail={rsvp.notInvited ? `${formatNumber(rsvp.notInvited)} more not invited to any event` : undefined}
                />
                <MetricCard
                    label="Response rate"
                    icon={CalendarCheck01}
                    value={`${percent(rsvp.attending + rsvp.declined, invited)}%`}
                    progress={percent(rsvp.attending + rsvp.declined, invited)}
                    progressLabel={settings.deadline ? `Closes ${formatDate(settings.deadline)}` : "No deadline set"}
                />
            </div>

            <section aria-labelledby="by-event" className="flex flex-col gap-5 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                <h2 id="by-event" className="text-md font-semibold text-primary">
                    By event
                </h2>
                {data.stats.events.length === 0 ? (
                    <p className="text-sm text-tertiary">Add events to see attendance for each one.</p>
                ) : (
                    <AttendanceBars
                        caption="Replies by event"
                        rows={data.stats.events.map((e) => ({ label: e.name, invited: e.invited, attending: e.attending, declined: e.declined }))}
                    />
                )}
            </section>

            <Tabs defaultSelectedKey="households">
                <Tabs.List type="button-minimal" size="sm" className="w-max max-w-full overflow-x-auto">
                    <Tabs.Item id="households">Households</Tabs.Item>
                    <Tabs.Item id="responses" badge={data.submissions.length || undefined}>
                        Online responses
                    </Tabs.Item>
                    <Tabs.Item id="settings">Settings</Tabs.Item>
                </Tabs.List>
                <Tabs.Panel id="households" className="pt-6">
                    <DataTable
                        title="Replies by household"
                        rows={data.households}
                        columns={householdColumns}
                        searchText={(h) => `${h.name} ${h.rsvpCode}`}
                        searchPlaceholder="Search households"
                        initialSort={{ column: "progress", direction: "ascending" }}
                        emptyState={
                            <Empty
                                icon={CalendarCheck01}
                                title="No households yet"
                                description="Households group guests who RSVP together. Create them on the Households page."
                            />
                        }
                    />
                </Tabs.Panel>
                <Tabs.Panel id="responses" className="pt-6">
                    <DataTable
                        title="Online responses"
                        description="Every submission to the native RSVP form, newest first."
                        rows={data.submissions}
                        columns={submissionColumns}
                        searchText={(s) => `${s.householdName} ${s.message ?? ""}`}
                        initialSort={{ column: "at", direction: "descending" }}
                        emptyState={
                            <Empty
                                icon={MessageChatCircle}
                                title="No online responses"
                                description={
                                    native
                                        ? "Responses will appear here as guests reply."
                                        : "The native RSVP form is off; Say I Do is collecting replies for now."
                                }
                            />
                        }
                    />
                </Tabs.Panel>
                <Tabs.Panel id="settings" className="pt-6">
                    <form
                        noValidate
                        className="flex max-w-4xl flex-col gap-8"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void save.submit();
                        }}
                    >
                        <fieldset disabled={!can("portal.settings.manage")} className="flex flex-col gap-8">
                            <FormSection title="Say I Do" description="Where the website sends guests while the native form is off.">
                                <Input
                                    label="RSVP link"
                                    type="url"
                                    placeholder="https://…"
                                    value={draft.externalUrl}
                                    onChange={(v) => setDraft({ ...draft, externalUrl: v })}
                                    isInvalid={!!save.fieldError("externalUrl")}
                                    hint={save.fieldError("externalUrl") ?? "Copy the guest-facing link from Say I Do."}
                                />
                            </FormSection>
                            <FormSection title="Deadline" description="After this date the native form stops accepting changes.">
                                <DateField
                                    label="Reply by"
                                    value={draft.deadline || null}
                                    onChange={(v) => setDraft({ ...draft, deadline: v ?? "" })}
                                    error={save.fieldError("deadline")}
                                />
                            </FormSection>
                            <FormSection title="Questions" description="What the native form asks each guest.">
                                <Toggle
                                    label="Ask about dietary requirements"
                                    isSelected={draft.collectDietary}
                                    onChange={(v) => setDraft({ ...draft, collectDietary: v })}
                                />
                                <Toggle
                                    label="Allow a message to the couple"
                                    isSelected={draft.collectMessage}
                                    onChange={(v) => setDraft({ ...draft, collectMessage: v })}
                                />
                            </FormSection>
                        </fieldset>
                        {can("portal.settings.manage") && (
                            <div className="flex justify-end gap-3">
                                <Button color="secondary" onClick={() => setDraft(settings)} isDisabled={save.busy}>
                                    Reset
                                </Button>
                                <Button type="submit" isLoading={save.busy} showTextWhileLoading>
                                    Save settings
                                </Button>
                            </div>
                        )}
                    </form>
                </Tabs.Panel>
            </Tabs>
        </>
    );
};
