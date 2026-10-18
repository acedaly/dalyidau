// The Chief of Staff daily briefing and weekly review. Facts (records, with links) and AI
// recommendations (labelled as suggestions) are shown separately, and the page says what it never
// looked at, so a briefing can't be read as having checked email or a calendar.
import { useState } from "react";
import { ArrowUpRight, InfoCircle, Stars02 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import { formatDate } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import type { BriefingView } from "@/shared/intelligence/types";
import { intelligenceApi } from "../api";

const RECOMMENDATION_STATUS: Record<BriefingView["recommendations"]["status"], string> = {
    off: "AI recommendations are off. Facts are always shown.",
    not_requested: "Ask for suggested next actions based on these facts.",
    ready: "",
    unavailable: "Workers AI wasn't available, so there are no suggestions this time.",
    budget: "Today's AI budget is used up. Facts are still accurate.",
};

export const IntelligenceBriefingPage = ({ data }: { data: PageData<"intelligence-briefing"> }) => {
    const toast = useToast();
    const [briefing, setBriefing] = useState(data.briefing);
    const [busy, setBusy] = useState(false);
    const weekly = data.kind === "weekly";
    const recs = briefing.recommendations;

    const recommend = async () => {
        setBusy(true);
        try {
            setBriefing((await intelligenceApi.recommend(data.kind)).briefing);
        } catch (e) {
            toast.error("Couldn't get suggestions", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <PageHeader
                title={weekly ? "Weekly review" : "Daily briefing"}
                description={
                    weekly ? `The week ending ${formatDate(briefing.period)}.` : formatDate(briefing.period, { weekday: "long", day: "numeric", month: "long" })
                }
                breadcrumbs={[{ label: "Intelligence", href: "/portal/intelligence" }, { label: weekly ? "Weekly review" : "Daily briefing" }]}
            >
                <Tabs
                    selectedKey={data.kind}
                    onSelectionChange={(k) =>
                        (window.location.href = k === "weekly" ? "/portal/intelligence/briefing/weekly" : "/portal/intelligence/briefing")
                    }
                >
                    <Tabs.List type="underline" size="sm">
                        <Tabs.Item id="daily">Daily briefing</Tabs.Item>
                        <Tabs.Item id="weekly">Weekly review</Tabs.Item>
                    </Tabs.List>
                    <Tabs.Panel id="daily" aria-label="Daily briefing" />
                    <Tabs.Panel id="weekly" aria-label="Weekly review" />
                </Tabs>
            </PageHeader>

            <Notice title="What this is based on" color="gray">
                {[briefing.checked.tasks && "Daly Tasks", briefing.checked.knowledge && "Daly Knowledge"].filter(Boolean).join(" and ") || "Nothing"}, as you
                can see them. Not checked: {briefing.notChecked.join(", ")}.
                {briefing.changesSincePrevious &&
                    ` Since ${formatDate(briefing.changesSincePrevious.previousPeriod!)}: ${briefing.changesSincePrevious.added} new, ${briefing.changesSincePrevious.resolved} no longer listed.`}
            </Notice>

            <Card
                title="Suggested next actions"
                icon={Stars02}
                action={
                    <Badge size="sm" type="pill-color" color="brand">
                        AI suggestions, not facts
                    </Badge>
                }
            >
                {recs.status === "ready" && recs.items.length ? (
                    <ul className="divide-y divide-secondary">
                        {recs.items.map((r, i) => (
                            <li key={i} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                                <span className="text-sm text-primary">{r.text}</span>
                                <span className="flex flex-wrap gap-2">
                                    {r.refs.map((ref) => (
                                        <Button key={ref.id} size="sm" color="link-gray" iconTrailing={ArrowUpRight} href={ref.url}>
                                            {ref.title}
                                        </Button>
                                    ))}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                        <p className="text-sm text-tertiary">
                            {recs.status === "ready" ? "No suggestions: the facts speak for themselves." : RECOMMENDATION_STATUS[recs.status]}
                        </p>
                        {recs.status !== "off" && (
                            <Button size="sm" color="secondary" iconLeading={Stars02} isLoading={busy} onClick={recommend}>
                                Suggest next actions
                            </Button>
                        )}
                    </div>
                )}
                {recs.model && (
                    <p className="border-t border-secondary px-4 py-2 text-xs text-tertiary sm:px-5">Generated by {recs.model}. Check before acting.</p>
                )}
            </Card>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {briefing.sections.map((s) => (
                    <Card key={s.key} title={`${s.title}${s.count ? ` (${s.count})` : ""}`}>
                        {s.items.length ? (
                            <ul className="divide-y divide-secondary">
                                {s.items.map((item) => (
                                    <li key={item.id}>
                                        <a
                                            href={item.url}
                                            className="flex items-start justify-between gap-3 px-4 py-2.5 transition duration-100 ease-linear hover:bg-primary_hover sm:px-5"
                                        >
                                            <span className="min-w-0 text-sm font-medium break-words text-secondary">{item.title}</span>
                                            {item.detail && <span className="shrink-0 text-xs text-tertiary">{item.detail}</span>}
                                        </a>
                                    </li>
                                ))}
                                {s.count > s.items.length && <li className="px-4 py-2 text-xs text-tertiary sm:px-5">and {s.count - s.items.length} more</li>}
                            </ul>
                        ) : (
                            <p className="flex items-center gap-2 px-4 py-3 text-sm text-tertiary sm:px-5">
                                <InfoCircle aria-hidden="true" className="size-4 text-fg-quaternary" />
                                Nothing here.
                            </p>
                        )}
                    </Card>
                ))}
            </div>
        </>
    );
};
