// Situation timelines: what changed in a watch area, a region or all of NSW over a period, newest
// first, with each event labelled by what it is and the periods when a source wasn't collected.
import { ClockRewind } from "@untitledui/icons";
import { NativeSelect } from "@/components/base/select/select-native";
import { Card } from "@/portal/components/card";
import type { PageData } from "@/portal/lib/page-types";
import { REGIONS } from "@/shared/centre/regions";
import { TimelineList, hoursLabel } from "../history-ui";
import { CENTRE, CentreHeader, CentreNotices } from "../shared";

const PERIODS = [6, 24, 72, 168, 720];

export const CentreTimelinePage = ({ data }: { data: PageData<"centre-timeline"> }) => {
    const { scope, timeline } = data;
    const go = (patch: Partial<typeof scope>) => {
        const next = { ...scope, ...patch };
        const q = new URLSearchParams();
        if (next.watch) q.set("watch", next.watch);
        else if (next.region) q.set("region", next.region);
        if (next.hours !== 24) q.set("hours", String(next.hours));
        window.location.href = `${CENTRE}/timeline${q.toString() ? `?${q}` : ""}`;
    };
    return (
        <>
            <CentreHeader
                title="Timelines"
                crumb="Timelines"
                shell={data}
                description="How a situation developed, from what the Centre collected: official changes, observed measurements, derived findings and collection gaps, each labelled."
            />
            <CentreNotices shell={data} />
            <Card title="Scope">
                <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-3 sm:px-5">
                    <NativeSelect
                        label="Watch area"
                        value={scope.watch ?? ""}
                        onChange={(e) => go({ watch: e.target.value || null, region: null })}
                        options={[{ label: "None", value: "" }, ...data.watches.map((w) => ({ label: w.name, value: w.id }))]}
                    />
                    <NativeSelect
                        label="Region"
                        value={scope.region ?? ""}
                        onChange={(e) => go({ region: e.target.value || null, watch: null })}
                        disabled={!!scope.watch}
                        options={[{ label: "All of NSW", value: "" }, ...REGIONS.filter((r) => r.id !== "nsw").map((r) => ({ label: r.label, value: r.id }))]}
                    />
                    <NativeSelect
                        label="Period"
                        value={String(scope.hours)}
                        onChange={(e) => go({ hours: Number(e.target.value) })}
                        options={PERIODS.map((h) => ({ label: `Last ${hoursLabel(h)}`, value: String(h) }))}
                    />
                </div>
            </Card>
            <Card title={`${timeline.scopeLabel}: ${timeline.events.length} events`} icon={ClockRewind}>
                <TimelineList events={timeline.events} emptyText="Nothing was recorded for this scope and period." />
                {timeline.truncated && (
                    <p className="border-t border-secondary px-4 py-3 text-xs text-tertiary sm:px-5">Only the newest 500 events are shown.</p>
                )}
            </Card>
            {timeline.notes.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs text-tertiary">
                    {timeline.notes.map((n) => (
                        <li key={n}>{n}</li>
                    ))}
                </ul>
            )}
        </>
    );
};
