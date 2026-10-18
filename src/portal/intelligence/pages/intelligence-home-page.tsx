// Intelligence overview: today's briefing at a glance, what's waiting for review, recent processing
// and what AI has cost today. Everything links to the page that does the work.
import { ArrowRight, Inbox01, Lightning01, Stars02, Sunrise, Zap } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { PageHeader } from "@/portal/components/page-header";
import { Timestamp } from "@/portal/components/timestamp";
import { formatNumber, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { useState } from "react";
import type { SuggestionView } from "@/shared/intelligence/types";
import { AvailabilityNotice, CaptureStatusBadge, SuggestionCard, captureHref } from "../shared";

export const IntelligenceHomePage = ({ data }: { data: PageData<"intelligence-home"> }) => {
    const [suggestions, setSuggestions] = useState<SuggestionView[]>(data.suggestions);
    const { usage, briefing } = data;
    const facts = briefing?.sections.filter((s) => s.count > 0) ?? [];

    return (
        <>
            <PageHeader
                title="Intelligence"
                description="AI proposes, you approve. Nothing is added to Tasks or Knowledge until you say so."
                breadcrumbs={[{ label: "Intelligence" }]}
                actions={
                    <Button size="md" iconLeading={Lightning01} href="/portal/intelligence/capture">
                        Capture
                    </Button>
                }
            />
            <AvailabilityNotice shell={data} need={["capture"]} />

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
                <MetricCard label="Waiting for review" value={formatNumber(data.pendingSuggestions)} icon={Inbox01} footer={<Button size="sm" color="link-color" href="/portal/intelligence/inbox" iconTrailing={ArrowRight}>Review</Button>} />
                <MetricCard
                    label="AI used today"
                    value={`${formatNumber(Math.round(usage.today.neurons))}`}
                    icon={Zap}
                    detail={`Neurons of a ${formatNumber(usage.budgets.dailyNeurons)} daily budget · about US$${usage.today.estimatedUsd.toFixed(3)}`}
                    progress={usage.budgets.dailyNeurons ? (usage.today.neurons / usage.budgets.dailyNeurons) * 100 : 0}
                />
                <MetricCard label="Semantic index" value={data.status.index ? formatNumber(data.status.index.indexed) : "Off"} icon={Stars02} detail={data.status.index ? `${pluralise(data.status.index.pending, "note")} waiting to be indexed` : "Keyword search is used"} />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-6">
                    <Card title="Today" icon={Sunrise} action={<Button size="sm" color="link-color" iconTrailing={ArrowRight} href="/portal/intelligence/briefing">Full briefing</Button>}>
                        {facts.length ? (
                            <ul className="divide-y divide-secondary">
                                {facts.slice(0, 6).map((s) => (
                                    <li key={s.key} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                                        <span className="text-sm font-medium text-secondary">{s.title}</span>
                                        <span className="text-sm text-tertiary tabular-nums">{s.count}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Nothing due and nothing overdue. Enjoy it.</p>
                        )}
                    </Card>
                    <Card title="Suggestions" icon={Inbox01} action={<Button size="sm" color="link-color" iconTrailing={ArrowRight} href="/portal/intelligence/inbox">All</Button>}>
                        {suggestions.length ? (
                            <ul className="divide-y divide-secondary">
                                {suggestions.map((s) => (
                                    <SuggestionCard key={s.id} suggestion={s} onChange={(next) => setSuggestions((list) => list.map((x) => (x.id === s.id && next ? next : x)))} />
                                ))}
                            </ul>
                        ) : (
                            <div className="px-6 py-10">
                                <Empty icon={Inbox01} size="sm" title="Nothing to review" description="Capture a note, a document or a recording and suggestions appear here." />
                            </div>
                        )}
                    </Card>
                </div>
                <Card title="Recent captures" icon={Lightning01}>
                    {data.captures.length ? (
                        <ul className="divide-y divide-secondary">
                            {data.captures.map((c) => (
                                <li key={c.id}>
                                    <a href={captureHref(c.id)} className="flex flex-col gap-1 px-4 py-3 transition duration-100 ease-linear hover:bg-primary_hover sm:px-5">
                                        <span className="truncate text-sm font-medium text-primary">{c.title}</span>
                                        <span className="flex flex-wrap items-center gap-2 text-xs text-tertiary">
                                            <CaptureStatusBadge status={c.status} job={c.job} />
                                            {c.pending > 0 && `${c.pending} to review · `}
                                            <Timestamp iso={c.createdAt} relative />
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Nothing captured yet.</p>
                    )}
                </Card>
            </div>
        </>
    );
};
