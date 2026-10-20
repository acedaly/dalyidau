// Monitoring rules: your own deterministic conditions over what the Centre collects, with explicit
// units. Official conditions match a level or declaration exactly as published; your own thresholds
// (a gust speed, a river level) are labelled as yours, never as official. Rules can be tested
// against stored history before they're saved, and every match says why it matched.
import { useState } from "react";
import { BellRinging01, CheckDone01, Edit05, Plus, SearchRefraction, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Toggle } from "@/components/base/toggle/toggle";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { FormError } from "@/portal/components/form";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import type { MonitoringRule, RuleCondition, RuleDefinition, RuleInput, RuleMatch, RuleTestResult } from "@/shared/centre/rules";
import { CONDITION_META, RULE_CONDITIONS } from "@/shared/centre/rules";
import { CATEGORY_LABELS, HAZARD_CATEGORIES, type HazardCategory } from "@/shared/centre/sources";
import { WARNING_LEVELS } from "@/shared/centre/types";
import { centreApi } from "../centre-api";
import { CentreHeader, CentreNotices, When, recordHref } from "../shared";

type Data = PageData<"centre-rules">;

interface Draft {
    name: string;
    condition: RuleCondition;
    watchId: string;
    minLevel: number;
    radiusKm: string;
    categories: HazardCategory[];
    notUnderControlOnly: boolean;
    closuresOnly: boolean;
    station: string;
    direction: "above" | "below";
    threshold: string;
    gustUnit: "km/h" | "kn";
    district: string;
    when: "today" | "tomorrow" | "either";
    minMagnitude: string;
    sourceId: string;
    minutes: string;
    lookbackMinutes: string;
    cooldownMinutes: string;
    notify: RuleInput["notify"];
    enabled: boolean;
}

const blank = (data: Data): Draft => ({
    name: "",
    condition: "official_level",
    watchId: data.watches[0]?.id ?? "",
    minLevel: 3,
    radiusKm: "30",
    categories: [],
    notUnderControlOnly: false,
    closuresOnly: true,
    station: data.gauges[0]?.station ?? "",
    direction: "above",
    threshold: "",
    gustUnit: "km/h",
    district: data.districts[0] ?? "",
    when: "either",
    minMagnitude: "4",
    sourceId: "rfs-incidents",
    minutes: "",
    lookbackMinutes: "180",
    cooldownMinutes: "60",
    notify: "in_app",
    enabled: true,
});

function fromRule(rule: MonitoringRule, data: Data): Draft {
    const d = rule.definition;
    const draft: Draft = {
        ...blank(data),
        name: rule.name,
        condition: d.condition,
        lookbackMinutes: String(rule.lookbackMinutes),
        cooldownMinutes: String(rule.cooldownMinutes),
        notify: rule.notify,
        enabled: rule.enabled,
    };
    if ("watchId" in d) draft.watchId = d.watchId;
    switch (d.condition) {
        case "official_level":
            return { ...draft, minLevel: d.minLevel, radiusKm: String(d.radiusKm), categories: d.categories };
        case "fire_within":
            return { ...draft, radiusKm: String(d.radiusKm), notUnderControlOnly: d.notUnderControlOnly };
        case "road_on_corridor":
            return { ...draft, closuresOnly: d.closuresOnly };
        case "gauge_threshold":
            return { ...draft, station: d.station, direction: d.direction, threshold: String(d.threshold) };
        case "wind_gust":
            return { ...draft, threshold: String(d.threshold), gustUnit: d.unit };
        case "temperature":
            return { ...draft, direction: d.direction, threshold: String(d.threshold) };
        case "total_fire_ban":
            return { ...draft, district: d.district, when: d.when };
        case "earthquake":
            return { ...draft, minMagnitude: String(d.minMagnitude), radiusKm: String(d.radiusKm) };
        case "source_stale":
            return { ...draft, sourceId: d.sourceId, minutes: d.minutes === null ? "" : String(d.minutes) };
    }
}

function definitionOf(f: Draft): RuleDefinition {
    const n = (v: string) => Number(v);
    switch (f.condition) {
        case "official_level":
            return {
                condition: "official_level",
                watchId: f.watchId,
                minLevel: f.minLevel,
                radiusKm: n(f.radiusKm || "0"),
                unit: "km",
                categories: f.categories,
            };
        case "fire_within":
            return { condition: "fire_within", watchId: f.watchId, radiusKm: n(f.radiusKm), unit: "km", notUnderControlOnly: f.notUnderControlOnly };
        case "road_on_corridor":
            return { condition: "road_on_corridor", watchId: f.watchId, closuresOnly: f.closuresOnly };
        case "gauge_threshold":
            return { condition: "gauge_threshold", station: f.station.trim(), direction: f.direction, threshold: n(f.threshold), unit: "m" };
        case "wind_gust":
            return { condition: "wind_gust", watchId: f.watchId, threshold: n(f.threshold), unit: f.gustUnit };
        case "temperature":
            return { condition: "temperature", watchId: f.watchId, direction: f.direction, threshold: n(f.threshold), unit: "°C" };
        case "total_fire_ban":
            return { condition: "total_fire_ban", district: f.district, when: f.when };
        case "earthquake":
            return { condition: "earthquake", watchId: f.watchId, minMagnitude: n(f.minMagnitude), radiusKm: n(f.radiusKm), unit: "km" };
        case "source_stale":
            return { condition: "source_stale", sourceId: f.sourceId, minutes: f.minutes ? n(f.minutes) : null };
    }
}

const inputOf = (f: Draft): RuleInput => ({
    name: f.name.trim(),
    definition: definitionOf(f),
    lookbackMinutes: Number(f.lookbackMinutes),
    cooldownMinutes: Number(f.cooldownMinutes),
    notify: f.notify,
    enabled: f.enabled,
});

/** What the rule watches for, in a sentence, with official levels and the person's own thresholds told apart. */
export function describeRule(
    rule: Pick<MonitoringRule, "definition">,
    data: Pick<Data, "watches" | "sources">,
): { text: string; threshold: "official" | "own" | "operational" } {
    const d = rule.definition;
    const area = "watchId" in d ? (data.watches.find((w) => w.id === d.watchId)?.name ?? "a deleted watch area") : null;
    const meta = CONDITION_META[d.condition];
    switch (d.condition) {
        case "official_level":
            return {
                text: `${WARNING_LEVELS[d.minLevel - 1]} or above (official level, as published) ${d.radiusKm ? `within ${d.radiusKm} km of` : "in"} ${area}${d.categories.length ? `, ${d.categories.map((c) => CATEGORY_LABELS[c]).join(", ")}` : ""}`,
                threshold: meta.threshold,
            };
        case "fire_within":
            return {
                text: `A fire incident within ${d.radiusKm} km of ${area}${d.notUnderControlOnly ? " (not under control)" : ""}`,
                threshold: meta.threshold,
            };
        case "road_on_corridor":
            return { text: `A road ${d.closuresOnly ? "closure" : "closure or hazard"} on ${area}`, threshold: meta.threshold };
        case "gauge_threshold":
            return { text: `Gauge ${d.station} ${d.direction} ${d.threshold} m`, threshold: meta.threshold };
        case "wind_gust":
            return { text: `A gust of ${d.threshold} ${d.unit} or more at a station in ${area}`, threshold: meta.threshold };
        case "temperature":
            return { text: `${d.direction === "above" ? "At or above" : "At or below"} ${d.threshold} °C at a station in ${area}`, threshold: meta.threshold };
        case "total_fire_ban":
            return {
                text: `Total Fire Ban (as declared by the RFS) in ${d.district}, ${d.when === "either" ? "today or tomorrow" : d.when}`,
                threshold: meta.threshold,
            };
        case "earthquake":
            return { text: `Magnitude ${d.minMagnitude} or more within ${d.radiusKm} km of ${area}`, threshold: meta.threshold };
        case "source_stale":
            return {
                text: `${data.sources.find((s) => s.id === d.sourceId)?.label ?? d.sourceId} not retrieved for ${d.minutes ? `${d.minutes} minutes` : "longer than expected"}`,
                threshold: meta.threshold,
            };
    }
}

const ThresholdBadge = ({ kind }: { kind: "official" | "own" | "operational" }) =>
    kind === "official" ? (
        <Badge size="sm" type="color" color="brand">
            Official level or declaration
        </Badge>
    ) : kind === "own" ? (
        <Badge size="sm" type="color" color="warning">
            Your threshold, not official
        </Badge>
    ) : (
        <Badge size="sm" type="color" color="gray">
            Collection check
        </Badge>
    );

const RuleForm = ({
    data,
    initial,
    onClose,
    onSaved,
}: {
    data: Data;
    initial: MonitoringRule | null;
    onClose: () => void;
    onSaved: (r: MonitoringRule) => void;
}) => {
    const toast = useToast();
    const [f, setF] = useState<Draft>(() => (initial ? fromRule(initial, data) : blank(data)));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [test, setTest] = useState<RuleTestResult | null>(null);
    const [testing, setTesting] = useState(false);
    const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF((x) => ({ ...x, [k]: v }));
    const meta = CONDITION_META[f.condition];
    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const { rule } = initial
                ? await centreApi.updateRule(initial.id, { ...inputOf(f), version: initial.version })
                : await centreApi.createRule(inputOf(f));
            toast.success("Rule saved");
            onSaved(rule);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const runTest = async () => {
        setTesting(true);
        setError(null);
        try {
            setTest((await centreApi.testRule(inputOf(f), 7)).result);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setTesting(false);
        }
    };
    const watchSelect = meta.needsWatch && (
        <NativeSelect
            label="Watch area"
            value={f.watchId}
            onChange={(e) => set("watchId", e.target.value)}
            hint={f.condition === "road_on_corridor" ? "A road corridor works best" : "Rules use your watch areas; they never hold a location of their own"}
            options={data.watches.map((w) => ({ label: w.name, value: w.id }))}
        />
    );
    return (
        <PortalDialog
            isOpen
            onOpenChange={(o) => !o && onClose()}
            size="lg"
            title={initial ? "Edit monitoring rule" : "New monitoring rule"}
            icon={BellRinging01}
            onSubmit={() => void save()}
            footer={
                <>
                    <Button size="md" color="secondary" iconLeading={SearchRefraction} onClick={() => void runTest()} isLoading={testing} showTextWhileLoading>
                        Test against the last 7 days
                    </Button>
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
            <Input label="Name" value={f.name} onChange={(v) => set("name", v)} isRequired maxLength={80} placeholder="e.g. Emergency Warning near home" />
            <NativeSelect
                label="Condition"
                value={f.condition}
                onChange={(e) => (set("condition", e.target.value as RuleCondition), setTest(null))}
                options={RULE_CONDITIONS.map((c) => ({ label: CONDITION_META[c].label, value: c }))}
            />
            <p className="flex flex-wrap items-center gap-2 text-sm text-tertiary">
                <ThresholdBadge kind={meta.threshold} />
                {meta.description}
            </p>
            {meta.needsWatch && !data.watches.length && (
                <Notice title="Add a watch area first" color="warning">
                    This condition needs one of your watch areas.
                </Notice>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {watchSelect}
                {f.condition === "official_level" && (
                    <>
                        <NativeSelect
                            label="At or above (as published)"
                            value={String(f.minLevel)}
                            onChange={(e) => set("minLevel", Number(e.target.value))}
                            options={WARNING_LEVELS.map((l, i) => ({ label: l, value: String(i + 1) }))}
                        />
                        <Input
                            label="Also within (km of the area's edge)"
                            type="number"
                            value={f.radiusKm}
                            onChange={(v) => set("radiusKm", v)}
                            hint="0 to 100 km. 0: in the area only"
                        />
                    </>
                )}
                {(f.condition === "fire_within" || f.condition === "earthquake") && (
                    <Input
                        label="Within (km)"
                        type="number"
                        value={f.radiusKm}
                        onChange={(v) => set("radiusKm", v)}
                        hint={f.condition === "earthquake" ? "1 to 3000 km" : "1 to 100 km"}
                    />
                )}
                {f.condition === "earthquake" && (
                    <Input label="Magnitude at least" type="number" value={f.minMagnitude} onChange={(v) => set("minMagnitude", v)} hint="0 to 10" />
                )}
                {f.condition === "gauge_threshold" && (
                    <>
                        <NativeSelect
                            label="River gauge"
                            value={f.station}
                            onChange={(e) => set("station", e.target.value)}
                            options={
                                data.gauges.length
                                    ? data.gauges.map((g) => ({ label: `${g.name} (${g.station})`, value: g.station }))
                                    : [{ label: "No gauges followed (Settings)", value: "" }]
                            }
                        />
                        <NativeSelect
                            label="When the level is"
                            value={f.direction}
                            onChange={(e) => set("direction", e.target.value as Draft["direction"])}
                            options={[
                                { label: "At or above", value: "above" },
                                { label: "At or below", value: "below" },
                            ]}
                        />
                        <Input
                            label="Level (metres)"
                            type="number"
                            value={f.threshold}
                            onChange={(v) => set("threshold", v)}
                            hint="Your threshold in metres, not an official flood level"
                        />
                    </>
                )}
                {f.condition === "wind_gust" && (
                    <>
                        <Input
                            label="Gust at least"
                            type="number"
                            value={f.threshold}
                            onChange={(v) => set("threshold", v)}
                            hint="Your threshold, not an official warning threshold"
                        />
                        <NativeSelect
                            label="Unit"
                            value={f.gustUnit}
                            onChange={(e) => set("gustUnit", e.target.value as Draft["gustUnit"])}
                            options={[
                                { label: "km/h", value: "km/h" },
                                { label: "knots", value: "kn" },
                            ]}
                            hint="Bureau observations are in km/h; knots are converted"
                        />
                    </>
                )}
                {f.condition === "temperature" && (
                    <>
                        <NativeSelect
                            label="When the temperature is"
                            value={f.direction}
                            onChange={(e) => set("direction", e.target.value as Draft["direction"])}
                            options={[
                                { label: "At or above", value: "above" },
                                { label: "At or below", value: "below" },
                            ]}
                        />
                        <Input
                            label="Temperature (°C)"
                            type="number"
                            value={f.threshold}
                            onChange={(v) => set("threshold", v)}
                            hint="−20 to 55 °C. Your threshold"
                        />
                    </>
                )}
                {f.condition === "road_on_corridor" && <Checkbox label="Closures only" isSelected={f.closuresOnly} onChange={(v) => set("closuresOnly", v)} />}
                {f.condition === "fire_within" && (
                    <Checkbox label="Only fires not under control" isSelected={f.notUnderControlOnly} onChange={(v) => set("notUnderControlOnly", v)} />
                )}
                {f.condition === "total_fire_ban" && (
                    <>
                        <NativeSelect
                            label="Fire weather district"
                            value={f.district}
                            onChange={(e) => set("district", e.target.value)}
                            options={
                                data.districts.length
                                    ? data.districts.map((d) => ({ label: d, value: d }))
                                    : [{ label: "No districts collected yet", value: "" }]
                            }
                        />
                        <NativeSelect
                            label="For"
                            value={f.when}
                            onChange={(e) => set("when", e.target.value as Draft["when"])}
                            options={[
                                { label: "Today or tomorrow", value: "either" },
                                { label: "Today", value: "today" },
                                { label: "Tomorrow", value: "tomorrow" },
                            ]}
                        />
                    </>
                )}
                {f.condition === "source_stale" && (
                    <>
                        <NativeSelect
                            label="Source"
                            value={f.sourceId}
                            onChange={(e) => set("sourceId", e.target.value)}
                            options={data.sources.map((s) => ({ label: s.label, value: s.id }))}
                        />
                        <Input
                            label="Minutes without a retrieval"
                            type="number"
                            value={f.minutes}
                            onChange={(v) => set("minutes", v)}
                            hint="Empty: the source's own expected limit"
                        />
                    </>
                )}
            </div>
            {f.condition === "official_level" && (
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium text-secondary">Hazards (none ticked: every hazard)</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {HAZARD_CATEGORIES.filter((c) => ["fire", "weather", "flood", "emergency", "transport"].includes(c)).map((c) => (
                            <Checkbox
                                key={c}
                                label={CATEGORY_LABELS[c]}
                                isSelected={f.categories.includes(c)}
                                onChange={(on) => set("categories", on ? [...f.categories, c] : f.categories.filter((x) => x !== c))}
                            />
                        ))}
                    </div>
                </fieldset>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Input
                    label="Look back (minutes)"
                    type="number"
                    value={f.lookbackMinutes}
                    onChange={(v) => set("lookbackMinutes", v)}
                    hint="Only records or readings this recent count"
                />
                <Input
                    label="Cooldown (minutes)"
                    type="number"
                    value={f.cooldownMinutes}
                    onChange={(v) => set("cooldownMinutes", v)}
                    hint="Further matches stay quiet this long"
                />
                <NativeSelect
                    label="Notify"
                    value={f.notify}
                    onChange={(e) => set("notify", e.target.value as Draft["notify"])}
                    options={[
                        { label: "In the portal", value: "in_app" },
                        { label: "In the portal and by email", value: "email" },
                        { label: "Don't notify (record matches only)", value: "none" },
                    ]}
                />
            </div>
            <Toggle label="Enabled" isSelected={f.enabled} onChange={(v) => set("enabled", v)} />
            {test && (
                <div className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
                    <p className="text-sm font-semibold text-secondary">
                        {test.matches.length ? `Would have matched ${test.matches.length} ${test.matches.length === 1 ? "time" : "times"}` : "No matches"} in
                        the last 7 days ({test.examined} stored states and readings examined). Nothing was saved or sent.
                    </p>
                    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm text-tertiary">
                        {test.matches.map((m) => (
                            <li key={`${m.at}:${m.recordId}:${m.reason}`}>
                                <When iso={m.at} className="text-xs text-quaternary" /> · {m.reason}
                            </li>
                        ))}
                    </ul>
                    {test.notes.map((n) => (
                        <p key={n} className="text-xs text-quaternary">
                            {n}
                        </p>
                    ))}
                </div>
            )}
        </PortalDialog>
    );
};

const MatchRow = ({ match: m, onAcknowledge, onTask }: { match: RuleMatch; onAcknowledge: () => void; onTask: () => void }) => (
    <li id={m.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-primary">{m.ruleName}</span>
                {m.notified ? (
                    <Badge size="sm" type="color" color="brand">
                        Notified
                    </Badge>
                ) : (
                    <Badge size="sm" type="color" color="gray">
                        {m.suppressed === "cooldown" ? "Quiet (cooldown)" : m.suppressed === "rate_limit" ? "Quiet (hourly limit)" : "Recorded only"}
                    </Badge>
                )}
                {m.acknowledgedAt && (
                    <Badge size="sm" type="color" color="gray">
                        Acknowledged
                    </Badge>
                )}
            </div>
            <p className="text-sm text-tertiary">{m.reason}</p>
            <p className="flex flex-wrap gap-x-3 text-xs text-quaternary">
                <When iso={m.at} label="Matched" />
                {m.evidenceAt && <When iso={m.evidenceAt} label="Evidence time" />}
                {m.observedValue !== null && m.threshold !== null && (
                    <span>
                        Value {m.observedValue}
                        {m.unit ? ` ${m.unit}` : ""} against {m.threshold}
                        {m.unit ? ` ${m.unit}` : ""}
                    </span>
                )}
                {m.recordId && (
                    <a href={recordHref(m.recordId)} className="text-secondary hover:underline">
                        Record
                    </a>
                )}
                {m.taskId && (
                    <a href={`/portal/tasks/t/${m.taskId}`} className="text-secondary hover:underline">
                        Task
                    </a>
                )}
            </p>
        </div>
        <div className="flex shrink-0 gap-2">
            {!m.taskId && (
                <Button size="sm" color="secondary" iconLeading={CheckDone01} onClick={onTask}>
                    Create task
                </Button>
            )}
            {!m.acknowledgedAt && (
                <Button size="sm" color="link-gray" onClick={onAcknowledge}>
                    Acknowledge
                </Button>
            )}
        </div>
    </li>
);

export const CentreRulesPage = ({ data }: { data: Data }) => {
    const toast = useToast();
    const [rules, setRules] = useState<MonitoringRule[]>(data.rules);
    const [matches, setMatches] = useState<RuleMatch[]>(data.matches);
    const [editing, setEditing] = useState<MonitoringRule | "new" | null>(null);
    const [deleting, setDeleting] = useState<MonitoringRule | null>(null);
    const [tasking, setTasking] = useState<RuleMatch | null>(null);
    const reload = async () => {
        const r = await centreApi.rules();
        setRules(r.rules);
        setMatches(r.matches);
    };
    const acknowledge = (ids: string[] | "all") =>
        void centreApi
            .acknowledgeMatches(ids)
            .then(reload)
            .catch((e: unknown) => toast.error("Couldn't acknowledge", errorMessage(e)));

    return (
        <>
            <CentreHeader
                title="Monitoring rules"
                crumb="Monitoring rules"
                shell={data}
                description="Your own conditions, checked after each collection. Deterministic: no model decides whether a rule matches."
                actions={
                    <Button size="md" iconLeading={Plus} onClick={() => setEditing("new")}>
                        New rule
                    </Button>
                }
            />
            <CentreNotices shell={data} />
            {!data.rulesOn && (
                <Notice
                    color="warning"
                    title="Rule evaluation is switched off"
                    actions={
                        <Button size="sm" color="link-color" href="/portal/settings/features#features-centre">
                            Portal settings → Features
                        </Button>
                    }
                >
                    You can create rules and test them against history now; they're checked after each collection once an owner or admin switches monitoring
                    rules on.
                </Notice>
            )}
            {!data.emailOn && rules.some((r) => r.notify === "email") && (
                <Notice title="Alert emails are switched off">
                    Rules set to email notify in the portal only until Intelligence Centre alert emails are switched on.
                </Notice>
            )}
            {rules.length ? (
                <Card title={`${rules.length} ${rules.length === 1 ? "rule" : "rules"}`} icon={BellRinging01}>
                    <ul className="divide-y divide-secondary">
                        {rules.map((r) => {
                            const d = describeRule(r, data);
                            return (
                                <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-sm font-semibold text-primary">{r.name}</span>
                                            <ThresholdBadge kind={d.threshold} />
                                            {!r.enabled && (
                                                <Badge size="sm" type="color" color="gray">
                                                    Paused
                                                </Badge>
                                            )}
                                        </div>
                                        <p className="text-sm text-tertiary">{d.text}</p>
                                        <p className="flex flex-wrap gap-x-3 text-xs text-quaternary">
                                            <span>Looks back {r.lookbackMinutes} min</span>
                                            <span>Cooldown {r.cooldownMinutes} min</span>
                                            <span>{r.notify === "none" ? "Records matches only" : r.notify === "email" ? "Portal and email" : "Portal"}</span>
                                            <span>{r.matches7d} matches in 7 days</span>
                                            {r.lastEvaluatedAt && <When iso={r.lastEvaluatedAt} label="Checked" />}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 gap-1">
                                        <ButtonUtility size="sm" color="tertiary" icon={Edit05} tooltip={`Edit ${r.name}`} onClick={() => setEditing(r)} />
                                        <ButtonUtility size="sm" color="tertiary" icon={Trash01} tooltip={`Delete ${r.name}`} onClick={() => setDeleting(r)} />
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </Card>
            ) : (
                <Empty
                    icon={BellRinging01}
                    title="No monitoring rules yet"
                    description="For example: an Emergency Warning within 30 km of home, a river gauge above a level, or a road closure on your commute."
                    actions={
                        <Button size="md" iconLeading={Plus} onClick={() => setEditing("new")}>
                            New rule
                        </Button>
                    }
                />
            )}
            <Card
                title="Matches"
                action={
                    matches.some((m) => !m.acknowledgedAt) ? (
                        <Button size="sm" color="secondary" onClick={() => acknowledge("all")}>
                            Acknowledge all
                        </Button>
                    ) : undefined
                }
            >
                {matches.length ? (
                    <ul className="divide-y divide-secondary">
                        {matches.map((m) => (
                            <MatchRow key={m.id} match={m} onAcknowledge={() => acknowledge([m.id])} onTask={() => setTasking(m)} />
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No matches yet.</p>
                )}
            </Card>
            {editing && (
                <RuleForm
                    data={data}
                    initial={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={(r) => {
                        setRules((list) => [...list.filter((x) => x.id !== r.id), r].sort((a, b) => a.name.localeCompare(b.name)));
                        setEditing(null);
                    }}
                />
            )}
            <ConfirmDialog
                isOpen={!!deleting}
                onOpenChange={(o) => !o && setDeleting(null)}
                title={`Delete ${deleting?.name ?? "this rule"}?`}
                description="The rule and its recorded matches are removed. Alerts already sent stay in your alerts."
                confirmLabel="Delete rule"
                destructive
                onConfirm={async () => {
                    if (!deleting) return;
                    try {
                        await centreApi.deleteRule(deleting.id);
                        setRules((list) => list.filter((x) => x.id !== deleting.id));
                        setMatches((list) => list.filter((m) => m.ruleId !== deleting.id));
                    } catch (e) {
                        toast.error("Couldn't delete it", errorMessage(e));
                    }
                }}
            />
            <ConfirmDialog
                isOpen={!!tasking}
                onOpenChange={(o) => !o && setTasking(null)}
                title="Create a follow-up task?"
                description={`A task "Check: ${tasking?.ruleName ?? ""}" is added to your Daly Tasks inbox with this match's reason and a link to the record. Asking again returns the same task.`}
                confirmLabel="Create task"
                onConfirm={async () => {
                    if (!tasking) return;
                    try {
                        const r = await centreApi.taskFromMatch(tasking.id);
                        toast.success(r.replayed ? "That task already exists" : "Task created");
                        await reload();
                    } catch (e) {
                        toast.error("Couldn't create the task", errorMessage(e));
                    }
                }}
            />
        </>
    );
};
