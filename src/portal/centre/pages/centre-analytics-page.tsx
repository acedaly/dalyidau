// Intelligence analytics: what the Centre collected over 7, 30 or 90 days, by day, category, region
// and event type, with measurement trends and each source's reliability. These are observed counts
// of what was collected, never complete statistics for NSW, and nothing here is a forecast or a risk
// score: the caveats say so first.
import { BarChartSquare02 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { TrendChart } from "@/portal/components/charts";
import { DataTable } from "@/portal/components/data-table";
import { Notice } from "@/portal/components/notice";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { formatNumber } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { SeriesChart } from "../series-chart";
import { CENTRE, CentreHeader, CentreNotices, When } from "../shared";

const fmt = (v: number | null, unit = "") => (v === null ? "–" : `${formatNumber(v)}${unit}`);

export const CentreAnalyticsPage = ({ data }: { data: PageData<"centre-analytics"> }) => {
    const a = data.analytics;
    return (
        <>
            <CentreHeader
                title="Analytics"
                crumb="Analytics"
                shell={data}
                description="Activity the Centre collected over time, with measurement trends and source reliability."
            >
                <Tabs selectedKey={String(data.days)} onSelectionChange={(k) => (window.location.href = `${CENTRE}/analytics?days=${String(k)}`)}>
                    <Tabs.List type="underline" size="sm">
                        <Tabs.Item id="7">7 days</Tabs.Item>
                        <Tabs.Item id="30">30 days</Tabs.Item>
                        <Tabs.Item id="90">90 days</Tabs.Item>
                    </Tabs.List>
                    <Tabs.Panel id="7" aria-label="7 days" />
                    <Tabs.Panel id="30" aria-label="30 days" />
                    <Tabs.Panel id="90" aria-label="90 days" />
                </Tabs>
            </CentreHeader>
            <CentreNotices shell={data} />
            <Notice title="Observed counts, not complete statistics" color="warning">
                <ul className="flex list-disc flex-col gap-1 pl-4">
                    {a.caveats.map((c) => (
                        <li key={c}>{c}</li>
                    ))}
                </ul>
                <p className="mt-2 text-xs">
                    Computed <When iso={a.computedAt} /> (reused for a few minutes). Dates are UTC days.
                </p>
            </Notice>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card title="Significant changes per day" icon={BarChartSquare02}>
                    <div className="px-4 py-4 sm:px-5">
                        <TrendChart points={a.significantChanges.points} label="Significant changes" caption="Significant changes detected per day" />
                    </div>
                </Card>
                {a.transitions.map((t) => (
                    <Card key={t.key} title={`Warning level ${t.key === "escalated" ? "escalations" : "downgrades"} per day`}>
                        <div className="px-4 py-4 sm:px-5">
                            <TrendChart points={t.points} label={t.label} caption={`${t.label} per day, as published by the providers`} />
                        </div>
                    </Card>
                ))}
                {a.newRecords.map((s) => (
                    <Card key={s.key} title={`New official records: ${s.label}`}>
                        <div className="px-4 py-4 sm:px-5">
                            <TrendChart points={s.points} label={s.label} caption={`New ${s.label.toLowerCase()} records collected per day`} />
                        </div>
                    </Card>
                ))}
                {a.weather.map((s) => (
                    <Card key={s.key} title={`${s.label}, highest reading per day (observed)`}>
                        <div className="px-4 py-4 sm:px-5">
                            <TrendChart points={s.points} label={s.label} caption={`${s.label}: the highest single reading collected each day`} />
                        </div>
                    </Card>
                ))}
                {a.rivers.map((r) => (
                    <Card key={r.recordId} title={`${r.label}: river level (observed)`}>
                        <div className="px-4 py-4 sm:px-5">
                            <SeriesChart points={r.points} label="River level" unit="m" caption={`${r.label}: river level readings from Water Data Online`} />
                        </div>
                    </Card>
                ))}
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <DataTable
                    title="By category"
                    description="Official records first collected in the period"
                    rows={a.byCategory.map((c) => ({ id: c.category, ...c }))}
                    columns={[
                        { id: "label", label: "Category", isRowHeader: true, render: (r) => r.label, sortValue: (r) => r.label },
                        { id: "count", label: "Collected", render: (r) => formatNumber(r.count), sortValue: (r) => r.count },
                    ]}
                    emptyState={<p className="p-5 text-sm text-tertiary">Nothing collected in this period.</p>}
                    size="sm"
                />
                <DataTable
                    title="By region"
                    description="Approximate regions; they overlap"
                    rows={a.byRegion.map((r) => ({ id: r.region, ...r }))}
                    columns={[
                        { id: "label", label: "Region", isRowHeader: true, render: (r) => r.label, sortValue: (r) => r.label },
                        { id: "count", label: "Collected", render: (r) => formatNumber(r.count), sortValue: (r) => r.count },
                    ]}
                    emptyState={<p className="p-5 text-sm text-tertiary">Nothing located in this period.</p>}
                    size="sm"
                />
                <DataTable
                    title="By event type"
                    description="As each provider names it"
                    rows={a.byEventType.map((e) => ({ id: e.eventType, ...e }))}
                    columns={[
                        { id: "type", label: "Event type", isRowHeader: true, render: (r) => r.eventType, sortValue: (r) => r.eventType },
                        { id: "count", label: "Collected", render: (r) => formatNumber(r.count), sortValue: (r) => r.count },
                    ]}
                    emptyState={<p className="p-5 text-sm text-tertiary">Nothing collected in this period.</p>}
                    size="sm"
                />
            </div>

            <DataTable
                title="Source reliability and coverage"
                description="Successful retrievals as a share of attempts, timing, and how many days of the period each source was collected"
                rows={a.sources.map((s) => ({ id: s.sourceId, ...s, coverage: a.coverage.find((c) => c.sourceId === s.sourceId) }))}
                columns={[
                    {
                        id: "name",
                        label: "Source",
                        isRowHeader: true,
                        render: (r) => <span className="font-medium text-primary">{`${r.provider}: ${r.dataset}`}</span>,
                        sortValue: (r) => r.provider,
                    },
                    { id: "availability", label: "Available", render: (r) => fmt(r.availability, "%"), sortValue: (r) => r.availability },
                    { id: "ms", label: "Avg retrieval", render: (r) => fmt(r.avgMs, " ms"), sortValue: (r) => r.avgMs, className: "max-md:hidden" },
                    {
                        id: "delay",
                        label: "Avg delay",
                        render: (r) => (r.avgDelayS === null ? "–" : `${Math.round(r.avgDelayS / 60)} min`),
                        sortValue: (r) => r.avgDelayS,
                        className: "max-md:hidden",
                    },
                    {
                        id: "coverage",
                        label: "Days collected",
                        render: (r) => (r.coverage ? `${r.coverage.daysCollected} of ${r.coverage.daysInRange}` : "–"),
                        sortValue: (r) => r.coverage?.daysCollected ?? 0,
                    },
                ]}
                emptyState={<p className="p-5 text-sm text-tertiary">No collections in this period.</p>}
            />
        </>
    );
};
