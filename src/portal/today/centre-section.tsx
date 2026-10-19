// Today's Intelligence Centre section: a few lines, only for the person's own watch areas and from
// their chosen level (Intelligence Centre → Settings). Nothing shows when there's nothing relevant.
import { ArrowRight, Globe04 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import type { TodayCentre } from "@/shared/centre/types";

export const CentreTodaySection = ({ centre }: { centre: TodayCentre }) => {
    if (!centre.items.length && !centre.alerts) return null;
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
            <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                {centre.alerts > 0 && (
                    <a href="/portal/intelligence-centre/watches#alerts" className="text-sm font-medium text-brand-secondary hover:underline">
                        {centre.alerts} new {centre.alerts === 1 ? "alert" : "alerts"}
                    </a>
                )}
                {centre.items.length > 0 && (
                    <ul className="flex flex-col divide-y divide-secondary">
                        {centre.items.map((i) => (
                            <li key={i.id} className="flex flex-col py-1.5 first:pt-0 last:pb-0">
                                <a href={i.url} className="text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                                    {i.title}
                                </a>
                                {i.detail && <span className="text-xs text-tertiary">{i.detail}</span>}
                            </li>
                        ))}
                    </ul>
                )}
                {centre.staleNote && <p className="text-xs text-warning-primary">{centre.staleNote}</p>}
                <p className="text-xs text-quaternary">Public information, not official warnings. Follow official warnings and directions.</p>
            </div>
        </Card>
    );
};
