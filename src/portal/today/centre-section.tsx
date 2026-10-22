// Today's Intelligence Centre section: a few lines, only for the person's own watch areas and from
// their chosen level (Intelligence Centre → Settings): significant developments, rule matches, the
// latest scheduled report, linked journeys and failing warning sources. Nothing shows when there's
// nothing relevant.
import type { ReactNode } from "react";
import { ArrowRight, Globe04 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { When } from "@/portal/centre/shared";
import { Card } from "@/portal/components/card";
import type { TodayCentre } from "@/shared/centre/types";

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-tertiary">{title}</h3>
        <ul className="flex flex-col divide-y divide-secondary">{children}</ul>
    </div>
);

const Line = ({ href, title, detail }: { href: string; title: string; detail?: ReactNode }) => (
    <li className="flex flex-col py-1.5 first:pt-0 last:pb-0">
        <a href={href} className="text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
            {title}
        </a>
        {detail && <span className="text-xs text-tertiary">{detail}</span>}
    </li>
);

export const CentreTodaySection = ({ centre }: { centre: TodayCentre }) => {
    const developments = centre.developments ?? [];
    const ruleMatches = centre.ruleMatches ?? [];
    const journeys = (centre.journeys ?? []).filter((j) => j.matches > 0);
    const failures = centre.sourceFailures ?? [];
    const report = centre.report ?? null;
    if (!centre.items.length && !centre.alerts && !developments.length && !ruleMatches.length && !journeys.length && !failures.length && !report) return null;
    return (
        <Card
            title="Conditions in your watch areas"
            icon={Globe04}
            action={
                <Button size="sm" color="link-color" iconTrailing={ArrowRight} href="/portal/intelligence-centre">
                    Intelligence Centre
                </Button>
            }
        >
            <div className="flex flex-col gap-3 px-4 py-3 sm:px-5">
                {centre.alerts > 0 && (
                    <a href="/portal/intelligence-centre/watches#alerts" className="text-sm font-medium text-brand-secondary hover:underline">
                        {centre.alerts} new {centre.alerts === 1 ? "alert" : "alerts"}
                    </a>
                )}
                {centre.items.length > 0 && (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {centre.items.map((i) => (
                            <Line key={i.id} href={i.url} title={i.title} detail={i.detail} />
                        ))}
                    </ul>
                )}
                {developments.length > 0 && (
                    <Group title="Changed in the last 24 hours">
                        {developments.map((d) => (
                            <Line
                                key={d.id}
                                href={d.url}
                                title={d.summary}
                                detail={
                                    <>
                                        {d.label} · <When iso={d.at} />
                                    </>
                                }
                            />
                        ))}
                    </Group>
                )}
                {ruleMatches.length > 0 && (
                    <Group title="Your monitoring rules">
                        {ruleMatches.map((m) => (
                            <Line key={m.id} href={m.url} title={m.rule} detail={m.reason} />
                        ))}
                    </Group>
                )}
                {journeys.length > 0 && (
                    <Group title="Coming up">
                        {journeys.map((j) => (
                            <Line
                                key={`${j.eventId}:${j.start}`}
                                href={j.url}
                                title={`${j.title}: ${j.matches} current ${j.matches === 1 ? "record concerns" : "records concern"} ${j.watchName}`}
                                detail={<When iso={j.start} />}
                            />
                        ))}
                    </Group>
                )}
                {report && (
                    <Group title="Latest scheduled report">
                        <Line href={report.url} title={report.title} detail={report.lines.join(" ")} />
                    </Group>
                )}
                {failures.length > 0 && (
                    <p className="text-xs text-warning-primary">
                        Not being retrieved: {failures.map((f) => `${f.label} (${f.detail})`).join("; ")} Warnings from it may be missing here.
                    </p>
                )}
                {centre.staleNote && <p className="text-xs text-warning-primary">{centre.staleNote}</p>}
                <p className="text-xs text-quaternary">Public information, not official warnings. Follow official warnings and directions.</p>
            </div>
        </Card>
    );
};
