// A household's communications history: campaigns sent or held back, invitations generated, online
// RSVPs and text replies, newest first. Built from records that already exist; tests aren't shown.
import { useEffect, useState } from "react";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Timestamp } from "@/portal/components/timestamp";
import { api, errorMessage } from "@/portal/lib/api";
import type { TimelineEntry } from "@/shared/portal/types";

const OUTCOME: Record<TimelineEntry["outcome"], { label: string; color: "success" | "gray" | "warning" | "error" | "brand" }> = {
    sent: { label: "Sent", color: "success" },
    prepared: { label: "Prepared", color: "gray" },
    held: { label: "Held back", color: "warning" },
    failed: { label: "Failed", color: "error" },
    received: { label: "Received", color: "brand" },
};

export const HouseholdTimeline = ({ householdId }: { householdId: string }) => {
    const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setEntries(null);
        setError(null);
        api<{ entries: TimelineEntry[] }>("GET", `/api/portal/wedding/households/${householdId}/timeline`)
            .then((r) => setEntries(r.entries))
            .catch((e) => setError(errorMessage(e)));
    }, [householdId]);

    return (
        <section aria-labelledby={`timeline-${householdId}`} className="flex flex-col gap-3 rounded-xl bg-secondary p-4">
            <h3 id={`timeline-${householdId}`} className="text-sm font-semibold text-secondary">
                Communications history
            </h3>
            {error && <p className="text-sm text-error-primary">{error}</p>}
            {!entries && !error && <p className="text-sm text-tertiary">Loading…</p>}
            {entries?.length === 0 && <p className="text-sm text-tertiary">Nothing has been prepared or sent to this household yet.</p>}
            {entries && entries.length > 0 && (
                <ol className="flex flex-col gap-3">
                    {entries.slice(0, 30).map((entry, index) => (
                        <li key={`${entry.at}-${index}`} className="flex flex-col gap-1 border-l-2 border-secondary pl-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-primary">{entry.title}</span>
                                <BadgeWithDot size="sm" color={OUTCOME[entry.outcome].color}>
                                    {OUTCOME[entry.outcome].label}
                                </BadgeWithDot>
                            </div>
                            <p className="text-sm text-tertiary">{entry.detail}</p>
                            <p className="flex items-center gap-2 text-xs text-quaternary">
                                <Timestamp iso={entry.at} />
                                {entry.href && (
                                    <Button size="sm" color="link-color" href={entry.href}>
                                        Open
                                    </Button>
                                )}
                            </p>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
};
