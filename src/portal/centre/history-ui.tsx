// Pieces the 9.1 pages share: timeline events labelled by their nature (official, observed, derived
// or about the Centre's own collecting), correlations with their basis and the factors weighed, and
// client-side downloads.
import { LinkExternal01, Stars02 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import type { TimelineEvent, TimelineNature } from "@/shared/centre/history";
import type { Correlation } from "@/shared/centre/types";
import { cx } from "@/utils/cx";
import { NatureBadge, When, recordHref } from "./shared";

/** Official, observed, derived, or about collection (first seen, gaps): always labelled. */
export const NatureChip = ({ nature }: { nature: TimelineNature | "derived" }) =>
    nature === "collection" ? (
        <span className="inline-flex">
            <Badge size="sm" type="color" color="gray">
                Collection
            </Badge>
        </span>
    ) : (
        <NatureBadge nature={nature} />
    );

const EVENT_TONE: Partial<Record<TimelineEvent["kind"], string>> = {
    level_change: "bg-error-solid",
    area_change: "bg-warning-solid",
    ended: "bg-success-solid",
    source_gap: "bg-warning-solid",
    correlation: "bg-brand-solid",
};

/** A chronological list of timeline events, oldest first unless told otherwise. */
export const TimelineList = ({ events, newestFirst = false, emptyText }: { events: TimelineEvent[]; newestFirst?: boolean; emptyText: string }) => {
    const list = newestFirst ? [...events].reverse() : events;
    if (!list.length) return <p className="px-4 py-4 text-sm text-tertiary sm:px-5">{emptyText}</p>;
    return (
        <ol className="flex flex-col px-4 py-3 sm:px-5">
            {list.map((e, i) => (
                <li key={`${e.at}:${e.kind}:${i}`} className="relative flex gap-3 pb-4 last:pb-0">
                    <span aria-hidden="true" className="flex flex-col items-center">
                        <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", EVENT_TONE[e.kind] ?? "bg-quaternary")} />
                        {i < list.length - 1 && <span className="mt-1 w-px flex-1 bg-tertiary" />}
                    </span>
                    <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-primary">{e.label}</span>
                            <NatureChip nature={e.nature} />
                        </div>
                        <p className="text-sm text-tertiary">{e.detail}</p>
                        <p className="flex flex-wrap gap-x-3 text-xs text-quaternary">
                            <When iso={e.at} label={e.nature === "official" ? "Provider's time" : e.nature === "collection" ? "At" : "Time"} />
                            {e.collectedAt && e.collectedAt !== e.at && <When iso={e.collectedAt} label="Collected" />}
                            {e.recordId && (
                                <a href={recordHref(e.recordId)} className="text-secondary hover:underline">
                                    Record
                                </a>
                            )}
                            {e.sourceUrl && (
                                <a
                                    href={e.sourceUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="inline-flex items-center gap-1 text-secondary hover:underline"
                                >
                                    Official source <LinkExternal01 aria-hidden="true" className="size-3" />
                                </a>
                            )}
                        </p>
                    </div>
                </li>
            ))}
        </ol>
    );
};

/** One correlation: what links it (the provider, or the Centre's rule), the factors weighed, the evidence and limits. */
export const CorrelationItem = ({ correlation: c, excludeId }: { correlation: Correlation; excludeId?: string }) => (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
            {c.basis === "explicit" ? (
                <Badge size="sm" type="color" color="brand">
                    Linked by the provider
                </Badge>
            ) : (
                <Badge size="sm" type="color" color="purple">
                    <Stars02 aria-hidden="true" className="mr-1 size-3" />
                    Derived · may be related · {c.confidence} confidence
                </Badge>
            )}
            <span className="text-sm font-semibold text-primary">{c.title}</span>
        </div>
        <p className="text-sm text-tertiary">{c.explanation}</p>
        {c.factors?.length > 0 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                {c.factors.map((f) => (
                    <div key={`${f.factor}:${f.finding}`} className="contents">
                        <dt className="text-quaternary capitalize">{f.factor}</dt>
                        <dd className="text-tertiary">{f.finding}</dd>
                    </div>
                ))}
            </dl>
        )}
        <ul className="flex flex-col gap-0.5 text-sm">
            {c.records
                .filter((r) => r.recordId !== excludeId)
                .slice(0, 10)
                .map((r) => (
                    <li key={r.recordId}>
                        <a href={recordHref(r.recordId)} className="text-secondary hover:underline">
                            {r.title}
                        </a>
                        <span className="text-xs text-tertiary">
                            {" "}
                            · {r.provider}
                            {r.distanceKm !== null ? ` · ${r.distanceKm} km` : ""}
                            {r.at ? " · " : ""}
                        </span>
                        {r.at && <When iso={r.at} className="text-xs text-tertiary" />}
                        {r.sourceUrl && (
                            <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener" className="ml-1 text-xs text-tertiary hover:underline">
                                official source
                            </a>
                        )}
                    </li>
                ))}
        </ul>
        <p className="text-xs text-quaternary">
            Limitations: {c.limitations} {c.basis === "derived" ? "Correlation isn't causation, and it's not an official assessment." : ""}
        </p>
    </li>
);

/** Saves text the browser already has as a file (nothing is sent anywhere). */
export function downloadText(filename: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Hours as a short label: 6 h, 24 h, 3 days. */
export const hoursLabel = (h: number) => (h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);
