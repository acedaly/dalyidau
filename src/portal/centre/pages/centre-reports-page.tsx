// Situation reports: generate one on demand (NSW, a watch area, a region, an incident or a hazard,
// now or for a past moment as the Centre knew it then), preview it, save it; see saved reports;
// and schedule daily or weekly reports. Reports are deterministic; a narrative is optional AI.
import { useState } from "react";
import { CalendarDate, Edit05, FileCheck02, Plus, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { Card } from "@/portal/components/card";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { FormError } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { REGIONS, type RegionId } from "@/shared/centre/regions";
import type { ReportSchedule, ReportScope, ScheduleInput, SituationReport } from "@/shared/centre/reports";
import { CATEGORY_LABELS, HAZARD_CATEGORIES, type HazardCategory } from "@/shared/centre/sources";
import { centreApi } from "../centre-api";
import { ReportView } from "../report-view";
import { CENTRE, CentreHeader, CentreNotices, When } from "../shared";

type Data = PageData<"centre-reports">;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PERIODS = [6, 12, 24, 48, 72, 168];

interface ScopeDraft {
    kind: ReportScope["kind"];
    watchId: string;
    region: RegionId;
    recordId: string;
    category: HazardCategory;
}

const scopeOf = (s: ScopeDraft): ReportScope => {
    switch (s.kind) {
        case "nsw":
            return { kind: "nsw" };
        case "watch":
            return { kind: "watch", watchId: s.watchId };
        case "region":
            return { kind: "region", region: s.region };
        case "incident":
            // A record link or id: the id is the last part.
            return { kind: "incident", recordId: /icr_[a-z0-9]{14}/.exec(s.recordId)?.[0] ?? s.recordId.trim() };
        case "hazard":
            return { kind: "hazard", category: s.category, region: s.region };
    }
};

export const describeScope = (scope: ReportScope, watches: Data["watches"]) => {
    switch (scope.kind) {
        case "nsw":
            return "New South Wales";
        case "watch":
            return `Watch area: ${watches.find((w) => w.id === scope.watchId)?.name ?? "removed"}`;
        case "region":
            return REGIONS.find((r) => r.id === scope.region)?.label ?? scope.region;
        case "incident":
            return "One incident";
        case "hazard":
            return `${CATEGORY_LABELS[scope.category]}, ${REGIONS.find((r) => r.id === scope.region)?.label ?? scope.region}`;
    }
};

const ScopeFields = ({
    value,
    onChange,
    watches,
    allowIncident,
}: {
    value: ScopeDraft;
    onChange: (v: ScopeDraft) => void;
    watches: Data["watches"];
    allowIncident: boolean;
}) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NativeSelect
            label="Report on"
            value={value.kind}
            onChange={(e) => onChange({ ...value, kind: e.target.value as ScopeDraft["kind"] })}
            options={[
                { label: "All of NSW", value: "nsw" },
                { label: "One of my watch areas", value: "watch" },
                { label: "A region", value: "region" },
                { label: "A hazard", value: "hazard" },
                ...(allowIncident ? [{ label: "One incident", value: "incident" }] : []),
            ]}
        />
        {value.kind === "watch" && (
            <NativeSelect
                label="Watch area"
                value={value.watchId}
                onChange={(e) => onChange({ ...value, watchId: e.target.value })}
                options={watches.length ? watches.map((w) => ({ label: w.name, value: w.id })) : [{ label: "No watch areas yet", value: "" }]}
            />
        )}
        {value.kind === "hazard" && (
            <NativeSelect
                label="Hazard"
                value={value.category}
                onChange={(e) => onChange({ ...value, category: e.target.value as HazardCategory })}
                options={HAZARD_CATEGORIES.map((c) => ({ label: CATEGORY_LABELS[c], value: c }))}
            />
        )}
        {(value.kind === "region" || value.kind === "hazard") && (
            <NativeSelect
                label="Region"
                value={value.region}
                onChange={(e) => onChange({ ...value, region: e.target.value as RegionId })}
                options={REGIONS.map((r) => ({ label: r.label, value: r.id }))}
            />
        )}
        {value.kind === "incident" && (
            <Input
                label="Incident (record link or id)"
                value={value.recordId}
                onChange={(v) => onChange({ ...value, recordId: v })}
                placeholder="/portal/intelligence-centre/records/icr_…"
            />
        )}
    </div>
);

const blankScope = (watches: Data["watches"]): ScopeDraft => ({ kind: "nsw", watchId: watches[0]?.id ?? "", region: "nsw", recordId: "", category: "fire" });

const scopeDraftOf = (scope: ReportScope, watches: Data["watches"]): ScopeDraft => ({
    ...blankScope(watches),
    kind: scope.kind,
    ...(scope.kind === "watch" ? { watchId: scope.watchId } : {}),
    ...(scope.kind === "region" ? { region: scope.region } : {}),
    ...(scope.kind === "hazard" ? { region: scope.region, category: scope.category } : {}),
    ...(scope.kind === "incident" ? { recordId: scope.recordId } : {}),
});

const ScheduleForm = ({
    data,
    initial,
    onClose,
    onSaved,
}: {
    data: Data;
    initial: ReportSchedule | null;
    onClose: () => void;
    onSaved: (s: ReportSchedule) => void;
}) => {
    const toast = useToast();
    const [scope, setScope] = useState<ScopeDraft>(() => (initial ? scopeDraftOf(initial.scope, data.watches) : blankScope(data.watches)));
    const [f, setF] = useState<Omit<ScheduleInput, "scope">>(() =>
        initial
            ? { ...initial }
            : {
                  name: "",
                  frequency: "daily",
                  weekday: null,
                  hour: 7,
                  timeZone: data.preferences.timeZone,
                  periodHours: 24,
                  notify: "in_app",
                  narrative: false,
                  enabled: true,
              },
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const input: ScheduleInput = {
                name: f.name.trim(),
                scope: scopeOf(scope),
                frequency: f.frequency,
                weekday: f.frequency === "weekly" ? (f.weekday ?? 1) : null,
                hour: f.hour,
                timeZone: f.timeZone,
                periodHours: f.periodHours,
                notify: f.notify,
                narrative: f.narrative,
                enabled: f.enabled,
            };
            const { schedule } = initial
                ? await centreApi.updateSchedule(initial.id, { ...input, version: initial.version })
                : await centreApi.createSchedule(input);
            toast.success("Schedule saved");
            onSaved(schedule);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? "Edit report schedule" : "Schedule a report"}
            icon={CalendarDate}
            onSubmit={() => void save()}
            footer={
                <>
                    <Button size="md" color="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="md" type="submit" isLoading={busy} showTextWhileLoading>
                        Save
                    </Button>
                </>
            }
        >
            <FormError message={error} />
            <Input
                label="Name"
                value={f.name}
                onChange={(name) => setF((x) => ({ ...x, name }))}
                isRequired
                maxLength={80}
                placeholder="e.g. Morning situation"
            />
            <ScopeFields value={scope} onChange={setScope} watches={data.watches} allowIncident={false} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <NativeSelect
                    label="How often"
                    value={f.frequency}
                    onChange={(e) =>
                        setF((x) => ({
                            ...x,
                            frequency: e.target.value as ScheduleInput["frequency"],
                            weekday: e.target.value === "weekly" ? (x.weekday ?? 1) : null,
                        }))
                    }
                    options={[
                        { label: "Daily", value: "daily" },
                        { label: "Weekly", value: "weekly" },
                    ]}
                />
                {f.frequency === "weekly" && (
                    <NativeSelect
                        label="Day"
                        value={String(f.weekday ?? 1)}
                        onChange={(e) => setF((x) => ({ ...x, weekday: Number(e.target.value) }))}
                        options={WEEKDAYS.map((d, i) => ({ label: d, value: String(i) }))}
                    />
                )}
                <NativeSelect
                    label="At"
                    value={String(f.hour)}
                    onChange={(e) => setF((x) => ({ ...x, hour: Number(e.target.value) }))}
                    options={Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value: String(h) }))}
                    hint={f.timeZone}
                />
                <NativeSelect
                    label="Covering the last"
                    value={String(f.periodHours)}
                    onChange={(e) => setF((x) => ({ ...x, periodHours: Number(e.target.value) }))}
                    options={PERIODS.map((h) => ({ label: h < 48 ? `${h} hours` : `${h / 24} days`, value: String(h) }))}
                />
                <NativeSelect
                    label="Tell me"
                    value={f.notify}
                    onChange={(e) => setF((x) => ({ ...x, notify: e.target.value as ScheduleInput["notify"] }))}
                    options={[
                        { label: "In the portal", value: "in_app" },
                        { label: "In the portal and by email", value: "email" },
                        { label: "Don't notify", value: "none" },
                    ]}
                />
            </div>
            <Toggle
                label="Add an AI narrative"
                hint="Only if Daly Intelligence is switched on; written from the report's facts and labelled as interpretation."
                isSelected={f.narrative}
                onChange={(narrative) => setF((x) => ({ ...x, narrative }))}
            />
            <Toggle label="Enabled" isSelected={f.enabled} onChange={(enabled) => setF((x) => ({ ...x, enabled }))} />
            <p className="text-xs text-tertiary">A scheduled report isn't made again when its facts haven't changed since the last one.</p>
        </PortalDialog>
    );
};

export const CentreReportsPage = ({ data }: { data: Data }) => {
    const toast = useToast();
    const [scope, setScope] = useState<ScopeDraft>(() => blankScope(data.watches));
    const [periodHours, setPeriodHours] = useState(24);
    const [past, setPast] = useState("");
    const [narrative, setNarrative] = useState(false);
    const [preview, setPreview] = useState<SituationReport | null>(null);
    const [busy, setBusy] = useState<"preview" | "save" | null>(null);
    const [schedules, setSchedules] = useState(data.schedules);
    const [editing, setEditing] = useState<ReportSchedule | "new" | null>(null);
    const [deleting, setDeleting] = useState<ReportSchedule | null>(null);

    const request = () => ({
        scope: scopeOf(scope),
        periodHours,
        at: past ? new Date(past).toISOString() : null,
        narrative,
    });
    const run = async (kind: "preview" | "save") => {
        setBusy(kind);
        try {
            if (kind === "preview") setPreview((await centreApi.previewReport(request())).report);
            else {
                const { summary } = await centreApi.generateReport(request());
                window.location.href = `${CENTRE}/reports/${summary.id}`;
            }
        } catch (e) {
            toast.error("Couldn't make the report", errorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <>
            <CentreHeader
                title="Situation reports"
                crumb="Reports"
                shell={data}
                description="Evidence-linked reports built from stored records: official, observed and derived facts kept apart, with the sources and what's missing."
            />
            <CentreNotices shell={data} />
            <Card title="Generate a report" icon={FileCheck02}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    <ScopeFields value={scope} onChange={setScope} watches={data.watches} allowIncident />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <NativeSelect
                            label="Changes over the last"
                            value={String(periodHours)}
                            onChange={(e) => setPeriodHours(Number(e.target.value))}
                            options={PERIODS.map((h) => ({ label: h < 48 ? `${h} hours` : `${h / 24} days`, value: String(h) }))}
                        />
                        <Input
                            label="As at a past moment (optional)"
                            type="datetime-local"
                            value={past}
                            onChange={setPast}
                            hint="Empty: now. A past moment is reported from stored history, as the Centre knew it then."
                        />
                    </div>
                    <Toggle
                        label="Add an AI narrative"
                        hint={
                            data.aiAvailable
                                ? "Written from the facts only and labelled as interpretation."
                                : "Daly Intelligence is off, so no narrative will be added."
                        }
                        isSelected={narrative}
                        onChange={setNarrative}
                        isDisabled={!data.aiAvailable}
                    />
                    <div className="flex flex-wrap gap-3">
                        <Button size="md" color="secondary" onClick={() => void run("preview")} isLoading={busy === "preview"} showTextWhileLoading>
                            Preview
                        </Button>
                        <Button size="md" onClick={() => void run("save")} isLoading={busy === "save"} showTextWhileLoading>
                            Generate and save
                        </Button>
                    </div>
                </div>
            </Card>
            {preview && (
                <Card
                    title={`Preview: ${preview.title}`}
                    action={
                        <Button size="sm" onClick={() => void run("save")} isLoading={busy === "save"} showTextWhileLoading>
                            Save this report
                        </Button>
                    }
                >
                    <div className="px-4 py-5 sm:px-6">
                        <ReportView report={preview} />
                    </div>
                </Card>
            )}
            <Card title="Saved reports">
                {data.reports.length ? (
                    <ul className="divide-y divide-secondary">
                        {data.reports.map((r) => (
                            <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                                <div className="flex flex-wrap items-center gap-2">
                                    <a href={`${CENTRE}/reports/${r.id}`} className="text-sm font-semibold text-primary hover:underline">
                                        {r.title}
                                    </a>
                                    {r.trigger !== "manual" && (
                                        <Badge size="sm" type="color" color="gray">
                                            {r.trigger === "schedule" ? "Scheduled" : "Through MCP"}
                                        </Badge>
                                    )}
                                    {r.hasNarrative && (
                                        <Badge size="sm" type="color" color="purple">
                                            With AI narrative
                                        </Badge>
                                    )}
                                </div>
                                <p className="text-xs text-tertiary">
                                    {describeScope(r.scope, data.watches)} · {r.facts} facts · <When iso={r.generatedAt} label="Generated" />
                                </p>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No saved reports yet.</p>
                )}
            </Card>
            <Card
                title="Schedules"
                icon={CalendarDate}
                action={
                    <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setEditing("new")}>
                        Schedule a report
                    </Button>
                }
            >
                {!data.reportsOn && (
                    <div className="px-4 pt-4 sm:px-5">
                        <Notice
                            color="warning"
                            title="Scheduled reports are switched off"
                            actions={
                                <Button size="sm" color="link-color" href="/portal/settings/features#features-centre">
                                    Portal settings → Features
                                </Button>
                            }
                        >
                            Schedules can be set up now; they run once an owner or admin switches scheduled situation reports on. Reports on demand always work.
                        </Notice>
                    </div>
                )}
                {schedules.length ? (
                    <ul className="divide-y divide-secondary">
                        {schedules.map((s) => (
                            <li key={s.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                                <div className="flex min-w-0 flex-col gap-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-primary">{s.name}</span>
                                        {!s.enabled && (
                                            <Badge size="sm" type="color" color="gray">
                                                Paused
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-xs text-tertiary">
                                        {describeScope(s.scope, data.watches)} · {s.frequency === "weekly" ? `Weekly on ${WEEKDAYS[s.weekday ?? 1]}` : "Daily"}{" "}
                                        at {String(s.hour).padStart(2, "0")}:00 ({s.timeZone}) · last {s.periodHours} hours
                                    </p>
                                    <p className="flex flex-wrap gap-x-3 text-xs text-quaternary">
                                        {s.nextRunAt && <When iso={s.nextRunAt} label="Next" />}
                                        {s.lastRunAt && <When iso={s.lastRunAt} label="Last ran" />}
                                        {s.lastReportId && (
                                            <a href={`${CENTRE}/reports/${s.lastReportId}`} className="text-secondary hover:underline">
                                                Latest report
                                            </a>
                                        )}
                                    </p>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    <ButtonUtility size="sm" color="tertiary" icon={Edit05} tooltip={`Edit ${s.name}`} onClick={() => setEditing(s)} />
                                    <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip={`Delete ${s.name}`} onClick={() => setDeleting(s)} />
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No schedules yet.</p>
                )}
            </Card>
            {editing && (
                <ScheduleForm
                    data={data}
                    initial={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={(s) => {
                        setSchedules((list) => [...list.filter((x) => x.id !== s.id), s]);
                        setEditing(null);
                    }}
                />
            )}
            <ConfirmDialog
                isOpen={!!deleting}
                onOpenChange={(o) => !o && setDeleting(null)}
                title={`Delete ${deleting?.name ?? "this schedule"}?`}
                description="No more reports are made on this schedule. Reports already made stay."
                confirmLabel="Delete schedule"
                destructive
                onConfirm={async () => {
                    if (!deleting) return;
                    try {
                        await centreApi.deleteSchedule(deleting.id);
                        setSchedules((list) => list.filter((x) => x.id !== deleting.id));
                    } catch (e) {
                        toast.error("Couldn't delete it", errorMessage(e));
                    }
                }}
            />
        </>
    );
};
