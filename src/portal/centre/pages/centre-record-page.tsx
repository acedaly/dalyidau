// One record: what the provider published, in its words, with every time it carries, where it is
// (as precisely as published), what changed and when, measurements over time, possibly related
// records (derived, labelled) and the source's own details and health.
import { useState } from "react";
import { BellRinging01, BookOpen01, ClockRewind, Database01, Map01, MessageChatSquare, Route, Stars02 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import type { PageData } from "@/portal/lib/page-types";
import { centreApi } from "../centre-api";
import { CorrelationItem, KnowledgeSaveDialog, TimelineList } from "../history-ui";
import { CentreMap, type MapFeature } from "../map/centre-map";
import { RecordSummary } from "../record-summary";
import { SeriesChart } from "../series-chart";
import { CENTRE, CentreHeader, CentreNotices, ChangeRow, Freshness, SourceStatusBadge } from "../shared";

export const CentreRecordPage = ({ data }: { data: PageData<"centre-record"> }) => {
    const { record, source } = data;
    const point = record.lat !== null && record.lon !== null ? ([record.lon, record.lat] as [number, number]) : null;
    const features: MapFeature[] = [];
    const props = {
        id: record.id,
        layer: record.category === "fire" ? "fire" : record.category,
        kind: record.kind,
        title: record.title,
        level: record.warningLevel,
        rank: record.severityRank,
        nature: record.kind === "observation" || record.kind === "detection" ? ("observed" as const) : ("official" as const),
        at: record.updatedAt,
    };
    if (data.geometry && record.geometryQuality === "polygon")
        features.push({ type: "Feature", id: `${record.id}:area`, geometry: data.geometry as MapFeature["geometry"], properties: { ...props, area: 1 } });
    if (point) features.push({ type: "Feature", id: record.id, geometry: { type: "Point", coordinates: point }, properties: { ...props, area: 0 } });
    const frame: [number, number, number, number] | null = record.bbox
        ? [record.bbox[0] - 0.05, record.bbox[1] - 0.05, record.bbox[2] + 0.05, record.bbox[3] + 0.05]
        : point
          ? [point[0] - 0.2, point[1] - 0.15, point[0] + 0.2, point[1] + 0.15]
          : null;
    const metricLabel = (key: string) => record.metrics.find((m) => m.key === key);
    const [savingTimeline, setSavingTimeline] = useState(false);
    const official = record.kind !== "observation" && record.kind !== "detection";

    return (
        <>
            <CentreHeader
                title={record.title}
                crumb="Record"
                shell={data}
                description={record.areaName ?? undefined}
                actions={
                    <>
                        <Button size="md" color="secondary" iconLeading={MessageChatSquare} href={`${CENTRE}/assistant?record=${record.id}`}>
                            Ask the assistant
                        </Button>
                        {official && (
                            <Button size="md" color="secondary" iconLeading={BellRinging01} href={`${CENTRE}/rules`}>
                                Monitor this
                            </Button>
                        )}
                    </>
                }
            />
            <CentreNotices shell={data} sources={[source]} />
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Card title="As published">
                    <div className="px-4 py-4 sm:px-5">
                        <RecordSummary record={record} />
                    </div>
                </Card>
                <div className="flex min-w-0 flex-col gap-6">
                    {frame && features.length > 0 && (
                        <Card title="Location" icon={Map01}>
                            <div className="p-3">
                                <CentreMap
                                    features={features}
                                    layers={[props.layer as never, "fire", "warnings"]}
                                    frame={frame}
                                    selectedId={record.id}
                                    label={`Map showing ${record.title}`}
                                    className="h-80"
                                    fullscreen={false}
                                />
                            </div>
                        </Card>
                    )}
                    <Card title="Source" icon={Database01}>
                        <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-secondary">{source.source.provider}</span>
                                <SourceStatusBadge status={source.status} />
                            </div>
                            <p className="text-sm text-tertiary">{source.source.dataset}</p>
                            <Freshness health={source} />
                            <p className="text-xs text-tertiary">
                                Licence: {source.source.licence}. Provider's id: <span className="font-mono">{record.externalId}</span>
                            </p>
                        </div>
                    </Card>
                </div>
            </div>
            {data.series.map((s) => {
                const m = metricLabel(s.metric);
                return (
                    <Card key={s.metric} title={`${m?.label ?? s.metric} over time (observed)`}>
                        <div className="px-4 py-4 sm:px-5">
                            <SeriesChart
                                points={s.points}
                                label={m?.label ?? s.metric}
                                unit={m?.unit ?? ""}
                                caption={`${m?.label ?? s.metric} as measured by ${record.provider}, each point at its own observation time. No thresholds are drawn: none are published with this data.`}
                            />
                        </div>
                    </Card>
                );
            })}
            <Card
                title="Timeline"
                icon={Route}
                action={
                    <Button size="sm" color="secondary" iconLeading={BookOpen01} onClick={() => setSavingTimeline(true)}>
                        Save timeline to Knowledge
                    </Button>
                }
            >
                {data.timeline.startsAtBaseline && (
                    <p className="px-4 pt-3 text-xs text-tertiary sm:px-5">
                        History for this record begins when it was first recorded as it stood: earlier updates weren't kept as versions.
                    </p>
                )}
                <TimelineList events={data.timeline.events} emptyText="Nothing recorded for this record yet." />
                {data.timeline.notes.length > 0 && (
                    <ul className="flex flex-col gap-0.5 border-t border-secondary px-4 py-3 text-xs text-tertiary sm:px-5">
                        {data.timeline.notes.map((n) => (
                            <li key={n}>{n}</li>
                        ))}
                    </ul>
                )}
            </Card>
            <KnowledgeSaveDialog
                isOpen={savingTimeline}
                onOpenChange={setSavingTimeline}
                title="Save the timeline to Knowledge"
                description="A note listing every event with its nature, the provider's time and when it was collected."
                save={(target) => centreApi.timelineToKnowledge(record.id, target)}
            />
            <Card title="Changes" icon={ClockRewind}>
                {data.changes.length ? (
                    <ul className="divide-y divide-secondary">
                        {data.changes.map((c) => (
                            <ChangeRow key={c.id} change={c} />
                        ))}
                    </ul>
                ) : (
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No changes recorded since it was first collected.</p>
                )}
            </Card>
            {data.related.length > 0 && (
                <Card title="Possibly related records" icon={Stars02}>
                    <ul className="divide-y divide-secondary">
                        {data.related.map((c) => (
                            <CorrelationItem key={c.id} correlation={c} excludeId={record.id} />
                        ))}
                    </ul>
                </Card>
            )}
        </>
    );
};
