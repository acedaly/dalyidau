// One Wallboard 2.0 widget each (docs/INTELLIGENCE_CENTRE_9_1.md#widget-catalogue). Every widget is a
// labelled panel: its title, the area it covers, whether it's official, observed or derived, and
// its own times. A widget whose sources aren't active says why instead of showing an empty list,
// so a missing feed never reads as "nothing is happening".
import type { ReactNode } from "react";
import { AlertTriangle } from "@untitledui/icons";
import type { BasemapFlavor } from "@/portal/centre/map/basemap-style";
import { CentreMap, type MapFeature, MapLegend } from "@/portal/centre/map/centre-map";
import { FireDangerBadge, LevelBadge } from "@/portal/centre/shared";
import { CATEGORY_LABELS, type HazardCategory, SOURCE_STATUS_LABELS } from "@/shared/centre/sources";
import type { BasemapInfo, DisplayRecord, WidgetData, WidgetNature } from "@/shared/centre/wallboard";
import { cx } from "@/utils/cx";
import { ago, at, clock, dayLabel, shortTime } from "./display-format";

export interface WidgetContext {
    timeZone: string;
    /** The board's own area name: a widget names its area only when it's different. */
    areaLabel: string;
    now: number;
    hc: boolean;
    token: string | null;
    basemap: BasemapInfo | null;
    flavor: BasemapFlavor;
}

const NATURE_LABELS: Record<WidgetNature, string> = {
    official: "Official",
    observed: "Observed",
    derived: "Derived, not official",
    mixed: "Official and observed",
};

const NatureChip = ({ nature, hc }: { nature: WidgetNature; hc: boolean }) => (
    <span
        className={cx(
            "shrink-0 rounded-md px-1.5 py-px text-xs font-medium whitespace-nowrap",
            hc ? "ring-2 ring-primary" : "ring-1",
            !hc &&
                (nature === "official"
                    ? "text-brand-secondary ring-brand"
                    : nature === "observed"
                      ? "text-secondary ring-primary"
                      : "text-tertiary ring-secondary"),
            hc && "text-primary",
        )}
    >
        {NATURE_LABELS[nature]}
    </span>
);

export const Panel = ({ data, ctx, children, className }: { data: WidgetData; ctx: WidgetContext; children: ReactNode; className?: string }) => (
    <section
        aria-label={data.title}
        className={cx(
            "flex min-h-0 flex-col gap-1.5 overflow-hidden rounded-xl bg-secondary px-[0.7rem] py-[0.55rem]",
            ctx.hc ? "ring-2 ring-primary" : "ring-1 ring-secondary",
            className,
        )}
    >
        {/* One line: the title, the area only when it isn't the board's own, then what kind of information this is. */}
        <header className="flex items-center justify-between gap-2">
            <h2 className="flex min-w-0 items-baseline gap-2 text-[1.12rem] leading-tight font-semibold text-primary">
                <span className="truncate">{data.title}</span>
                {data.scopeLabel !== ctx.areaLabel && <span className="truncate text-sm font-normal text-tertiary">{data.scopeLabel}</span>}
                {data.stale.length > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-warning-primary">
                        <span aria-hidden="true" className="inline-block size-2 rounded-full bg-warning-solid" />
                        Some data out of date
                    </span>
                )}
            </h2>
            <NatureChip nature={data.nature} hc={ctx.hc} />
        </header>
        {data.unavailable.length > 0 && (
            <ul className="flex flex-col gap-1">
                {data.unavailable.slice(0, 2).map((u) => (
                    <li key={u.sourceId} className="flex items-start gap-1.5 text-sm text-warning-primary">
                        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                        {u.message}
                    </li>
                ))}
            </ul>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
);

const None = ({ children }: { children: ReactNode }) => <p className="text-base text-tertiary">{children}</p>;
const More = ({ shown, total }: { shown: number; total: number }) =>
    total > shown ? <p className="pt-1 text-sm text-tertiary">+{total - shown} more in the Intelligence Centre</p> : null;

const badgeRecord = (r: DisplayRecord) => ({ kind: r.kind, warningLevel: r.level, sourceId: r.sourceId, status: r.status });

const RecordItem = ({ r, ctx, tag }: { r: DisplayRecord; ctx: WidgetContext; tag?: ReactNode }) => (
    <li className="flex flex-col gap-0.5 border-b border-secondary py-1.5 last:border-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            <LevelBadge record={badgeRecord(r)} size="md" />
            {tag}
            <span className="line-clamp-2 text-[1.05rem] font-semibold text-primary">{r.title}</span>
        </div>
        <span className="truncate text-sm text-tertiary">
            {[r.status, r.areaName, r.provider].filter(Boolean).join(" · ")} · {r.observedAt ? "observed" : "updated"}{" "}
            {at(r.observedAt ?? r.updatedAt ?? r.publishedAt, ctx.timeZone)}
            {r.fixture ? " · fixture data, not live" : ""}
        </span>
    </li>
);

const Chip = ({ children, tone }: { children: ReactNode; tone: "error" | "brand" | "gray" }) => (
    <span
        className={cx(
            "rounded-md px-1.5 py-0.5 text-sm font-semibold whitespace-nowrap",
            tone === "error" ? "bg-error-solid text-white" : tone === "brand" ? "bg-brand-solid text-white" : "bg-tertiary text-secondary",
        )}
    >
        {children}
    </span>
);

const metric = (r: DisplayRecord, key: string) => {
    const m = r.metrics.find((x) => x.key === key);
    return m ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : "–";
};

// --- Charts (plain SVG: no chart library in the display bundle) -------------------------------------

const SERIES_STROKES = ["stroke-fg-brand-secondary", "stroke-fg-warning-secondary", "stroke-fg-success-secondary"];
const SERIES_SWATCHES = ["bg-fg-brand-secondary", "bg-fg-warning-secondary", "bg-fg-success-secondary"];

const LineChart = ({ data, ctx }: { data: Extract<WidgetData, { type: "observation_chart" | "rainfall_chart" | "river_gauge" }>; ctx: WidgetContext }) => {
    const series = data.series.filter((s) => s.points.length);
    if (!series.length) return <None>No readings are stored for this period.</None>;
    const all = series.flatMap((s) => s.points);
    const times = all.map((p) => Date.parse(p.at));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times, t0 + 1);
    const values = all.map((p) => p.value);
    // Rain can't be negative: its axis starts at zero.
    let v0 = data.metric === "rainfall" ? 0 : Math.min(...values);
    let v1 = Math.max(...values);
    if (v1 - v0 < 1e-6) {
        v0 -= 1;
        v1 += 1;
    }
    const W = 400;
    const H = 150;
    const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
    const y = (v: number) => H - ((v - v0) / (v1 - v0)) * H;
    const unit = data.unit ? ` ${data.unit}` : "";
    const summary = series
        .map(
            (s) =>
                `${s.label}: latest ${s.latest ?? s.points[s.points.length - 1].value}${unit} at ${shortTime(s.latestAt ?? s.points[s.points.length - 1].at, ctx.timeZone)}`,
        )
        .join("; ");
    return (
        <div className="flex h-full min-h-[8rem] flex-col gap-1">
            <div className="relative min-h-0 flex-1">
                <svg
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`Chart from ${at(new Date(t0).toISOString(), ctx.timeZone)}. ${summary}`}
                    className="size-full overflow-visible"
                >
                    <line x1="0" x2={W} y1={H} y2={H} className="stroke-fg-quaternary" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    {series.map((s, i) => (
                        <polyline
                            key={s.recordId}
                            fill="none"
                            className={SERIES_STROKES[i % SERIES_STROKES.length]}
                            strokeWidth={ctx.hc ? 4 : 3}
                            vectorEffect="non-scaling-stroke"
                            points={s.points.map((p) => `${x(Date.parse(p.at)).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")}
                        />
                    ))}
                </svg>
                <span className="absolute top-0 left-0 text-sm text-tertiary tabular-nums">
                    {Math.round(v1 * 10) / 10}
                    {unit}
                </span>
                <span className="absolute bottom-0 left-0 text-sm text-tertiary tabular-nums">
                    {Math.round(v0 * 10) / 10}
                    {unit}
                </span>
            </div>
            <ul className="flex flex-col gap-0.5" aria-hidden="true">
                {series.map((s, i) => (
                    <li key={s.recordId} className="flex items-center gap-2 text-sm text-secondary">
                        <span className={cx("inline-block h-1 w-4 shrink-0 rounded-full", SERIES_SWATCHES[i % SERIES_SWATCHES.length])} />
                        <span className="truncate">{s.label}</span>
                        <span className="ml-auto shrink-0 font-semibold text-primary tabular-nums">
                            {s.latest ?? "–"}
                            {unit}
                        </span>
                        <span className="shrink-0 text-tertiary">{shortTime(s.latestAt, ctx.timeZone)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
};

const TREND_SWATCHES: Partial<Record<HazardCategory, string>> = {
    fire: "bg-fg-error-secondary",
    transport: "bg-fg-brand-secondary",
    flood: "bg-fg-warning-secondary",
    weather: "bg-fg-warning-secondary",
    power: "bg-fg-success-secondary",
};
const swatch = (c: string) => TREND_SWATCHES[c as HazardCategory] ?? "bg-fg-quaternary";

const Trends = ({ data }: { data: Extract<WidgetData, { type: "trends" }> }) => {
    const totals = data.days.map((d) => Object.values(d.counts).reduce((n, v) => n + (v ?? 0), 0));
    const max = Math.max(1, ...totals);
    const categories = [...new Set(data.days.flatMap((d) => Object.keys(d.counts)))];
    if (!totals.some(Boolean)) return <None>No new official records were collected in this period. {data.note}</None>;
    return (
        <div className="flex h-full flex-col gap-2">
            <div
                className="flex min-h-[6rem] flex-1 items-end gap-1"
                role="img"
                aria-label={`New official records per day: ${data.days.map((d, i) => `${d.date} ${totals[i]}`).join(", ")}`}
            >
                {data.days.map((d, i) => (
                    <div key={d.date} className="flex h-full flex-1 flex-col justify-end">
                        <div className="flex flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${(totals[i] / max) * 100}%` }}>
                            {Object.entries(d.counts).map(([c, n]) => (
                                <div key={c} className={swatch(c)} style={{ flexGrow: n ?? 0 }} />
                            ))}
                        </div>
                        <span className="pt-0.5 text-center text-xs text-tertiary">{d.date.slice(8)}</span>
                    </div>
                ))}
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-secondary">
                {categories.map((c) => (
                    <li key={c} className="flex items-center gap-1.5">
                        <span aria-hidden="true" className={cx("inline-block size-3 rounded-sm", swatch(c))} />
                        {CATEGORY_LABELS[c as HazardCategory] ?? c}
                    </li>
                ))}
            </ul>
            <p className="text-sm text-tertiary">{data.note}</p>
        </div>
    );
};

// --- The widgets --------------------------------------------------------------------------------------

export const WidgetBody = ({ data, ctx }: { data: WidgetData; ctx: WidgetContext }) => {
    const tz = ctx.timeZone;
    switch (data.type) {
        case "map":
            return (
                <div className="relative h-full min-h-[40vh] lg:landscape:min-h-0">
                    <CentreMap
                        display
                        features={data.features as MapFeature[]}
                        layers={data.layers}
                        frame={data.frame}
                        watches={data.outline ? [{ id: "outline", name: data.scopeLabel, ring: data.outline }] : []}
                        label={`Map of ${data.scopeLabel}. The same records are listed in the other panels.`}
                        className="absolute inset-0"
                        basemap={ctx.basemap}
                        authToken={ctx.token}
                        flavor={ctx.flavor}
                    />
                    {data.legend && (
                        <div className="absolute bottom-2 left-2 max-h-[45%] max-w-[60%] overflow-hidden rounded-lg bg-primary/90 px-2 py-1.5 ring-1 ring-secondary">
                            <MapLegend className="gap-x-3 gap-y-0.5 sm:grid-cols-2 [&_li]:text-[0.7rem]" />
                        </div>
                    )}
                    {(data.unmapped > 0 || data.truncated) && (
                        <p className="absolute top-2 left-2 rounded-lg bg-primary px-2 py-1 text-sm text-secondary opacity-90">
                            {data.unmapped > 0
                                ? `${data.unmapped} ${data.unmapped === 1 ? "record has" : "records have"} no published shape and ${data.unmapped === 1 ? "is" : "are"} listed beside the map. `
                                : ""}
                            {data.truncated ? "Not every record fits on the map." : ""}
                        </p>
                    )}
                </div>
            );
        case "warnings":
        case "nearby_incidents":
        case "roads":
        case "outages":
        case "detections":
        case "air_quality":
            if (!data.records.length)
                return (
                    <None>
                        {data.unavailable.length
                            ? "Not available from the sources above."
                            : data.type === "detections"
                              ? "No satellite detections in this period."
                              : "Nothing current in the sources collected. That isn't confirmation: follow official channels."}
                    </None>
                );
            return (
                <div className="flex h-full flex-col">
                    {data.type === "outages" && data.customers !== null && (
                        <p className="text-base text-secondary">
                            <span className="font-semibold text-primary tabular-nums">{data.customers}</span> customers affected by {data.total} unplanned{" "}
                            {data.total === 1 ? "outage" : "outages"}
                        </p>
                    )}
                    {data.type === "detections" && (
                        <p className="text-base text-secondary">
                            <span className="font-semibold text-primary tabular-nums">{data.total}</span> thermal detections: heat signatures, not confirmed
                            fires.
                        </p>
                    )}
                    <ul className="min-h-0 flex-1 overflow-hidden">
                        {data.records.map((r) => (
                            <RecordItem
                                key={r.id}
                                r={r}
                                ctx={ctx}
                                tag={
                                    data.type === "roads" ? (
                                        <>
                                            {data.corridorIds.includes(r.id) && <Chip tone="brand">On your corridor</Chip>}
                                            {r.attributes.closure === "yes" && <Chip tone="error">Closure</Chip>}
                                        </>
                                    ) : data.type === "outages" ? (
                                        <Chip tone="gray">{metric(r, "customers")} customers</Chip>
                                    ) : data.type === "air_quality" && r.status ? (
                                        <Chip tone={r.rank >= 2 ? "error" : "gray"}>{r.status}</Chip>
                                    ) : null
                                }
                            />
                        ))}
                    </ul>
                    <More shown={data.records.length} total={data.total} />
                </div>
            );
        case "weather":
            if (!data.records.length) return <None>{data.unavailable.length ? "Not available from the sources above." : "No observations in this area."}</None>;
            return (
                <table className="w-full text-left text-base whitespace-nowrap">
                    <thead className="text-sm text-tertiary">
                        <tr>
                            <th scope="col" className="pb-1 font-medium">
                                Station
                            </th>
                            <th scope="col" className="pb-1 font-medium">
                                Temp
                            </th>
                            <th scope="col" className="pb-1 font-medium">
                                Wind (gust)
                            </th>
                            <th scope="col" className="pb-1 font-medium">
                                Rain
                            </th>
                            <th scope="col" className="pb-1 font-medium">
                                Observed
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.records.map((s) => (
                            <tr key={s.id} className="border-t border-secondary">
                                <td className="max-w-[12rem] truncate py-1 pr-2 text-primary">{s.title}</td>
                                <td className="py-1 pr-2 font-semibold text-primary tabular-nums">{metric(s, "air_temperature")}</td>
                                <td className="py-1 pr-2 text-secondary tabular-nums">
                                    {metric(s, "wind_spd_kmh")}
                                    {s.metrics.some((m) => m.key === "gust_kmh") ? ` (${metric(s, "gust_kmh")})` : ""}
                                </td>
                                <td className="py-1 pr-2 text-secondary tabular-nums">{metric(s, "rainfall")}</td>
                                <td className="py-1 text-tertiary">{shortTime(s.observedAt, tz)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            );
        case "fire_danger":
        case "fire_bans": {
            const rows = data.districts;
            if (!rows.length)
                return (
                    <None>
                        {data.unavailable.length
                            ? "Not available from the sources above."
                            : data.type === "fire_bans"
                              ? "No Total Fire Ban is listed for today or tomorrow."
                              : "Fire danger isn't being collected."}
                    </None>
                );
            return (
                <div className="flex h-full flex-col gap-1">
                    <ul className="grid min-h-0 flex-1 grid-cols-1 content-start gap-y-1 overflow-hidden">
                        {rows.map((d) => (
                            <li key={d.district} className="flex items-center justify-between gap-2 text-base">
                                <span className="min-w-0 truncate text-primary">{d.district}</span>
                                <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                                    {data.type === "fire_danger" && <FireDangerBadge rating={d.today} size="lg" />}
                                    {d.banToday && <Chip tone="error">Total Fire Ban today</Chip>}
                                    {d.banTomorrow && <Chip tone="gray">Ban tomorrow</Chip>}
                                    {data.type === "fire_danger" && <span className="text-sm text-tertiary">tomorrow {d.tomorrow}</span>}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="text-sm text-tertiary">NSW RFS, published {at(data.updatedAt, tz)}</p>
                </div>
            );
        }
        case "observation_chart":
        case "rainfall_chart":
        case "river_gauge":
            return <LineChart data={data} ctx={ctx} />;
        case "recent_changes":
            if (!data.changes.length) return <None>No changes recorded in this period.</None>;
            return (
                <div className="flex h-full flex-col">
                    <ul className="min-h-0 flex-1 overflow-hidden">
                        {data.changes.map((c) => (
                            <li key={c.id} className="flex flex-col border-b border-secondary py-1 last:border-0">
                                <span className={cx("text-sm", c.significant ? "font-semibold text-error-primary" : "text-tertiary")}>
                                    {c.label} · {shortTime(c.at, tz)}
                                </span>
                                <span className={cx("line-clamp-2 text-base", c.significant ? "font-medium text-primary" : "text-secondary")}>{c.summary}</span>
                            </li>
                        ))}
                    </ul>
                    <More shown={data.changes.length} total={data.total} />
                    <p className="text-sm text-tertiary">Detected by comparing collections. "No longer in the feed" never means resolved.</p>
                </div>
            );
        case "incident_timeline":
            if (!data.record) return <None>No current incident in this area to follow.</None>;
            return (
                <div className="flex h-full flex-col gap-1">
                    <p className="line-clamp-2 text-[1.05rem] font-semibold text-primary">
                        {data.record.title}
                        {data.record.level ? ` · ${data.record.level}` : ""}
                    </p>
                    <ol className="min-h-0 flex-1 overflow-hidden border-l-2 border-secondary pl-3">
                        {data.events.map((e, i) => (
                            <li key={`${e.at}-${i}`} className="flex flex-col py-1">
                                <span className="text-sm text-tertiary">
                                    {at(e.at, tz)} ·{" "}
                                    <span
                                        className={
                                            e.nature === "official"
                                                ? "text-brand-secondary"
                                                : e.nature === "derived"
                                                  ? "text-tertiary italic"
                                                  : "text-secondary"
                                        }
                                    >
                                        {e.nature === "derived"
                                            ? "Derived, not official"
                                            : e.nature === "collection"
                                              ? "Collection"
                                              : e.nature === "observed"
                                                ? "Observed"
                                                : "Official"}
                                    </span>
                                </span>
                                <span className="text-base font-medium text-primary">{e.label}</span>
                                <span className="line-clamp-2 text-sm text-secondary">{e.detail}</span>
                            </li>
                        ))}
                    </ol>
                </div>
            );
        case "correlations":
            if (!data.correlations.length) return <None>No possible relationships found by the Centre's rules.</None>;
            return (
                <ul className="flex h-full flex-col gap-2 overflow-hidden">
                    {data.correlations.map((c) => (
                        <li key={c.id} className="flex flex-col gap-0.5 border-b border-secondary pb-1.5 last:border-0">
                            <span className="flex flex-wrap items-center gap-2">
                                <Chip tone={c.basis === "explicit" ? "brand" : "gray"}>
                                    {c.basis === "explicit" ? "Linked by the provider" : `May be related · ${c.confidence} confidence`}
                                </Chip>
                            </span>
                            <span className="line-clamp-2 text-base font-semibold text-primary">{c.title}</span>
                            <span className="line-clamp-2 text-sm text-secondary">{c.explanation}</span>
                            <span className="line-clamp-1 text-sm text-tertiary">{c.limitations}</span>
                        </li>
                    ))}
                </ul>
            );
        case "trends":
            return <Trends data={data} />;
        case "summary":
            return (
                <div className="flex h-full flex-col gap-2">
                    <ul className="flex flex-wrap gap-1.5">
                        {data.counts.map((c) => (
                            <li key={c.label} className="flex items-baseline gap-1.5 rounded-md bg-primary px-2 py-0.5 ring-1 ring-secondary">
                                <span className="text-[1.25rem] leading-tight font-semibold text-primary tabular-nums">{c.value}</span>
                                <span className="text-sm whitespace-nowrap text-tertiary">{c.label}</span>
                            </li>
                        ))}
                    </ul>
                    <ul className="min-h-0 flex-1 overflow-hidden text-base text-secondary">
                        {data.lines.map((l) => (
                            <li key={l} className="truncate">
                                {l}
                            </li>
                        ))}
                    </ul>
                </div>
            );
        case "briefing":
            return (
                <div className="flex h-full flex-col gap-2 overflow-hidden">
                    <ul className="flex flex-col gap-1 text-base text-secondary">
                        {data.facts.map((f) => (
                            <li key={f.ref} className="line-clamp-2">
                                {f.text}
                            </li>
                        ))}
                    </ul>
                    {data.interpretation?.items.length ? (
                        <div className="rounded-lg p-2 ring-1 ring-secondary">
                            <p className="text-sm font-semibold text-tertiary">AI interpretation, not facts</p>
                            <ul className="text-base text-secondary">
                                {data.interpretation.items.map((i) => (
                                    <li key={i.text}>{i.text}</li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </div>
            );
        case "source_health":
        case "source_timestamps":
            if (!data.sources.length) return <None>No sources are switched on.</None>;
            return (
                <ul className="flex h-full flex-col overflow-hidden">
                    {data.sources.map((s) => {
                        const bad = s.status !== "active";
                        return (
                            <li key={s.id} className="flex items-baseline justify-between gap-2 border-b border-secondary py-1 text-sm last:border-0">
                                <span className={cx("min-w-0 truncate", bad ? "font-semibold text-warning-primary" : "text-secondary")}>
                                    {s.provider}: {s.dataset}
                                </span>
                                <span className={cx("shrink-0 tabular-nums", bad ? "text-warning-primary" : "text-tertiary")}>
                                    {data.type === "source_health"
                                        ? `${SOURCE_STATUS_LABELS[s.status]}${s.successRate24h !== null ? ` · ${s.successRate24h}% ok (24 h)` : ""}`
                                        : `retrieved ${ago(s.lastSuccessAt, ctx.now)}${s.lastPublishedAt ? ` · published ${shortTime(s.lastPublishedAt, tz)}` : ""}`}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            );
        case "clock": {
            const d = new Date(ctx.now);
            return (
                <div className="flex h-full flex-col items-center justify-center" aria-live="off">
                    <p className="text-[3.2rem] leading-none font-semibold text-primary tabular-nums">{clock(d, tz, data.showSeconds)}</p>
                    <p className="text-lg text-tertiary">{dayLabel(d, tz)}</p>
                </div>
            );
        }
    }
};

export const Widget = ({ data, ctx }: { data: WidgetData | undefined; ctx: WidgetContext }) => {
    if (!data)
        return (
            <section className={cx("flex items-center justify-center rounded-2xl bg-secondary p-3", ctx.hc ? "ring-2 ring-primary" : "ring-1 ring-secondary")}>
                <p className="text-base text-tertiary">This panel couldn't be prepared at the last refresh.</p>
            </section>
        );
    return (
        <Panel data={data} ctx={ctx} className="h-full">
            <WidgetBody data={data} ctx={ctx} />
        </Panel>
    );
};
