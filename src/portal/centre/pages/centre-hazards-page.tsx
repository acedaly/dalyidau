// Hazards, one tab each: weather, fire danger, flood and water, transport, environment and
// infrastructure. Grouped here rather than six sidebar items. Each tab says which sources it reads
// and how fresh they are, and separates official warnings from observations.
import type { ReactNode } from "react";
import { Database01 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { DataTable } from "@/portal/components/data-table";
import { Notice } from "@/portal/components/notice";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import type { PageData } from "@/portal/lib/page-types";
import type { CentreHazardTab, CentreRecord } from "@/shared/centre/types";
import { SeriesChart } from "../series-chart";
import { CENTRE, CentreHeader, CentreNotices, FireDangerBadge, Freshness, RecordNature, RecordRow, SourceStatusBadge, When, recordHref } from "../shared";

const TABS: { id: CentreHazardTab; label: string }[] = [
    { id: "weather", label: "Weather" },
    { id: "fire-danger", label: "Fire danger" },
    { id: "flood", label: "Flood and water" },
    { id: "transport", label: "Transport" },
    { id: "environment", label: "Environment" },
    { id: "infrastructure", label: "Infrastructure" },
];

const metric = (r: CentreRecord, key: string) => {
    const m = r.metrics.find((x) => x.key === key);
    return m ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : "–";
};
const value = (r: CentreRecord, key: string) => r.metrics.find((x) => x.key === key)?.value ?? null;

const Section = ({ title, children, empty, count }: { title: string; children: ReactNode; empty: string; count: number }) => (
    <Card title={title}>{count ? children : <p className="px-4 py-4 text-sm text-tertiary sm:px-5">{empty}</p>}</Card>
);

const List = ({ records }: { records: CentreRecord[] }) => (
    <ul className="divide-y divide-secondary">
        {records.map((r) => (
            <RecordRow key={r.id} record={r} />
        ))}
    </ul>
);

const titleCell = (r: CentreRecord) => (
    <a href={recordHref(r.id)} className="font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
        {r.title}
    </a>
);

export const CentreHazardsPage = ({ data }: { data: PageData<"centre-hazards"> }) => {
    const { records, tab } = data;
    const warnings = records.filter((r) => r.kind === "warning");
    const observations = records.filter((r) => r.kind === "observation");
    const seriesFor = (id: string) => data.series.filter((s) => s.recordId === id);
    const active = data.sources.some((s) => s.status === "active" || s.status === "stale" || s.status === "error");

    const content = () => {
        switch (tab) {
            case "weather":
                return (
                    <>
                        <Section
                            title="Official weather warnings (Bureau of Meteorology)"
                            empty="No BoM warnings in force in the products collected. Check bom.gov.au for current warnings."
                            count={warnings.length}
                        >
                            <List records={warnings} />
                        </Section>
                        <DataTable
                            title="Latest observations"
                            description="Measured by BoM automatic weather stations, each at its own observation time. Observations, not forecasts."
                            rows={observations}
                            searchText={(r) => `${r.title} ${r.attributes.district ?? ""}`}
                            searchPlaceholder="Find a station"
                            initialSort={{ column: "temp", direction: "descending" }}
                            columns={[
                                { id: "station", label: "Station", isRowHeader: true, render: titleCell, sortValue: (r) => r.title },
                                {
                                    id: "temp",
                                    label: "Temperature",
                                    render: (r) => metric(r, "air_temperature"),
                                    sortValue: (r) => value(r, "air_temperature"),
                                },
                                { id: "gust", label: "Gusts", render: (r) => metric(r, "gust_kmh"), sortValue: (r) => value(r, "gust_kmh") },
                                {
                                    id: "wind",
                                    label: "Wind",
                                    render: (r) => `${metric(r, "wind_spd_kmh")}${r.attributes.windDir ? ` ${r.attributes.windDir}` : ""}`,
                                    sortValue: (r) => value(r, "wind_spd_kmh"),
                                    className: "max-md:hidden",
                                },
                                {
                                    id: "rh",
                                    label: "Humidity",
                                    render: (r) => metric(r, "rel_humidity"),
                                    sortValue: (r) => value(r, "rel_humidity"),
                                    className: "max-lg:hidden",
                                },
                                { id: "rain", label: "Rain since 9 am", render: (r) => metric(r, "rainfall"), sortValue: (r) => value(r, "rainfall") },
                                {
                                    id: "at",
                                    label: "Observed",
                                    render: (r) => <When iso={r.observedAt} />,
                                    sortValue: (r) => r.observedAt,
                                    className: "max-md:hidden",
                                },
                            ]}
                            emptyState={<p className="p-5 text-sm text-tertiary">No observations collected. Switch on BoM observations in Sources.</p>}
                        />
                    </>
                );
            case "fire-danger":
                return (
                    <DataTable
                        title="Fire Danger Ratings and Total Fire Bans (NSW RFS)"
                        description="As published by the RFS for each fire weather district. Districts have no boundaries in this feed, so they aren't drawn on the map."
                        rows={data.fireDanger.map((d) => ({ ...d, id: d.district }))}
                        initialSort={{ column: "district", direction: "ascending" }}
                        columns={[
                            {
                                id: "district",
                                label: "District",
                                isRowHeader: true,
                                render: (d) => <span className="font-medium text-primary">{d.district}</span>,
                                sortValue: (d) => d.district,
                            },
                            {
                                id: "today",
                                label: "Today",
                                render: (d) => <FireDangerBadge rating={d.today} />,
                                sortValue: (d) => ["No rating", "Moderate", "High", "Extreme", "Catastrophic"].indexOf(d.today),
                            },
                            {
                                id: "banToday",
                                label: "Ban today",
                                render: (d) =>
                                    d.banToday ? (
                                        <Badge size="sm" type="pill-color" color="error">
                                            Total Fire Ban
                                        </Badge>
                                    ) : (
                                        "No"
                                    ),
                                sortValue: (d) => (d.banToday ? 1 : 0),
                            },
                            {
                                id: "tomorrow",
                                label: "Tomorrow",
                                render: (d) => <FireDangerBadge rating={d.tomorrow} />,
                                sortValue: (d) => ["No rating", "Moderate", "High", "Extreme", "Catastrophic"].indexOf(d.tomorrow),
                            },
                            {
                                id: "banTomorrow",
                                label: "Ban tomorrow",
                                render: (d) => (d.banTomorrow ? "Total Fire Ban" : "No"),
                                sortValue: (d) => (d.banTomorrow ? 1 : 0),
                            },
                        ]}
                        emptyState={
                            <p className="p-5 text-sm text-tertiary">Fire danger isn't being collected. Switch on the RFS Fire Danger Ratings source.</p>
                        }
                    />
                );
            case "flood":
                return (
                    <>
                        <Section
                            title="Official flood warnings"
                            empty="No flood warnings in the BoM products collected. NSW SES flood warnings aren't available to this application (their feed needs the SES's permission): check Hazards Near Me."
                            count={warnings.length}
                        >
                            <List records={warnings} />
                        </Section>
                        <Card title="River gauges you follow (BoM Water Data Online)">
                            {observations.length ? (
                                <div className="flex flex-col divide-y divide-secondary">
                                    {observations.map((g) => (
                                        <div key={g.id} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <a href={recordHref(g.id)} className="text-sm font-semibold text-primary hover:underline">
                                                    {g.title}
                                                </a>
                                                <span className="text-sm text-secondary tabular-nums">
                                                    {metric(g, "water_level")} · <When iso={g.observedAt} label="observed" />
                                                </span>
                                            </div>
                                            {seriesFor(g.id).map((s) => (
                                                <SeriesChart
                                                    key={s.metric}
                                                    points={s.points}
                                                    label="River level"
                                                    unit="m"
                                                    caption="Observed river level (quality-coded series; can lag by a day or more). No flood thresholds are shown: none come with this data."
                                                />
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="px-4 py-4 text-sm text-tertiary sm:px-5">
                                    No gauges followed. Add station numbers in{" "}
                                    <a className="font-medium text-brand-secondary hover:underline" href={`${CENTRE}/settings`}>
                                        Settings
                                    </a>{" "}
                                    and switch on Water Data Online in Sources.
                                </p>
                            )}
                        </Card>
                    </>
                );
            case "transport":
                return (
                    <Section
                        title="Road closures and hazards (Live Traffic NSW)"
                        empty={
                            active
                                ? "No hazards in the Live Traffic data collected."
                                : "Transport for NSW data needs a free Open Data key (TFNSW_API_KEY). See Sources."
                        }
                        count={records.length}
                    >
                        <p className="border-b border-secondary px-4 py-2 text-xs text-tertiary sm:px-5">
                            Points as published. A closure point doesn't show how much of the road is closed, and not every local closure is in this dataset.
                        </p>
                        <List records={records} />
                    </Section>
                );
            case "environment": {
                const air = records.filter((r) => r.category === "air");
                const detections = records.filter((r) => r.category === "hotspot");
                const quakes = records.filter((r) => r.category === "earthquake");
                const space = records.filter((r) => r.category === "space_weather");
                const kp = space.find((r) => r.externalId === "planetary-kp");
                return (
                    <>
                        <DataTable
                            title="Air quality (NSW Government network)"
                            description="Measured hourly averages. The category is the NSW Government's own; smoke is never attributed to a particular fire here."
                            rows={air}
                            searchText={(r) => `${r.title} ${r.areaName ?? ""}`}
                            initialSort={{ column: "category", direction: "descending" }}
                            columns={[
                                { id: "site", label: "Site", isRowHeader: true, render: titleCell, sortValue: (r) => r.title },
                                { id: "category", label: "Category (provider's)", render: (r) => r.status ?? "–", sortValue: (r) => r.severityRank },
                                { id: "pm25", label: "PM2.5", render: (r) => metric(r, "pm25"), sortValue: (r) => value(r, "pm25") },
                                { id: "pm10", label: "PM10", render: (r) => metric(r, "pm10"), sortValue: (r) => value(r, "pm10"), className: "max-md:hidden" },
                                {
                                    id: "ozone",
                                    label: "Ozone",
                                    render: (r) => metric(r, "ozone"),
                                    sortValue: (r) => value(r, "ozone"),
                                    className: "max-md:hidden",
                                },
                                { id: "at", label: "Hour ending", render: (r) => <When iso={r.observedAt} />, sortValue: (r) => r.observedAt },
                            ]}
                            emptyState={<p className="p-5 text-sm text-tertiary">No air quality readings yet. Switch on the NSW air quality source.</p>}
                        />
                        <Section
                            title={`Satellite thermal detections (${detections.length})`}
                            empty="No detections in the last three days in the sources that are on."
                            count={detections.length}
                        >
                            <p className="border-b border-secondary px-4 py-2 text-xs text-tertiary sm:px-5">
                                Heat detected by satellites, with each sensor's stated accuracy. Not confirmed fires, not fire boundaries, and not for
                                safety-of-life decisions.
                            </p>
                            <List records={detections.slice(0, 50)} />
                            {detections.length > 50 && <p className="px-4 py-2 text-xs text-tertiary sm:px-5">The rest are on the Live map.</p>}
                        </Section>
                        <Section title="Earthquakes, last seven days (Geoscience Australia)" empty="No earthquakes collected." count={quakes.length}>
                            <p className="border-b border-secondary px-4 py-2 text-xs text-tertiary sm:px-5">
                                Recorded events, each with its origin time. A past earthquake isn't a current threat.
                            </p>
                            <List records={quakes} />
                        </Section>
                        <Card title="Space weather (informational)">
                            <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                                {kp ? (
                                    <>
                                        <p className="text-sm text-secondary">
                                            Planetary K-index {metric(kp, "kp")} <When iso={kp.observedAt} label="· observed" />
                                        </p>
                                        {seriesFor(kp.id).map((s) => (
                                            <SeriesChart
                                                key={s.metric}
                                                points={s.points}
                                                label="Kp"
                                                unit=""
                                                caption="NOAA planetary K-index, three-hourly. 5 and above is geomagnetic storm level."
                                            />
                                        ))}
                                    </>
                                ) : (
                                    <p className="text-sm text-tertiary">Not collected.</p>
                                )}
                                {space.filter((s) => s.id !== kp?.id).length > 0 && <List records={space.filter((s) => s.id !== kp?.id)} />}
                            </div>
                        </Card>
                    </>
                );
            }
            case "infrastructure":
                return (
                    <>
                        <Section
                            title="Power outages (Endeavour Energy)"
                            empty={active ? "No unplanned outages listed by Endeavour Energy." : "Switch on Endeavour Energy outages in Sources."}
                            count={records.length}
                        >
                            <List records={records} />
                        </Section>
                        <Notice title="What isn't covered">
                            Ausgrid and Essential Energy don't publish a documented outage feed, so their outages aren't here. No telecommunications or water
                            supply outage feed suitable for use was found.
                        </Notice>
                    </>
                );
        }
    };

    return (
        <>
            <CentreHeader title="Hazards" crumb="Hazards" shell={data} description="Official warnings and observations, by hazard.">
                <div className="-mx-4 overflow-x-auto px-4">
                    <Tabs selectedKey={tab} onSelectionChange={(k) => (window.location.href = `${CENTRE}/hazards/${String(k)}`)}>
                        <Tabs.List type="underline" size="sm">
                            {TABS.map((t) => (
                                <Tabs.Item key={t.id} id={t.id}>
                                    {t.label}
                                </Tabs.Item>
                            ))}
                        </Tabs.List>
                        {TABS.map((t) => (
                            <Tabs.Panel key={t.id} id={t.id} aria-label={t.label} />
                        ))}
                    </Tabs>
                </div>
            </CentreHeader>
            <CentreNotices shell={data} sources={data.sources} />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl bg-primary px-4 py-3 ring-1 ring-secondary">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-secondary">
                    <Database01 aria-hidden="true" className="size-4 text-fg-quaternary" />
                    Sources
                </span>
                {data.sources.map((s) => (
                    <span key={s.source.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm break-words text-tertiary">
                        {s.source.provider}: {s.source.dataset}
                        <SourceStatusBadge status={s.status} />
                        <Freshness health={s} />
                    </span>
                ))}
                <Button size="sm" color="link-gray" href={`${CENTRE}/sources`}>
                    Details
                </Button>
            </div>
            {records.some((r) => r.kind === "observation") && records.some((r) => r.kind !== "observation") && (
                <p className="flex items-center gap-2 text-xs text-tertiary">
                    <RecordNature record={{ kind: "warning" }} /> and <RecordNature record={{ kind: "observation" }} /> information are shown apart.
                </p>
            )}
            {content()}
        </>
    );
};
