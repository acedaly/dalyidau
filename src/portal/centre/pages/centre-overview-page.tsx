// Intelligence Centre overview: the NSW situation from the sources that are on, with every count
// straight from current records, each section's source and freshness, the private watch areas,
// recent changes, source health and a briefing. Useful without AI: the briefing's facts are
// deterministic and the interpretation is optional.
import { useState } from "react";
import {
    AlertTriangle,
    ArrowRight,
    Bell01,
    ClockRewind,
    CloudRaining01,
    Database01,
    FileCheck02,
    Flash,
    Globe04,
    Lightning01,
    Map01,
    MessageChatSquare,
    Route,
    Stars02,
    Target04,
    Thermometer01,
    Zap,
} from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Card } from "@/portal/components/card";
import { Empty } from "@/portal/components/empty";
import { MetricCard } from "@/portal/components/metric-card";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { formatNumber, pluralise } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import type { CentreAlert } from "@/shared/centre/types";
import { BriefingView } from "../briefing-view";
import { centreApi } from "../centre-api";
import { CorrelationItem } from "../history-ui";
import { CENTRE, CentreHeader, CentreNotices, ChangeRow, FireDangerBadge, Freshness, RecordRow, SourceStatusBadge, When } from "../shared";

export const CentreOverviewPage = ({ data }: { data: PageData<"centre-overview"> }) => {
    const { summary, sources } = data;
    const toast = useToast();
    const [alerts, setAlerts] = useState<CentreAlert[]>(data.alerts);
    const health = (id: string) => sources.find((s) => s.source.id === id);
    const active = (id: string) => ["active", "stale", "error"].includes(health(id)?.status ?? "");
    const levels = (byLevel: Record<string, number>) =>
        ["Emergency Warning", "Watch and Act", "Advice"]
            .filter((l) => byLevel[l])
            .map((l) => `${byLevel[l]} ${l}`)
            .join(" · ") || "None at Advice or above";
    const enabled = sources.filter((s) => s.enabled);

    return (
        <>
            <CentreHeader
                title="Intelligence Centre"
                description="What public sources are reporting across NSW, and in your own watch areas."
                shell={data}
                actions={
                    <>
                        <Button size="md" color="secondary" iconLeading={Lightning01} href={`${CENTRE}/changes`}>
                            What's changed
                        </Button>
                        <Button size="md" color="secondary" iconLeading={ClockRewind} href={`${CENTRE}/replay`}>
                            Replay
                        </Button>
                        <Button size="md" color="secondary" iconLeading={MessageChatSquare} href={`${CENTRE}/assistant`}>
                            Ask
                        </Button>
                        <Button size="md" color="secondary" iconLeading={FileCheck02} href={`${CENTRE}/reports`}>
                            Report
                        </Button>
                        <Button size="md" iconLeading={Map01} href={`${CENTRE}/map`}>
                            Live map
                        </Button>
                    </>
                }
            />
            <CentreNotices shell={data} sources={sources} />

            {!enabled.length ? (
                <Empty
                    icon={Database01}
                    title="No sources are switched on"
                    description={
                        data.canManage
                            ? "Choose which public sources to collect in Sources. Each one says what it is, its licence and whether it needs a key."
                            : "An owner or admin chooses which public sources to collect."
                    }
                    actions={
                        <Button size="md" href={`${CENTRE}/sources`}>
                            Open Sources
                        </Button>
                    }
                />
            ) : (
                <>
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                        <MetricCard
                            label="Current incidents"
                            value={active("rfs-incidents") ? formatNumber(summary.incidents.active) : "Not collected"}
                            icon={AlertTriangle}
                            detail={levels(summary.incidents.byLevel)}
                            footer={<Freshness health={health("rfs-incidents")} />}
                        />
                        <MetricCard
                            label="Official warnings"
                            value={formatNumber(summary.warnings.active)}
                            icon={Bell01}
                            detail={summary.warnings.active ? levels(summary.warnings.byLevel) : "None current in the sources that are on"}
                            footer={<Freshness health={health("bom-warnings") ?? health("rfs-incident-alerts")} />}
                        />
                        <MetricCard
                            label="Fire danger today"
                            value={summary.fireDanger.available ? <FireDangerBadge rating={summary.fireDanger.highestToday} size="lg" /> : "Not collected"}
                            icon={Flash}
                            detail={
                                summary.fireDanger.available
                                    ? `Highest rating. Tomorrow ${summary.fireDanger.highestTomorrow}. Total Fire Bans: ${summary.fireDanger.bansToday} today, ${summary.fireDanger.bansTomorrow} tomorrow`
                                    : "Switch on the RFS Fire Danger Ratings source"
                            }
                            footer={<Freshness health={health("rfs-fire-danger")} />}
                        />
                        <MetricCard
                            label="Severe weather"
                            value={active("bom-warnings") ? formatNumber(summary.weather.warnings) : "Not collected"}
                            icon={CloudRaining01}
                            detail={
                                active("bom-observations")
                                    ? `BoM warnings · ${pluralise(summary.weather.stations, "station")} observing`
                                    : "BoM warnings in force"
                            }
                            footer={<Freshness health={health("bom-warnings")} />}
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                        <MetricCard
                            label="Road closures"
                            value={summary.transport.available ? formatNumber(summary.transport.closures) : "Needs a key"}
                            icon={Route}
                            detail={summary.transport.available ? "Published as closed by Live Traffic NSW" : "Transport for NSW needs a free Open Data key"}
                            footer={<Freshness health={health("tfnsw-live-traffic")} />}
                        />
                        <MetricCard
                            label="Power outages"
                            value={summary.power.available ? formatNumber(summary.power.outages) : "Not collected"}
                            icon={Zap}
                            detail={
                                summary.power.available
                                    ? `${pluralise(summary.power.customers, "customer")} affected (Endeavour Energy network only)`
                                    : "Endeavour Energy network only"
                            }
                            footer={<Freshness health={health("endeavour-outages")} />}
                        />
                        <MetricCard
                            label="Satellite detections, 24 hours"
                            value={active("dea-hotspots") || active("nasa-firms") ? formatNumber(summary.hotspots.last24h) : "Not collected"}
                            icon={Thermometer01}
                            detail="Thermal detections, not confirmed fires"
                            footer={<Freshness health={health("dea-hotspots")} />}
                        />
                        <MetricCard
                            label="Air quality"
                            value={summary.air.worstCategory ?? (active("nsw-air-quality") ? "No reading" : "Not collected")}
                            icon={Globe04}
                            detail={
                                summary.air.sites
                                    ? `Poorest category across ${pluralise(summary.air.sites, "site")} (NSW Government's category)`
                                    : "NSW air quality network"
                            }
                            footer={<Freshness health={health("nsw-air-quality")} />}
                        />
                    </div>
                </>
            )}

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-6">
                    <Card
                        title="Warnings and significant incidents"
                        icon={AlertTriangle}
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={`${CENTRE}/records`}>
                                All
                            </Button>
                        }
                    >
                        {data.recentWarnings.length ? (
                            <ul className="divide-y divide-secondary">
                                {data.recentWarnings.map((r) => (
                                    <RecordRow key={r.id} record={r} />
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">
                                Nothing at Advice level or above in the sources that are on. That isn't confirmation that there's nothing: check official
                                channels.
                            </p>
                        )}
                    </Card>
                    <BriefingView briefing={data.briefing} shell={data} />
                    {data.correlations.length > 0 && (
                        <Card title="Possibly related observations" icon={Stars02}>
                            <ul className="divide-y divide-secondary">
                                {data.correlations.map((c) => (
                                    <CorrelationItem key={c.id} correlation={c} />
                                ))}
                            </ul>
                            <div className="border-t border-secondary px-4 py-3 sm:px-5">
                                <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={`${CENTRE}/correlations`}>
                                    Every correlation, with its evidence
                                </Button>
                            </div>
                        </Card>
                    )}
                </div>
                <div className="flex min-w-0 flex-col gap-6">
                    <Card
                        title="Your watch areas"
                        icon={Target04}
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={`${CENTRE}/watches`}>
                                Manage
                            </Button>
                        }
                    >
                        {alerts.length > 0 && (
                            <div className="flex flex-col gap-2 border-b border-secondary px-4 py-3 sm:px-5">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-semibold text-secondary">{pluralise(alerts.length, "new alert")}</span>
                                    <Button
                                        size="sm"
                                        color="link-gray"
                                        onClick={() =>
                                            void centreApi
                                                .acknowledge(alerts.map((a) => a.id))
                                                .then(() => setAlerts([]))
                                                .catch((e: unknown) => toast.error("Couldn't mark them read", errorMessage(e)))
                                        }
                                    >
                                        Mark as read
                                    </Button>
                                </div>
                                <ul className="flex flex-col gap-1.5">
                                    {alerts.slice(0, 5).map((a) => (
                                        <li key={a.id} className="text-sm">
                                            <a href={a.url} className="font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                                                {a.title}
                                            </a>
                                            <span className="block text-xs text-tertiary">
                                                <When iso={a.createdAt} />
                                                {a.detail ? ` · ${a.detail}` : ""}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {data.watches.length ? (
                            <ul className="divide-y divide-secondary">
                                {data.watches.map((w) => (
                                    <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                                        <a
                                            href={`${CENTRE}/records?watch=${w.id}`}
                                            className="text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                                        >
                                            {w.name}
                                        </a>
                                        {!w.enabled && (
                                            <Badge size="sm" type="color" color="gray">
                                                Paused
                                            </Badge>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">
                                Add a place, route, district or gauge to follow. Watch areas are private to you.{" "}
                                <a className="font-medium text-brand-secondary hover:underline" href={`${CENTRE}/watches`}>
                                    Add a watch area
                                </a>
                            </p>
                        )}
                    </Card>
                    <Card
                        title="Changes in the last 24 hours"
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={`${CENTRE}/history`}>
                                History
                            </Button>
                        }
                    >
                        {data.changes.length ? (
                            <ul className="divide-y divide-secondary">
                                {data.changes.slice(0, 12).map((c) => (
                                    <ChangeRow key={c.id} change={c} />
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">No changes detected in the last 24 hours.</p>
                        )}
                    </Card>
                    <Card
                        title="Source health"
                        icon={Database01}
                        action={
                            <Button size="sm" color="link-color" iconTrailing={ArrowRight} href={`${CENTRE}/sources`}>
                                Sources
                            </Button>
                        }
                    >
                        <ul className="divide-y divide-secondary">
                            {sources
                                .filter((s) => s.source.implemented)
                                .map((s) => (
                                    <li key={s.source.id} className="flex items-center justify-between gap-3 px-4 py-2 sm:px-5">
                                        <span className="min-w-0 text-sm text-secondary">
                                            {s.source.provider}
                                            <span className="block truncate text-xs text-tertiary">{s.source.dataset}</span>
                                        </span>
                                        <SourceStatusBadge status={s.status} />
                                    </li>
                                ))}
                        </ul>
                    </Card>
                </div>
            </div>
        </>
    );
};
