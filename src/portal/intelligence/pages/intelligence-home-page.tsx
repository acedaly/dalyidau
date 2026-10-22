// Intelligence overview: today's briefing at a glance and what AI has cost today. Everything links
// to the page that does the work.
import { ArrowRight, Sunrise, Zap } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Card } from "@/portal/components/card";
import { MetricCard } from "@/portal/components/metric-card";
import { PageHeader } from "@/portal/components/page-header";
import { formatNumber } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { AvailabilityNotice } from "../shared";

export const IntelligenceHomePage = ({ data }: { data: PageData<"intelligence-home"> }) => {
    const { usage, briefing } = data;
    const facts = briefing?.sections.filter((s) => s.count > 0) ?? [];

    return (
        <>
            <PageHeader
                title="Intelligence"
                description="The portal's AI layer: briefings from your calendar, and the AI behind Home & Assets and the Intelligence Centre. AI proposes, you approve."
                breadcrumbs={[{ label: "Intelligence" }]}
            />
            <AvailabilityNotice shell={data} need={["recommendations"]} />

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <MetricCard
                    label="AI used today"
                    value={`${formatNumber(Math.round(usage.today.neurons))}`}
                    icon={Zap}
                    detail={`Neurons of a ${formatNumber(usage.budgets.dailyNeurons)} daily budget · about US$${usage.today.estimatedUsd.toFixed(3)}`}
                    progress={usage.budgets.dailyNeurons ? (usage.today.neurons / usage.budgets.dailyNeurons) * 100 : 0}
                />
                <MetricCard
                    label="This month"
                    value={`${formatNumber(Math.round(usage.thisMonth.neurons))}`}
                    icon={Zap}
                    detail={`Neurons of a ${formatNumber(usage.budgets.monthlyNeurons)} monthly budget · about US$${usage.thisMonth.estimatedUsd.toFixed(3)}`}
                    progress={usage.budgets.monthlyNeurons ? (usage.thisMonth.neurons / usage.budgets.monthlyNeurons) * 100 : 0}
                />
            </div>

            <Card
                title="Today"
                icon={Sunrise}
                action={
                    <Button size="sm" color="link-color" iconTrailing={ArrowRight} href="/portal/intelligence/briefing">
                        Full briefing
                    </Button>
                }
            >
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
                    <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Nothing in your calendar needs attention today.</p>
                )}
            </Card>
        </>
    );
};
