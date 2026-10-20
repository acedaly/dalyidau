// Pieces every Intelligence Centre page shares: the standing notice that this isn't an official
// warning service, level badges in the conventional warning colours, the official / observed /
// derived labels, freshness, source status and attribution.
import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Bell01, Database01, Eye, Globe04, InfoCircle, Stars02 } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Notice } from "@/portal/components/notice";
import { PageHeader } from "@/portal/components/page-header";
import { useMounted } from "@/portal/hooks/use-mounted";
import { formatDateTime, formatRelative } from "@/portal/lib/format";
import { SOURCE_STATUS_LABELS, type SourceStatus, sourceById } from "@/shared/centre/sources";
import type { CentreChange, CentreRecord, CentreShell, SourceHealth } from "@/shared/centre/types";
import { CHANGE_KIND_LABELS, GEOMETRY_QUALITY_LABELS, RECORD_KIND_LABELS, recordNature } from "@/shared/centre/types";
import { cx } from "@/utils/cx";

export const CENTRE = "/portal/intelligence-centre";
export const recordHref = (id: string) => `${CENTRE}/records/${id}`;
export const TZ = "Australia/Sydney";

type BadgeColor = "gray" | "brand" | "error" | "warning" | "success" | "blue" | "indigo" | "orange" | "purple";

/** Australian Warning System colours: Advice yellow, Watch and Act orange, Emergency Warning red. */
const AWS_COLORS: Record<string, BadgeColor> = { advice: "warning", "watch and act": "orange", "emergency warning": "error" };
/** Fire Danger Rating colours, as the Australian Fire Danger Rating System uses them. */
const FDR_COLORS: Record<string, BadgeColor> = { "no rating": "gray", moderate: "success", high: "warning", extreme: "orange", catastrophic: "error" };

export const FireDangerBadge = ({ rating, size = "sm" }: { rating: string; size?: "sm" | "md" | "lg" }) => (
    <Badge size={size} type="pill-color" color={FDR_COLORS[rating.toLowerCase()] ?? "gray"}>
        {rating}
    </Badge>
);

/** The provider's own level, never one worked out here. */
export const LevelBadge = ({
    record,
    size = "sm",
}: {
    record: Pick<CentreRecord, "kind" | "warningLevel" | "sourceId" | "status">;
    size?: "sm" | "md" | "lg";
}) => {
    if (record.kind === "rating" && record.warningLevel) return <FireDangerBadge rating={record.warningLevel} size={size} />;
    const level = record.warningLevel?.toLowerCase() ?? "";
    if (AWS_COLORS[level])
        return (
            <BadgeWithDot size={size} type="pill-color" color={AWS_COLORS[level]}>
                {record.warningLevel}
            </BadgeWithDot>
        );
    if (record.kind === "warning")
        return (
            <Badge size={size} type="pill-color" color="blue">
                Warning{record.sourceId.startsWith("bom") ? " (BoM)" : ""}
            </Badge>
        );
    return null;
};

/** Official (an agency published it), observed (measured or detected) or derived (worked out here). */
export const NatureBadge = ({ nature }: { nature: "official" | "observed" | "derived" }) => {
    const { label, color, icon } = {
        official: { label: "Official", color: "brand" as const, icon: Globe04 },
        observed: { label: "Observed", color: "gray" as const, icon: Eye },
        derived: { label: "Derived, not official", color: "purple" as const, icon: Stars02 },
    }[nature];
    const Icon = icon;
    return (
        <span className="inline-flex">
            <Badge size="sm" type="color" color={color}>
                <Icon aria-hidden="true" className="mr-1 size-3" />
                {label}
            </Badge>
        </span>
    );
};
export const RecordNature = ({ record }: { record: Pick<CentreRecord, "kind"> }) => <NatureBadge nature={recordNature(record.kind)} />;

const SOURCE_STATUS_COLORS: Record<SourceStatus, BadgeColor> = {
    active: "success",
    awaiting_verification: "blue",
    needs_registration: "indigo",
    disabled: "gray",
    unavailable: "error",
    restricted: "gray",
    unsupported: "gray",
    stale: "warning",
    error: "error",
};
export const SourceStatusBadge = ({ status }: { status: SourceStatus }) => (
    <BadgeWithDot size="sm" type="pill-color" color={SOURCE_STATUS_COLORS[status]}>
        {SOURCE_STATUS_LABELS[status]}
    </BadgeWithDot>
);

/** A time, with "x ago" once the browser has it (the server and browser agree on the first render). */
export const When = ({ iso, label, className }: { iso: string | null | undefined; label?: string; className?: string }) => {
    const mounted = useMounted();
    if (!iso) return <span className={cx("text-tertiary", className)}>{label ? `${label}: ` : ""}not given</span>;
    return (
        <time dateTime={iso} title={formatDateTime(iso, TZ)} className={className}>
            {label ? `${label} ` : ""}
            {mounted ? formatRelative(iso, Date.now(), TZ) : formatDateTime(iso, TZ)}
        </time>
    );
};

/** Freshness of a source: when it was last retrieved, flagged when that's longer than it should be. */
export const Freshness = ({ health, className }: { health: Pick<SourceHealth, "lastSuccessAt" | "status" | "source"> | undefined; className?: string }) => {
    if (!health) return null;
    const stale = health.status === "stale" || health.status === "error";
    return (
        <span className={cx("inline-flex items-center gap-1 text-xs", stale ? "text-warning-primary" : "text-tertiary", className)}>
            {stale && <AlertTriangle aria-hidden="true" className="size-3.5" />}
            {health.lastSuccessAt ? <When iso={health.lastSuccessAt} label={stale ? "Last retrieved" : "Retrieved"} /> : "Not yet retrieved"}
        </span>
    );
};

export const Attribution = ({ sourceIds, className }: { sourceIds: string[]; className?: string }) => {
    const sources = [...new Set(sourceIds)].map((id) => sourceById(id)).filter((s) => !!s && s.attribution);
    if (!sources.length) return null;
    return (
        <div className={cx("flex flex-col gap-0.5 text-xs text-quaternary", className)}>
            {sources.map((s) => (
                <p key={s!.id}>{s!.attribution}</p>
            ))}
        </div>
    );
};

/** The standing notice, plus the states that change what the page can be trusted for. */
export const CentreNotices = ({ shell, sources }: { shell: CentreShell; sources?: SourceHealth[] }) => {
    const stale = (sources ?? []).filter((s) => s.enabled && (s.status === "stale" || s.status === "error"));
    return (
        <div className="flex flex-col gap-3">
            <p className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2 text-xs text-tertiary">
                <InfoCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-quaternary" />
                <span>
                    Public information collected for your own awareness. This isn't an official warning service and may be delayed or incomplete. Always follow
                    official warnings and directions (Hazards Near Me, Fires Near Me, the Bureau of Meteorology). In an emergency call Triple Zero (000).
                </span>
            </p>
            {shell.fixtureData && (
                <Notice color="warning" title="Recorded fixture data, not live">
                    Some records here came from recorded fixtures or a local stand-in (development or tests). They aren't current and mustn't be relied on.
                </Notice>
            )}
            {!shell.ingestionOn && (
                <Notice
                    title="Collection is switched off"
                    actions={
                        <Button size="sm" color="link-color" href="/portal/settings/features#features-centre" iconTrailing={ArrowRight}>
                            Portal settings → Features
                        </Button>
                    }
                >
                    Nothing is being fetched on a schedule. Records shown are from earlier collections, each with its own time. An owner or admin can switch
                    collection on.
                </Notice>
            )}
            {stale.length > 0 && (
                <Notice color="warning" title={`${stale.length} ${stale.length === 1 ? "source isn't" : "sources aren't"} up to date`}>
                    {stale.map((s) => `${s.source.provider}: ${s.source.dataset}`).join("; ")}. What's shown from {stale.length === 1 ? "it" : "them"} may be
                    out of date.
                </Notice>
            )}
        </div>
    );
};

export const CentreHeader = ({
    title,
    description,
    crumb,
    actions,
    shell,
    children,
}: {
    title: string;
    description?: ReactNode;
    crumb?: string;
    actions?: ReactNode;
    shell: CentreShell;
    children?: ReactNode;
}) => (
    <PageHeader
        title={title}
        description={description}
        breadcrumbs={[{ label: "Intelligence Centre", href: crumb ? CENTRE : undefined }, ...(crumb ? [{ label: crumb }] : [])]}
        actions={
            <>
                {shell.unacknowledgedAlerts > 0 && (
                    <Button size="md" color="secondary" iconLeading={Bell01} href={`${CENTRE}/watches#alerts`}>
                        {shell.unacknowledgedAlerts} {shell.unacknowledgedAlerts === 1 ? "alert" : "alerts"}
                    </Button>
                )}
                {actions}
            </>
        }
    >
        {children}
    </PageHeader>
);

/** One record, compact: level, title, where, and its own times. */
export const RecordRow = ({ record, reason, showSource = true }: { record: CentreRecord; reason?: string; showSource?: boolean }) => (
    <li className="flex flex-col gap-1 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
            <LevelBadge record={record} />
            <a href={recordHref(record.id)} className="min-w-0 text-sm font-semibold text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                {record.title}
            </a>
            {!record.active && record.missingSince && (
                <Badge size="sm" type="color" color="gray">
                    No longer in feed
                </Badge>
            )}
        </div>
        <p className="text-xs text-tertiary">
            {[RECORD_KIND_LABELS[record.kind], record.status, record.areaName, showSource ? record.provider : null].filter(Boolean).join(" · ")}
        </p>
        <p className="flex flex-wrap gap-x-3 text-xs text-quaternary">
            {record.observedAt ? <When iso={record.observedAt} label="Observed" /> : <When iso={record.updatedAt ?? record.publishedAt} label="Updated" />}
            {reason && <span>{reason}</span>}
            {record.fixture && (
                <Badge size="sm" type="color" color="warning">
                    Fixture data
                </Badge>
            )}
        </p>
    </li>
);

export const ChangeRow = ({ change }: { change: CentreChange }) => (
    <li className="flex flex-col gap-0.5 px-4 py-2.5 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
            <Badge
                size="sm"
                type="color"
                color={change.kind === "escalated" || change.kind === "ban_declared" ? "error" : change.kind.startsWith("source") ? "warning" : "gray"}
            >
                {CHANGE_KIND_LABELS[change.kind]}
            </Badge>
            {change.recordId ? (
                <a href={recordHref(change.recordId)} className="text-sm text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                    {change.summary}
                </a>
            ) : (
                <span className="text-sm text-primary">{change.summary}</span>
            )}
        </div>
        <span className="text-xs text-quaternary">
            <When iso={change.at} label="Detected" />
        </span>
    </li>
);

export const GeometryNote = ({ record }: { record: Pick<CentreRecord, "geometryQuality" | "uncertaintyM"> }) => (
    <p className="text-xs text-tertiary">
        {GEOMETRY_QUALITY_LABELS[record.geometryQuality]}
        {record.uncertaintyM
            ? ` Stated accuracy about ±${record.uncertaintyM >= 1000 ? `${Math.round(record.uncertaintyM / 100) / 10} km` : `${Math.round(record.uncertaintyM)} m`}.`
            : ""}
    </p>
);

export const SourcesLink = () => (
    <Button size="sm" color="link-gray" iconLeading={Database01} href={`${CENTRE}/sources`}>
        Source details
    </Button>
);
