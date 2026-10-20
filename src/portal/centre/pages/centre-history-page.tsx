// Historical intelligence: detected changes over 24 hours, 7 or 30 days (as long as retention keeps
// them), activity per day, and each source's collection history (its reliability).
import { useMemo, useState } from "react";
import { ClockRewind } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { NativeSelect } from "@/components/base/select/select-native";
import { TrendChart } from "@/portal/components/charts";
import { DataTable } from "@/portal/components/data-table";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { formatNumber } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { IMPLEMENTED_SOURCES, sourceById } from "@/shared/centre/sources";
import { CHANGE_KIND_LABELS, type ChangeKind } from "@/shared/centre/types";
import { CENTRE, CentreHeader, CentreNotices, ChangeRow, When } from "../shared";

export const CentreHistoryPage = ({ data }: { data: PageData<"centre-history"> }) => {
    const [kind, setKind] = useState<ChangeKind | "">("");
    const changes = useMemo(() => (kind ? data.changes.filter((c) => c.kind === kind) : data.changes), [data.changes, kind]);
    const reliability = IMPLEMENTED_SOURCES.map((s) => {
        const runs = data.runs.filter((r) => r.sourceId === s.id);
        const ok = runs.filter((r) => r.outcome === "ok" || r.outcome === "unchanged").length;
        return {
            id: s.id,
            name: `${s.provider}: ${s.dataset}`,
            runs: runs.length,
            ok,
            last: runs[0]?.startedAt ?? null,
            lastError: runs.find((r) => r.outcome === "error")?.errorCode ?? null,
        };
    }).filter((r) => r.runs > 0);

    return (
        <>
            <CentreHeader
                title="History"
                crumb="History"
                shell={data}
                description="What changed, detected by comparing each collection with the one before. A record missing from a feed is shown as such, never as resolved."
            >
                <Tabs selectedKey={data.range} onSelectionChange={(k) => (window.location.href = `${CENTRE}/history?range=${String(k)}`)}>
                    <Tabs.List type="underline" size="sm">
                        <Tabs.Item id="24h">Last 24 hours</Tabs.Item>
                        <Tabs.Item id="7d">Seven days</Tabs.Item>
                        <Tabs.Item id="30d">30 days</Tabs.Item>
                    </Tabs.List>
                    <Tabs.Panel id="24h" aria-label="Last 24 hours" />
                    <Tabs.Panel id="7d" aria-label="Seven days" />
                    <Tabs.Panel id="30d" aria-label="30 days" />
                </Tabs>
            </CentreHeader>
            <CentreNotices shell={data} />
            {data.days.length > 1 && (
                <Card title="Changes per day (30 days)">
                    <div className="px-4 py-4 sm:px-5">
                        <TrendChart
                            points={data.days.map((d) => ({ date: d.date, value: d.count }))}
                            label="Changes"
                            caption="Changes detected per day (UTC dates)"
                        />
                    </div>
                </Card>
            )}
            <Card
                title={`${formatNumber(changes.length)} changes`}
                icon={ClockRewind}
                action={
                    <NativeSelect
                        aria-label="Kind of change"
                        size="sm"
                        value={kind}
                        onChange={(e) => setKind(e.target.value as ChangeKind | "")}
                        options={[
                            { label: "Every kind", value: "" },
                            ...(Object.keys(CHANGE_KIND_LABELS) as ChangeKind[]).map((k) => ({ label: CHANGE_KIND_LABELS[k], value: k })),
                        ]}
                    />
                }
            >
                {changes.length ? (
                    <ul className="divide-y divide-secondary">
                        {changes.slice(0, 300).map((c) => (
                            <ChangeRow key={c.id} change={c} />
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No changes in this period.</p>
                )}
            </Card>
            <DataTable
                title="Source reliability"
                description="Collection attempts kept for the retention period (Settings)."
                rows={reliability}
                columns={[
                    {
                        id: "name",
                        label: "Source",
                        isRowHeader: true,
                        render: (r) => <span className="font-medium text-primary">{r.name}</span>,
                        sortValue: (r) => r.name,
                    },
                    { id: "runs", label: "Attempts", render: (r) => formatNumber(r.runs), sortValue: (r) => r.runs },
                    { id: "ok", label: "Succeeded", render: (r) => `${Math.round((r.ok / r.runs) * 100)}%`, sortValue: (r) => r.ok / r.runs },
                    { id: "last", label: "Last attempt", render: (r) => <When iso={r.last} />, sortValue: (r) => r.last, className: "max-md:hidden" },
                    { id: "error", label: "Last error", render: (r) => r.lastError ?? "–", className: "max-md:hidden" },
                ]}
                emptyState={<p className="p-5 text-sm text-tertiary">No collections yet.</p>}
            />
            <p className="text-xs text-tertiary">{sourceById("rfs-incidents")?.attribution}</p>
        </>
    );
};
