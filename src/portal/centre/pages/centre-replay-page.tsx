// Historical replay: the records the Centre had stored at a chosen moment, as they were stored then
// (never filled in from later collections), on the map and in a list, with each source's state at
// that moment. A scrubber steps through the moments something was recorded, with collection gaps
// shaded; playback moves through them at a chosen speed. Two moments can be compared.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ClockRewind, PauseCircle, Play, SwitchHorizontal01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Slider } from "@/components/base/slider/slider";
import { Card } from "@/portal/components/card";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatDateTime } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import type { ReplayComparison, ReplayFrame, ReplayMeta, ReplayRecord } from "@/shared/centre/history";
import { REGIONS, regionById } from "@/shared/centre/regions";
import { MAP_LAYERS, MAP_LAYER_LABELS, type MapLayer, type WatchDefinition } from "@/shared/centre/types";
import { cx } from "@/utils/cx";
import { centreApi } from "../centre-api";
import { CentreMap, type MapFeature } from "../map/centre-map";
import { CentreHeader, CentreNotices, LevelBadge, TZ, recordHref } from "../shared";

const NSW: [number, number, number, number] = [140.9, -37.6, 153.7, -28.1];
const WINDOWS = [
    { hours: 24, label: "Last 24 hours" },
    { hours: 72, label: "Last 3 days" },
    { hours: 168, label: "Last 7 days" },
    { hours: 744, label: "Last 31 days" },
];
const SPEEDS = [1, 2, 5, 10];
const DEFAULT_LAYERS: MapLayer[] = ["fire", "warnings", "flood", "weather", "transport", "power", "emergency", "earthquake"];

/** "YYYY-MM-DDTHH:mm" in the browser's zone, for datetime-local inputs. */
const toLocal = (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (value: string) => {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function watchFrame(d: WatchDefinition): [number, number, number, number] | null {
    const pad = (b: [number, number, number, number], deg: number): [number, number, number, number] => [b[0] - deg, b[1] - deg, b[2] + deg, b[3] + deg];
    switch (d.kind) {
        case "point":
            return pad([d.lon, d.lat, d.lon, d.lat], Math.max(0.1, d.radiusKm / 90));
        case "polygon":
        case "corridor": {
            const pts = d.kind === "polygon" ? d.ring : d.line;
            return pad(
                [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
                0.1,
            );
        }
        case "region":
            return [d.west, d.south, d.east, d.north];
        default:
            return null;
    }
}

const STATE_BADGE: Record<ReplayFrame["sources"][number]["state"], { label: string; color: "success" | "warning" | "gray" | "error" }> = {
    current: { label: "Up to date then", color: "success" },
    stale: { label: "Out of date then", color: "warning" },
    not_collected: { label: "Not collected", color: "gray" },
    before_history: { label: "Before history", color: "gray" },
    unknown: { label: "Not replayed", color: "gray" },
};

const RecordLine = ({ r }: { r: ReplayRecord }) => (
    <li className="flex flex-col gap-1 px-4 py-2.5 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
            <LevelBadge record={{ kind: r.kind, warningLevel: r.warningLevel, sourceId: r.sourceId, status: r.status }} />
            <a href={recordHref(r.id)} className="text-sm font-semibold text-primary hover:underline">
                {r.title}
            </a>
            {r.baseline && (
                <Badge size="sm" type="color" color="gray">
                    Baseline
                </Badge>
            )}
            {!r.active && (
                <Badge size="sm" type="color" color="gray">
                    {r.missing ? "Not in feed then" : "Ended then"}
                </Badge>
            )}
        </div>
        <p className="text-xs text-tertiary">
            {[r.status, r.areaName, r.provider].filter(Boolean).join(" · ")} · stored {formatDateTime(r.validFrom, TZ)}
            {r.updatedAt ? ` · provider's update ${formatDateTime(r.updatedAt, TZ)}` : ""}
        </p>
    </li>
);

export const CentreReplayPage = ({ data }: { data: PageData<"centre-replay"> }) => {
    const toast = useToast();
    const [meta, setMeta] = useState<ReplayMeta>(data.meta);
    const [windowHours, setWindowHours] = useState(24);
    const [windowEnd, setWindowEnd] = useState(() => Date.now());
    const windowStart = windowEnd - windowHours * 3_600_000;
    const [at, setAt] = useState<string>(() => data.meta.steps.at(-1)?.at ?? new Date().toISOString());
    const [frame, setFrame] = useState<ReplayFrame | null>(null);
    const [loading, setLoading] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [layers, setLayers] = useState<MapLayer[]>(DEFAULT_LAYERS);
    const [watch, setWatch] = useState<string>("");
    const [region, setRegion] = useState<string>("");
    const [selected, setSelected] = useState<string | null>(null);
    const [compareA, setCompareA] = useState(() => toLocal(new Date(Date.now() - 86_400_000).toISOString()));
    const [compareB, setCompareB] = useState(() => toLocal(new Date().toISOString()));
    const [comparison, setComparison] = useState<ReplayComparison | null>(null);
    const latest = useRef(0);

    const scopeParams = useMemo(() => ({ watch: watch || null, region: watch ? null : region || null, layers: layers.join(",") }), [watch, region, layers]);

    const load = useCallback(
        async (moment: string) => {
            const request = ++latest.current;
            setLoading(true);
            try {
                const { frame: next } = await centreApi.replay({ at: moment, ...scopeParams });
                if (request === latest.current) setFrame(next);
            } catch (e) {
                if (request === latest.current) toast.error("Couldn't load that moment", errorMessage(e));
                setPlaying(false);
            } finally {
                if (request === latest.current) setLoading(false);
            }
        },
        [scopeParams, toast],
    );

    useEffect(() => {
        void load(at);
    }, [at, load]);

    const changeWindow = async (hours: number) => {
        const end = Date.now();
        setWindowHours(hours);
        setWindowEnd(end);
        try {
            const { meta: next } = await centreApi.replayMeta(new Date(end - hours * 3_600_000).toISOString(), new Date(end).toISOString());
            setMeta(next);
        } catch (e) {
            toast.error("Couldn't load the history", errorMessage(e));
        }
    };

    const steps = meta.steps.map((s) => s.at);
    const index = steps.findIndex((s) => s > at) - 1;
    const current = index < -1 ? steps.length - 1 : index;
    const stepTo = (i: number) => {
        if (i >= 0 && i < steps.length) setAt(steps[i]);
    };

    // Playback: the next recorded moment, once the current one has loaded.
    useEffect(() => {
        if (!playing || loading) return;
        const next = steps.findIndex((s) => s > at);
        if (next < 0) {
            setPlaying(false);
            return;
        }
        const timer = window.setTimeout(() => setAt(steps[next]), 1500 / speed);
        return () => window.clearTimeout(timer);
    }, [playing, loading, at, speed, steps]);

    const minutes = Math.round((windowEnd - windowStart) / 60_000);
    const offset = Math.min(minutes, Math.max(0, Math.round((Date.parse(at) - windowStart) / 60_000)));
    const pct = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - windowStart) / (windowEnd - windowStart)) * 100));
    const historyStart = meta.historyStartedAt;

    const watchArea = data.watches.find((w) => w.id === watch);
    const frameBox = (watchArea && watchFrame(watchArea.definition)) || (region ? regionById(region)?.bbox : null) || NSW;

    const compare = async () => {
        const a = fromLocal(compareA);
        const b = fromLocal(compareB);
        if (!a || !b) return;
        try {
            setComparison((await centreApi.replayCompare({ a, b, ...scopeParams })).comparison);
        } catch (e) {
            toast.error("Couldn't compare", errorMessage(e));
        }
    };

    return (
        <>
            <CentreHeader
                title="Replay"
                crumb="Replay"
                shell={data}
                description="What the Centre had stored at a past moment, exactly as it was stored then. Nothing collected later is used to fill in the past."
            />
            <CentreNotices shell={data} />
            {!meta.recording && (
                <Notice title="History recording is switched off" color="warning">
                    Replay can only show the periods that were recorded. An owner or admin can switch on Intelligence Centre history recording in Portal
                    settings → Features.
                </Notice>
            )}
            {!historyStart && <Notice title="No history recorded yet">Nothing has been versioned yet, so there's nothing to replay.</Notice>}

            <Card title="Moment" icon={ClockRewind}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <Input
                            label="Date and time"
                            type="datetime-local"
                            value={toLocal(at)}
                            onChange={(v) => {
                                const iso = fromLocal(v);
                                if (iso && Date.parse(iso) <= Date.now()) setAt(iso);
                            }}
                            hint={historyStart ? `History from ${formatDateTime(historyStart, TZ)}` : undefined}
                        />
                        <NativeSelect
                            label="Scrubber covers"
                            value={String(windowHours)}
                            onChange={(e) => void changeWindow(Number(e.target.value))}
                            options={WINDOWS.map((w) => ({ label: w.label, value: String(w.hours) }))}
                        />
                        <NativeSelect
                            label="Watch area"
                            value={watch}
                            onChange={(e) => setWatch(e.target.value)}
                            options={[{ label: "None (whole extent)", value: "" }, ...data.watches.map((w) => ({ label: w.name, value: w.id }))]}
                        />
                        <NativeSelect
                            label="Region"
                            value={region}
                            disabled={!!watch}
                            onChange={(e) => setRegion(e.target.value)}
                            options={[
                                { label: "All of NSW", value: "" },
                                ...REGIONS.filter((r) => r.id !== "nsw").map((r) => ({ label: r.label, value: r.id })),
                            ]}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <div className="relative h-3" aria-hidden="true">
                            {meta.gaps.map((g) => (
                                <span
                                    key={`${g.sourceId}:${g.from}`}
                                    title={`Collection gap: ${g.sourceId}`}
                                    className="absolute top-0 h-3 rounded-sm bg-warning-secondary"
                                    style={{ left: `${pct(g.from)}%`, width: `${Math.max(0.5, pct(g.to) - pct(g.from))}%` }}
                                />
                            ))}
                            {meta.steps.map((s) => (
                                <span key={s.at} className="absolute top-0.5 h-2 w-px bg-fg-quaternary" style={{ left: `${pct(s.at)}%` }} />
                            ))}
                            {historyStart && Date.parse(historyStart) > windowStart && (
                                <span className="absolute top-0 h-3 rounded-sm bg-tertiary" style={{ left: 0, width: `${pct(historyStart)}%` }} />
                            )}
                        </div>
                        <Slider
                            aria-label="Moment within the scrubber's period"
                            minValue={0}
                            maxValue={minutes}
                            value={offset}
                            onChange={(v) => {
                                setPlaying(false);
                                setAt(new Date(windowStart + (v as number) * 60_000).toISOString());
                            }}
                            labelFormatter={(v) => formatDateTime(new Date(windowStart + v * 60_000).toISOString(), TZ)}
                            labelPosition="top-floating"
                        />
                        <div className="flex justify-between text-xs text-quaternary">
                            <span>{formatDateTime(new Date(windowStart).toISOString(), TZ)}</span>
                            <span>{formatDateTime(new Date(windowEnd).toISOString(), TZ)}</span>
                        </div>
                        <p className="text-xs text-tertiary">
                            Ticks: moments something was recorded ({meta.steps.length}
                            {meta.truncated ? ", more than shown" : ""}). Shaded: no collection from a source for longer than expected.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" color="secondary" iconLeading={ChevronLeft} onClick={() => stepTo(current - 1)} isDisabled={current <= 0}>
                            Previous
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconLeading={playing ? PauseCircle : Play}
                            onClick={() => setPlaying((p) => !p)}
                            isDisabled={!steps.length}
                            aria-pressed={playing}
                        >
                            {playing ? "Pause" : "Play"}
                        </Button>
                        <Button
                            size="sm"
                            color="secondary"
                            iconTrailing={ChevronRight}
                            onClick={() => stepTo(current + 1)}
                            isDisabled={current >= steps.length - 1}
                        >
                            Next
                        </Button>
                        <NativeSelect
                            aria-label="Playback speed"
                            size="sm"
                            value={String(speed)}
                            onChange={(e) => setSpeed(Number(e.target.value))}
                            options={SPEEDS.map((s) => ({ label: `${s}×`, value: String(s) }))}
                        />
                        <p className="text-sm font-semibold text-primary" aria-live="polite">
                            {formatDateTime(at, TZ)} {loading && <span className="font-normal text-tertiary">(loading…)</span>}
                        </p>
                    </div>
                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 text-sm font-medium text-secondary">Layers</legend>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                            {MAP_LAYERS.filter((l) => l !== "watch" && l !== "hotspot" && l !== "water" && l !== "air").map((l) => (
                                <Checkbox
                                    key={l}
                                    label={MAP_LAYER_LABELS[l]}
                                    isSelected={layers.includes(l)}
                                    onChange={(on) => setLayers((list) => (on ? [...list, l] : list.filter((x) => x !== l)))}
                                />
                            ))}
                        </div>
                    </fieldset>
                </div>
            </Card>

            {frame?.notes.length ? (
                <Notice title="About this moment">
                    <ul className="flex list-disc flex-col gap-1 pl-4">
                        {frame.notes.map((n) => (
                            <li key={n}>{n}</li>
                        ))}
                    </ul>
                </Notice>
            ) : null}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <CentreMap
                    features={(frame?.map.features ?? []) as MapFeature[]}
                    layers={layers}
                    frame={frameBox}
                    selectedId={selected}
                    onSelect={setSelected}
                    label={`Map of the records stored at ${formatDateTime(at, TZ)}. They are listed beside the map.`}
                    className="min-h-120"
                />
                <Card title={`${frame?.records.length ?? 0} records stored then${frame?.truncated ? " (most serious shown)" : ""}`}>
                    {frame?.records.length ? (
                        <ul className={cx("max-h-120 divide-y divide-secondary overflow-y-auto")}>
                            {[...frame.records]
                                .sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || b.severityRank - a.severityRank)
                                .map((r) => (
                                    <RecordLine key={`${r.id}:${r.versionSeq}`} r={r} />
                                ))}
                        </ul>
                    ) : (
                        <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No official records were stored as current at this moment for this scope.</p>
                    )}
                </Card>
            </div>

            {frame && (
                <Card title="Sources at this moment">
                    <ul className="divide-y divide-secondary">
                        {frame.sources.map((s) => (
                            <li key={s.sourceId} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                                <span className="text-sm text-secondary">
                                    {s.provider}: {s.dataset}
                                </span>
                                <span className="flex flex-wrap items-center gap-2 text-xs text-tertiary">
                                    <Badge size="sm" type="pill-color" color={STATE_BADGE[s.state].color}>
                                        {STATE_BADGE[s.state].label}
                                    </Badge>
                                    {s.note}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}

            <Card title="Compare two moments" icon={SwitchHorizontal01}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-[1fr_1fr_auto]">
                        <Input label="First moment" type="datetime-local" value={compareA} onChange={setCompareA} />
                        <Input label="Second moment" type="datetime-local" value={compareB} onChange={setCompareB} />
                        <Button size="md" color="secondary" onClick={() => void compare()}>
                            Compare
                        </Button>
                    </div>
                    {comparison && (
                        <div className="flex flex-col gap-4">
                            <p className="text-sm text-secondary">
                                From {formatDateTime(comparison.a, TZ)} to {formatDateTime(comparison.b, TZ)}: {comparison.added.length} added,{" "}
                                {comparison.removed.length} no longer current, {comparison.changed.length} changed, {comparison.unchanged} unchanged.
                            </p>
                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                                {(
                                    [
                                        ["Added", comparison.added],
                                        ["No longer current", comparison.removed],
                                    ] as const
                                ).map(([title, list]) => (
                                    <div key={title} className="rounded-lg ring-1 ring-secondary">
                                        <h3 className="border-b border-secondary px-4 py-2 text-sm font-semibold text-secondary">{title}</h3>
                                        <ul className="max-h-80 divide-y divide-secondary overflow-y-auto">
                                            {list.slice(0, 50).map((r) => (
                                                <RecordLine key={`${title}:${r.id}`} r={r} />
                                            ))}
                                            {!list.length && <li className="px-4 py-2 text-sm text-tertiary">None</li>}
                                        </ul>
                                    </div>
                                ))}
                                <div className="rounded-lg ring-1 ring-secondary">
                                    <h3 className="border-b border-secondary px-4 py-2 text-sm font-semibold text-secondary">Changed</h3>
                                    <ul className="max-h-80 divide-y divide-secondary overflow-y-auto">
                                        {comparison.changed.slice(0, 50).map((c) => (
                                            <li key={c.after.id} className="flex flex-col gap-0.5 px-4 py-2">
                                                <a href={recordHref(c.after.id)} className="text-sm font-semibold text-primary hover:underline">
                                                    {c.after.title}
                                                </a>
                                                <span className="text-xs text-tertiary">
                                                    {c.fields.includes("warningLevel")
                                                        ? `Level ${c.before.warningLevel ?? "none"} → ${c.after.warningLevel ?? "none"}`
                                                        : `Changed: ${c.fields.join(", ")}`}
                                                    {c.fields.includes("status") ? ` · status ${c.before.status ?? "none"} → ${c.after.status ?? "none"}` : ""}
                                                </span>
                                            </li>
                                        ))}
                                        {!comparison.changed.length && <li className="px-4 py-2 text-sm text-tertiary">None</li>}
                                    </ul>
                                </div>
                            </div>
                            {comparison.notes.length > 0 && (
                                <ul className="flex flex-col gap-1 text-xs text-tertiary">
                                    {comparison.notes.map((n) => (
                                        <li key={n}>{n}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            </Card>
            <p className="text-xs text-tertiary">
                Versions are kept for {meta.retentionDays} days (Settings). Observations and satellite detections aren't replayed as records: see their charts
                and the record timelines.
            </p>
        </>
    );
};
