// What's changed: meaningful developments from every enabled source in one chronological feed,
// filtered by hazard, region, watch area, period, level, source and kind of change. Significant
// changes are shown apart from routine ones; each links to its record and the official source.
import { useState } from "react";
import { Lightning01, LinkExternal01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { formatNumber } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { FEED_CHANGE_GROUPS, type FeedChange } from "@/shared/centre/history";
import { REGIONS } from "@/shared/centre/regions";
import { CATEGORY_LABELS, HAZARD_CATEGORIES } from "@/shared/centre/sources";
import { WARNING_LEVELS } from "@/shared/centre/types";
import { cx } from "@/utils/cx";
import { CENTRE, CentreHeader, CentreNotices, When, recordHref } from "../shared";

const localDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const ChangeItem = ({ change: c }: { change: FeedChange }) => (
    <li className={cx("flex flex-col gap-1 px-4 py-3 sm:px-5", !c.significant && "opacity-80")}>
        <div className="flex flex-wrap items-center gap-2">
            <Badge
                size="sm"
                type="color"
                color={
                    c.kind === "escalated" || c.kind === "ban_declared" ? "error" : c.kind.startsWith("source") ? "warning" : c.significant ? "brand" : "gray"
                }
            >
                {c.label}
            </Badge>
            {c.significant ? (
                <span className="text-xs font-semibold text-brand-secondary">Significant</span>
            ) : (
                <span className="text-xs text-quaternary">Routine</span>
            )}
            {c.level && (
                <Badge size="sm" type="pill-color" color="gray">
                    Now: {c.level}
                </Badge>
            )}
        </div>
        {c.recordId ? (
            <a href={recordHref(c.recordId)} className="text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                {c.summary}
            </a>
        ) : (
            <span className="text-sm font-medium text-primary">{c.summary}</span>
        )}
        <p className="flex flex-wrap gap-x-3 text-xs text-quaternary">
            <span>{c.provider}</span>
            {c.areaName && <span>{c.areaName}</span>}
            {c.category && <span>{CATEGORY_LABELS[c.category]}</span>}
            <When iso={c.at} label="Detected" />
            {(c.fromValue || c.toValue) && (
                <span>
                    {c.fromValue ?? "–"} → {c.toValue ?? "–"}
                </span>
            )}
            {c.sourceUrl && (
                <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-secondary hover:underline">
                    Official source <LinkExternal01 aria-hidden="true" className="size-3" />
                </a>
            )}
        </p>
    </li>
);

export const CentreChangesPage = ({ data }: { data: PageData<"centre-changes"> }) => {
    const f = data.filters;
    const [from, setFrom] = useState(localDate(f.from));
    const [to, setTo] = useState(localDate(f.to));
    const go = (patch: Record<string, string | number | null>) => {
        const q = new URLSearchParams();
        const next = { ...f, ...patch } as Record<string, string | number | null>;
        for (const [k, v] of Object.entries(next)) if (v !== null && v !== "" && v !== 0 && !(k === "significance" && v === "significant")) q.set(k, String(v));
        window.location.href = `${CENTRE}/changes${q.toString() ? `?${q}` : ""}`;
    };
    const applyDates = () => {
        const a = new Date(`${from}T00:00`);
        const b = new Date(`${to}T23:59:59`);
        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return;
        go({ from: a.toISOString(), to: (b.getTime() > Date.now() ? new Date() : b).toISOString() });
    };
    const groupLabel = (id: string | null) => FEED_CHANGE_GROUPS.find((g) => g.id === id)?.label;

    return (
        <>
            <CentreHeader
                title="What's changed"
                crumb="What's changed"
                shell={data}
                description="Meaningful developments across every enabled source, detected by comparing each collection with the one before. Routine updates are kept apart, and a record missing from a feed is never shown as resolved."
            />
            <CentreNotices shell={data} sources={data.sources} />
            <Card title="Filters">
                <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
                    <NativeSelect
                        label="Hazard"
                        value={f.hazard ?? ""}
                        onChange={(e) => go({ hazard: e.target.value || null })}
                        options={[{ label: "Every hazard", value: "" }, ...HAZARD_CATEGORIES.map((c) => ({ label: CATEGORY_LABELS[c], value: c }))]}
                    />
                    <NativeSelect
                        label="Region"
                        value={f.region ?? ""}
                        onChange={(e) => go({ region: e.target.value || null, watch: null })}
                        options={[{ label: "All of NSW", value: "" }, ...REGIONS.filter((r) => r.id !== "nsw").map((r) => ({ label: r.label, value: r.id }))]}
                    />
                    <NativeSelect
                        label="Watch area"
                        value={f.watch ?? ""}
                        onChange={(e) => go({ watch: e.target.value || null, region: null })}
                        options={[{ label: "Any area", value: "" }, ...data.watches.map((w) => ({ label: w.name, value: w.id }))]}
                    />
                    <NativeSelect
                        label="Warning level (as published)"
                        value={String(f.minLevel)}
                        onChange={(e) => go({ minLevel: Number(e.target.value) })}
                        options={[{ label: "Any level", value: "0" }, ...WARNING_LEVELS.map((l, i) => ({ label: `${l} and above`, value: String(i + 1) }))]}
                    />
                    <NativeSelect
                        label="Source"
                        value={f.source ?? ""}
                        onChange={(e) => go({ source: e.target.value || null })}
                        options={[
                            { label: "Every source", value: "" },
                            ...data.sources
                                .filter((s) => s.source.implemented)
                                .map((s) => ({ label: `${s.source.provider}: ${s.source.dataset}`, value: s.source.id })),
                        ]}
                    />
                    <NativeSelect
                        label="Kind of change"
                        value={f.group ?? ""}
                        onChange={(e) => go({ group: e.target.value || null })}
                        options={[{ label: "Every kind", value: "" }, ...FEED_CHANGE_GROUPS.map((g) => ({ label: g.label, value: g.id }))]}
                    />
                    <Input label="From" type="date" value={from} onChange={setFrom} />
                    <Input label="To" type="date" value={to} onChange={setTo} />
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t border-secondary px-4 py-3 sm:px-5">
                    <Button size="sm" color="secondary" onClick={applyDates}>
                        Apply dates
                    </Button>
                    <Button size="sm" color="link-gray" href={`${CENTRE}/changes`}>
                        Clear filters
                    </Button>
                    <span className="text-xs text-tertiary">Up to 31 days at a time; changes are kept for the retention period in Settings.</span>
                </div>
            </Card>
            <Card
                title={`${formatNumber(data.counts.significant)} significant · ${formatNumber(data.counts.routine)} routine`}
                icon={Lightning01}
                action={
                    <NativeSelect
                        aria-label="Show"
                        size="sm"
                        value={f.significance}
                        onChange={(e) => go({ significance: e.target.value })}
                        options={[
                            { label: "Significant only", value: "significant" },
                            { label: "Significant and routine", value: "all" },
                        ]}
                    />
                }
            >
                {groupLabel(f.group) && <p className="px-4 pt-3 text-xs text-tertiary sm:px-5">Showing: {groupLabel(f.group)}</p>}
                {data.changes.length ? (
                    <ul className="divide-y divide-secondary">
                        {data.changes.map((c) => (
                            <ChangeItem key={c.id} change={c} />
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">
                        No changes match these filters in this period. That isn't confirmation nothing happened: check the sources' status and official
                        channels.
                    </p>
                )}
                {data.truncated && (
                    <p className="border-t border-secondary px-4 py-3 text-xs text-tertiary sm:px-5">
                        Only the newest 300 are shown. Narrow the filters to see more.
                    </p>
                )}
            </Card>
        </>
    );
};
