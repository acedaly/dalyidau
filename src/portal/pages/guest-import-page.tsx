// Guest import: choose a CSV (Say I Do's export or any guest list), review and edit the proposed
// households and guests, then apply. The server plans every step; this page only collects the
// person's decisions and shows the plan. Nothing is written until "Import".
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileCheck02 } from "@untitledui/icons";
import { FileUploadDropZone } from "@/components/application/file-upload/file-upload-base";
import { Tabs } from "@/components/application/tabs/tabs";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Toggle } from "@/components/base/toggle/toggle";
import { type DataColumn, DataTable } from "@/portal/components/data-table";
import { Empty } from "@/portal/components/empty";
import { FormError } from "@/portal/components/form";
import { MetricCard } from "@/portal/components/metric-card";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { useToast } from "@/portal/components/toast";
import {
    ActionBadge,
    type Directory,
    type GuestDecision,
    type HouseholdDecision,
    HouseholdReview,
    Issues,
    LooseGuests,
    needsAttention,
} from "@/portal/guests/import/household-review";
import { ImportReportView, summaryText } from "@/portal/guests/import/import-report";
import { ApiError, api, errorMessage } from "@/portal/lib/api";
import { pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import type { ImportDecisions, ImportHistoryEntry, ImportPlan, ImportReport } from "@/shared/portal/guest-import";

type Decisions = Required<Pick<ImportDecisions, "households" | "guests">> & Omit<ImportDecisions, "households" | "guests">;
const EMPTY: Decisions = { households: {}, guests: {} };

const History = ({ imports, onOpen }: { imports: ImportHistoryEntry[]; onOpen: (id: string) => void }) => {
    const columns: DataColumn<ImportHistoryEntry>[] = [
        { id: "at", label: "Imported", sortValue: (i) => i.createdAt, render: (i) => <Timestamp iso={i.createdAt} />, isRowHeader: true },
        { id: "file", label: "File", render: (i) => i.fileName ?? <span className="text-quaternary">—</span>, className: "max-md:hidden" },
        { id: "by", label: "By", render: (i) => i.actor, className: "max-lg:hidden" },
        { id: "result", label: "Result", render: (i) => <span className="text-tertiary">{summaryText(i.summary)}</span> },
    ];
    return (
        <DataTable
            title="Previous imports"
            rows={imports}
            columns={columns}
            onRowAction={(i) => onOpen(i.id)}
            initialSort={{ column: "at", direction: "descending" }}
            pageSize={10}
            emptyState={<Empty icon={FileCheck02} title="No imports yet" description="Imports you apply are listed here with a downloadable report." />}
        />
    );
};

export const GuestImportPage = ({ data }: { data: PageData<"guest-import"> }) => {
    const { can } = usePortal();
    const toast = useToast();
    const [file, setFile] = useState<{ name: string; text: string } | null>(null);
    const [plan, setPlan] = useState<ImportPlan | null>(null);
    const [decisions, setDecisions] = useState<Decisions>(EMPTY);
    const [report, setReport] = useState<ImportReport | null>(null);
    const [imports, setImports] = useState(data.imports);
    const [busy, setBusy] = useState(false);
    const [planning, setPlanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<"attention" | "all" | "changes">("all");
    const [clientId, setClientId] = useState(() => crypto.randomUUID());
    const request = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const directory: Directory = useMemo(() => ({ households: data.households, guests: data.guests }), [data.households, data.guests]);

    const runPreview = async (source: { name: string; text: string }, next: Decisions) => {
        const id = ++request.current;
        setPlanning(true);
        setError(null);
        try {
            const { plan: fresh } = await api<{ plan: ImportPlan }>("POST", "/api/portal/wedding/guests/import/preview", { csv: source.text, decisions: next });
            // A slower, older preview never replaces a newer one.
            if (id === request.current) setPlan(fresh);
        } catch (e) {
            if (id === request.current) setError(e instanceof ApiError && e.issues[0] ? e.issues[0].message : errorMessage(e));
        } finally {
            if (id === request.current) setPlanning(false);
        }
    };

    const update = (change: (current: Decisions) => Decisions, delay = 150) => {
        // The shown plan is stale from this moment: Import stays disabled until the new one arrives.
        setPlanning(true);
        setDecisions((current) => {
            const next = change(current);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => file && void runPreview(file, next), delay);
            return next;
        });
    };
    useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

    const onGuest = (key: string, patch: GuestDecision) =>
        update((d) => ({ ...d, guests: { ...d.guests, [key]: { ...d.guests[key], ...patch } } }), "firstName" in patch || "lastName" in patch ? 600 : 150);
    const onHousehold = (key: string, patch: HouseholdDecision) =>
        update((d) => ({ ...d, households: { ...d.households, [key]: { ...d.households[key], ...patch } } }), "name" in patch ? 600 : 150);

    const reset = () => {
        setFile(null);
        setPlan(null);
        setDecisions(EMPTY);
        setReport(null);
        setError(null);
        setClientId(crypto.randomUUID());
    };

    const apply = async () => {
        if (!file || !plan) return;
        setBusy(true);
        setError(null);
        try {
            const result = await api<{ report: ImportReport }>("POST", "/api/portal/wedding/guests/import", {
                csv: file.text,
                fileName: file.name,
                clientId,
                decisions,
                basis: plan.basis,
            });
            setReport(result.report);
            setImports((list) => [{ ...result.report, rows: undefined } as unknown as ImportHistoryEntry, ...list.filter((i) => i.id !== result.report.id)]);
            toast.success("Import complete", summaryText(result.report.summary));
            window.scrollTo({ top: 0 });
        } catch (e) {
            setError(errorMessage(e));
            // Someone changed the guest list in the meantime: show the up-to-date plan.
            if (e instanceof ApiError && e.status === 409) void runPreview(file, decisions);
        } finally {
            setBusy(false);
        }
    };

    const openReport = async (id: string) => {
        try {
            setReport((await api<{ report: ImportReport }>("GET", `/api/portal/wedding/guests/imports/${id}`)).report);
        } catch (e) {
            toast.error("Couldn't open that report", errorMessage(e));
        }
    };

    // -------------------------------------------------------------------------------------------

    const header = (
        <PageHeader
            title="Import guests"
            description="Bring in a Say I Do guest list export (or any CSV). You'll see every household and guest before anything is saved."
            breadcrumbs={[{ label: "Guests", href: "/portal/wedding/guests" }, { label: "Import" }]}
            homeHref="/portal/wedding"
            actions={
                <Button color="secondary" iconLeading={ArrowLeft} href="/portal/wedding/guests">
                    Back to guests
                </Button>
            }
        />
    );

    if (report) {
        return (
            <>
                {header}
                <ImportReportView report={report} onDone={reset} />
            </>
        );
    }

    if (!file || !plan) {
        return (
            <>
                {header}
                <section className="flex max-w-3xl flex-col gap-4" aria-label="Choose a file">
                    <FormError message={error} />
                    <FileUploadDropZone
                        accept=".csv,text/csv"
                        allowsMultiple={false}
                        maxSize={1_000_000}
                        hint="CSV up to 1 MB · up to 2,000 guests"
                        isDisabled={planning}
                        onDropFiles={async (files) => {
                            const chosen = files[0];
                            if (!chosen) return;
                            const loaded = { name: chosen.name, text: await chosen.text() };
                            setFile(loaded);
                            await runPreview(loaded, EMPTY);
                        }}
                        onDropUnacceptedFiles={() =>
                            setError("Choose a .csv file. In Say I Do, export the guest list; in a spreadsheet, use File → Download → CSV.")
                        }
                        onSizeLimitExceed={() => setError("That file is larger than 1 MB. Split it into smaller files.")}
                    />
                    {planning && (
                        <p className="text-sm text-tertiary" role="status">
                            Reading the file…
                        </p>
                    )}
                    <details className="text-sm text-tertiary">
                        <summary className="cursor-pointer font-semibold text-secondary">What happens to a Say I Do export?</summary>
                        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                            <li>Guests who share a Party Name and Unique link become one household, with its own signed invitation link here.</li>
                            <li>Guest Name is split into first and last names; anything unusual is flagged for you to check.</li>
                            <li>Mailing addresses become the household's postal address. Differing addresses within a party are flagged.</li>
                            <li>An empty Attending cell means no reply yet. “Plus One Allowed: No” never removes a named guest.</li>
                            <li>Guests and households already in the portal are matched, so importing the same file again doesn't create duplicates.</li>
                            <li>Recorded RSVPs, names and addresses are only replaced if you tick “Replace”.</li>
                        </ul>
                    </details>
                </section>
                <History imports={imports} onOpen={(id) => void openReport(id)} />
            </>
        );
    }

    // -------------------------------------------------------------------------------------------
    // Review

    const guestsByHousehold = new Map<string, ImportPlan["guests"]>();
    for (const guest of plan.guests) {
        const key = guest.householdKey ?? "";
        guestsByHousehold.set(key, [...(guestsByHousehold.get(key) ?? []), guest]);
    }
    const loose = guestsByHousehold.get("") ?? [];
    const attention = plan.households.filter((h) => needsAttention(h, guestsByHousehold.get(h.key) ?? []));
    const withChanges = plan.households.filter(
        (h) =>
            h.action === "create" || h.action === "update" || (guestsByHousehold.get(h.key) ?? []).some((g) => g.action !== "unchanged" && g.action !== "skip"),
    );
    const shown = filter === "attention" ? attention : filter === "changes" ? withChanges : plan.households;
    const s = plan.summary;
    const changes = s.guests.create + s.guests.update + s.guests.link + s.households.create + s.households.update;
    const capitalisable = plan.guests.filter((g) => g.suggestedName && g.action !== "skip");
    const unconfirmed = [
        ...plan.guests.flatMap((g) => g.changes.filter((c) => !c.applied).map((c) => ({ kind: "guests" as const, key: g.key, field: c.field }))),
        ...plan.households.flatMap((h) => h.changes.filter((c) => !c.applied).map((c) => ({ kind: "households" as const, key: h.key, field: c.field }))),
    ];
    const inviteIds = decisions.inviteEventIds ?? plan.inviteEventIds;
    const rsvpFromSayIDo = (decisions.rsvpSource ?? (plan.source === "sayido" ? "sayido" : "import")) === "sayido";
    const rowLedger = [
        ...plan.guests.map((guest) => ({
            line: guest.line,
            name: `${guest.firstName} ${guest.lastName}`.trim() || guest.rawName,
            action: guest.action,
            match: guest.target.kind === "existing" ? `Existing guest: ${guest.target.name}` : guest.target.kind === "skip" ? guest.target.reason : "New guest",
            note: guest.issues.map((issue) => issue.message).join(" · "),
        })),
        ...plan.errors.map((row) => ({ line: row.line, name: row.name || "Unnamed row", action: "error", match: "Cannot import", note: row.message })),
    ].sort((a, b) => a.line - b.line);

    return (
        <>
            {header}
            <div className="flex flex-col gap-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-secondary">
                        <span className="font-semibold">{file.name}</span> · {plan.source === "sayido" ? "Say I Do guest list" : "CSV"} ·{" "}
                        {pluralise(s.rows, "row")}
                    </p>
                    <Button color="link-gray" size="sm" onClick={reset}>
                        Choose another file
                    </Button>
                </div>

                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    <MetricCard label="New guests" value={s.guests.create} detail={`${pluralise(s.households.create, "new household")}`} />
                    <MetricCard
                        label="Existing guests"
                        value={s.guests.update + s.guests.link + s.guests.unchanged}
                        detail={`${s.guests.unchanged} already up to date`}
                    />
                    <MetricCard
                        label="Names to check"
                        value={s.nameReview}
                        detail={s.addressConflicts ? pluralise(s.addressConflicts, "address conflict") : "No address conflicts"}
                    />
                    <MetricCard
                        label="Kept unless confirmed"
                        value={s.unconfirmed}
                        detail={s.errors ? pluralise(s.errors, "row") + " can't be imported" : "Every row can be imported"}
                    />
                </div>

                {plan.previousImports.length > 0 && (
                    <Notice color="brand" title="This exact file was imported before">
                        Last imported <Timestamp iso={plan.previousImports[0].createdAt} /> by {plan.previousImports[0].actor}. Only differences are shown as
                        changes; nothing will be duplicated.
                    </Notice>
                )}
                {plan.fileIssues.length > 0 && <Issues issues={plan.fileIssues} />}

                <section
                    aria-labelledby="import-options"
                    className="flex flex-col gap-4 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary ring-inset md:p-5"
                >
                    <h2 id="import-options" className="text-md font-semibold text-primary">
                        Options
                    </h2>
                    {plan.events.length > 0 && (
                        <fieldset className="flex flex-col gap-2">
                            <legend className="mb-2 text-sm font-medium text-secondary">Invite new guests to</legend>
                            {plan.events.map((event) => (
                                <Checkbox
                                    key={event.id}
                                    label={event.name}
                                    hint={event.rsvpEnabled ? undefined : "RSVPs are off for this event"}
                                    isSelected={inviteIds.includes(event.id)}
                                    onChange={(on) =>
                                        update((d) => ({
                                            ...d,
                                            inviteEventIds: on ? [...new Set([...inviteIds, event.id])] : inviteIds.filter((id) => id !== event.id),
                                        }))
                                    }
                                />
                            ))}
                            <p className="text-sm text-tertiary">Existing guests keep their invitations; anyone not invited to anything yet gets these too.</p>
                        </fieldset>
                    )}
                    <Toggle
                        label="Answers came from Say I Do"
                        hint="Any Yes/No in the Attending column is labelled as a Say I Do reply. Empty cells are never treated as replies."
                        isSelected={rsvpFromSayIDo}
                        // The toggle sizes to its text by default; let the long hint wrap on phones.
                        className="w-full max-w-full"
                        onChange={(on) => update((d) => ({ ...d, rsvpSource: on ? "sayido" : "import" }))}
                    />
                    {(capitalisable.length > 0 || unconfirmed.length > 0) && (
                        <div className="flex flex-wrap gap-3">
                            {capitalisable.length > 0 && (
                                <Button
                                    size="sm"
                                    color="secondary"
                                    onClick={() =>
                                        update((d) => {
                                            const guests = { ...d.guests };
                                            for (const g of capitalisable) guests[g.key] = { ...guests[g.key], ...g.suggestedName! };
                                            const households = { ...d.households };
                                            for (const h of plan.households)
                                                if (h.suggestedName) households[h.key] = { ...households[h.key], name: h.suggestedName };
                                            return { ...d, guests, households };
                                        })
                                    }
                                >
                                    Fix capitalisation ({capitalisable.length})
                                </Button>
                            )}
                            {unconfirmed.length > 0 && (
                                <Button
                                    size="sm"
                                    color="secondary"
                                    onClick={() =>
                                        update((d) => {
                                            const next: Decisions = { ...d, guests: { ...d.guests }, households: { ...d.households } };
                                            for (const u of unconfirmed) {
                                                const current = next[u.kind][u.key] ?? {};
                                                next[u.kind][u.key] = { ...current, confirm: [...new Set([...(current.confirm ?? []), u.field])] };
                                            }
                                            return next;
                                        })
                                    }
                                >
                                    Replace all recorded values ({unconfirmed.length})
                                </Button>
                            )}
                        </div>
                    )}
                </section>

                {plan.errors.length > 0 && (
                    <Notice color="warning" title={`${pluralise(plan.errors.length, "row")} can't be imported`}>
                        <ul className="mt-1 flex flex-col gap-1">
                            {plan.errors.map((e) => (
                                <li key={e.line}>
                                    Line {e.line} ({e.name}): {e.message}
                                </li>
                            ))}
                        </ul>
                    </Notice>
                )}

                <section aria-labelledby="all-import-rows" className="overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary ring-inset">
                    <div className="border-b border-secondary px-4 py-4 md:px-5">
                        <h2 id="all-import-rows" className="text-md font-semibold text-primary">
                            Every CSV row
                        </h2>
                        <p className="mt-1 text-sm text-tertiary">
                            {rowLedger.length} of {s.rows} data rows are accounted for. Errors remain in the final report and are never silently skipped.
                        </p>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-secondary text-sm">
                            <thead className="bg-secondary text-left text-xs font-semibold tracking-wide text-tertiary uppercase">
                                <tr>
                                    <th className="px-4 py-3 md:px-5">Line</th>
                                    <th className="px-4 py-3">Guest</th>
                                    <th className="px-4 py-3">Decision</th>
                                    <th className="px-4 py-3">Match / issue</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-secondary">
                                {rowLedger.map((row) => (
                                    <tr key={row.line} data-testid={`import-row-${row.line}`}>
                                        <td className="px-4 py-3 text-tertiary md:px-5">{row.line}</td>
                                        <th scope="row" className="px-4 py-3 text-left font-medium text-primary">
                                            {row.name}
                                        </th>
                                        <td className="px-4 py-3">
                                            <ActionBadge action={row.action} />
                                        </td>
                                        <td className="max-w-md px-4 py-3 text-tertiary">{row.note || row.match}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                <Tabs selectedKey={filter} onSelectionChange={(key) => setFilter(key as typeof filter)}>
                    <Tabs.List type="button-minimal" size="sm" className="w-max max-w-full overflow-x-auto">
                        <Tabs.Item id="all" badge={plan.households.length}>
                            All households
                        </Tabs.Item>
                        <Tabs.Item id="attention" badge={attention.length}>
                            Needs a look
                        </Tabs.Item>
                        <Tabs.Item id="changes" badge={withChanges.length}>
                            With changes
                        </Tabs.Item>
                    </Tabs.List>
                    <Tabs.Panel id={filter} className="flex flex-col gap-4 pt-4">
                        {shown.length === 0 && <p className="text-sm text-tertiary">Nothing here.</p>}
                        {shown.map((household) => (
                            <HouseholdReview
                                key={household.key}
                                household={household}
                                guests={guestsByHousehold.get(household.key) ?? []}
                                decision={decisions.households[household.key]}
                                guestDecisions={decisions.guests}
                                directory={directory}
                                onHousehold={(patch) => onHousehold(household.key, patch)}
                                onGuest={onGuest}
                            />
                        ))}
                        {filter === "all" && loose.length > 0 && (
                            <LooseGuests guests={loose} guestDecisions={decisions.guests} directory={directory} onGuest={onGuest} />
                        )}
                    </Tabs.Panel>
                </Tabs>
            </div>

            <div
                className="sticky bottom-0 z-20 -mx-4 -mb-8 border-t border-secondary bg-primary px-4 py-3 lg:-mx-8 lg:-mb-12 lg:px-8"
                role="region"
                aria-label="Import actions"
            >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 text-sm" aria-live="polite">
                        <FormError message={error} />
                        {!error && (
                            <p className="text-secondary">
                                {planning ? "Updating the preview…" : summaryText(s)}
                                {!planning && s.unconfirmed > 0 && <span className="text-tertiary"> · {s.unconfirmed} recorded values kept</span>}
                            </p>
                        )}
                    </div>
                    <Button
                        size="lg"
                        onClick={() => void apply()}
                        isLoading={busy}
                        showTextWhileLoading
                        isDisabled={planning || changes === 0 || !can("wedding.guests.edit")}
                        className="shrink-0"
                    >
                        {changes === 0
                            ? "Everything is up to date"
                            : s.guests.create + s.guests.update + s.guests.link > 0
                              ? `Import ${pluralise(s.guests.create + s.guests.update + s.guests.link, "guest")}`
                              : "Apply changes"}
                    </Button>
                </div>
            </div>
        </>
    );
};
