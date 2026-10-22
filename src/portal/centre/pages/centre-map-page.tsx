// Live map: every located record from the sources that are on, by layer, with a time filter,
// search, a detail panel and the same records as a list (the accessible alternative to the map).
// Records without a location (BoM's text warnings, fire danger districts) are listed beside it.
import { useEffect, useMemo, useState } from "react";
import { Eye, List, Map01, SearchLg, XClose } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Card } from "@/portal/components/card";
import type { PageData } from "@/portal/lib/page-types";
import type { CentreRecord, MapLayer } from "@/shared/centre/types";
import { centreApi } from "../centre-api";
import { CentreMap, LAYER_OPTIONS, type MapFeature, MapLegend, type WatchOutline, circleRing } from "../map/centre-map";
import { RecordSummary } from "../record-summary";
import { CentreHeader, CentreNotices, RecordRow } from "../shared";

const NSW: [number, number, number, number] = [140.9, -37.6, 153.7, -28.1];
const DEFAULT_LAYERS: MapLayer[] = ["fire", "warnings", "flood", "transport", "power", "hotspot", "emergency", "watch"];
const RANGES = { "6h": 6, "24h": 24, "72h": 72, "7d": 168 } as const;
type Range = keyof typeof RANGES;

const layerFor = (r: CentreRecord): MapLayer =>
    r.category === "fire"
        ? r.kind === "warning"
            ? "warnings"
            : "fire"
        : ((
              {
                  weather: "weather",
                  flood: "flood",
                  water: "water",
                  transport: "transport",
                  power: "power",
                  air: "air",
                  hotspot: "hotspot",
                  earthquake: "earthquake",
              } as Record<string, MapLayer>
          )[r.category] ?? "emergency");

const recordTime = (r: CentreRecord) => Date.parse(r.observedAt ?? r.updatedAt ?? r.publishedAt ?? r.firstSeenAt);

export const watchOutlines = (watches: PageData<"centre-map">["watches"]): WatchOutline[] =>
    watches.flatMap((w): WatchOutline[] => {
        const d = w.definition;
        if (d.kind === "point") return [{ id: w.id, name: w.name, ring: circleRing(d.lon, d.lat, d.radiusKm) }];
        if (d.kind === "polygon") return [{ id: w.id, name: w.name, ring: d.ring }];
        if (d.kind === "region")
            return [
                {
                    id: w.id,
                    name: w.name,
                    ring: [
                        [d.west, d.south],
                        [d.east, d.south],
                        [d.east, d.north],
                        [d.west, d.north],
                        [d.west, d.south],
                    ] as [number, number][],
                },
            ];
        if (d.kind === "corridor") return [{ id: w.id, name: w.name, line: d.line }];
        return [];
    });

export const CentreMapPage = ({ data }: { data: PageData<"centre-map"> }) => {
    const [features, setFeatures] = useState<MapFeature[]>(() =>
        data.records
            .filter((r) => r.lat !== null && r.lon !== null)
            .map((r) => ({
                type: "Feature" as const,
                id: r.id,
                geometry: { type: "Point", coordinates: [r.lon, r.lat] },
                properties: {
                    id: r.id,
                    layer: layerFor(r),
                    kind: r.kind,
                    title: r.title,
                    level: r.warningLevel,
                    rank: r.severityRank,
                    area: 0 as const,
                    nature: r.kind === "observation" || r.kind === "detection" ? ("observed" as const) : ("official" as const),
                    at: r.observedAt ?? r.updatedAt ?? r.publishedAt,
                },
            })),
    );
    const [layers, setLayers] = useState<MapLayer[]>(DEFAULT_LAYERS);
    const [range, setRange] = useState<Range>("7d");
    const [q, setQ] = useState("");
    const [view, setView] = useState<"map" | "list">("map");
    const [selected, setSelected] = useState<string | null>(null);
    const [bounds, setBounds] = useState<[number, number, number, number] | null>(null);
    const [onlyInView, setOnlyInView] = useState(false);
    const [frame, setFrame] = useState<[number, number, number, number]>(NSW);

    // Published areas (polygons) come with the full map data.
    useEffect(() => {
        centreApi
            .map({})
            .then((fc) => setFeatures(fc.features))
            .catch(() => undefined);
    }, []);

    const cutoff = Date.now() - RANGES[range] * 3_600_000;
    const inTime = (at: number) => !Number.isFinite(at) || at >= cutoff;
    const visibleFeatures = useMemo(() => features.filter((f) => inTime(Date.parse(f.properties.at ?? ""))), [features, cutoff]);
    const list = useMemo(
        () =>
            data.records.filter((r) => {
                if (!layers.includes(layerFor(r))) return false;
                if (!inTime(recordTime(r))) return false;
                if (q && !`${r.title} ${r.areaName ?? ""} ${r.provider}`.toLowerCase().includes(q.toLowerCase())) return false;
                if (onlyInView && bounds && r.lat !== null && r.lon !== null)
                    return r.lon >= bounds[0] && r.lon <= bounds[2] && r.lat >= bounds[1] && r.lat <= bounds[3];
                return true;
            }),
        [data.records, layers, q, onlyInView, bounds, cutoff],
    );
    const unlocated = list.filter((r) => r.lat === null && !r.bbox);
    const record = data.records.find((r) => r.id === selected) ?? null;
    const matches = q ? list.filter((r) => r.lat !== null).slice(0, 8) : [];

    return (
        <>
            <CentreHeader
                title="Live map"
                crumb="Live map"
                shell={data}
                description="Located records from the sources that are on. Points are where providers placed them; shaded areas are areas they published."
                actions={
                    <ButtonGroup
                        selectedKeys={[view]}
                        onSelectionChange={(keys) => {
                            const [k] = [...keys];
                            if (k === "map" || k === "list") setView(k);
                        }}
                        aria-label="Map or list"
                    >
                        <ButtonGroupItem id="map" iconLeading={Map01}>
                            Map
                        </ButtonGroupItem>
                        <ButtonGroupItem id="list" iconLeading={List}>
                            List
                        </ButtonGroupItem>
                    </ButtonGroup>
                }
            />
            <CentreNotices shell={data} />
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
                <aside aria-label="Layers and filters" className="flex flex-col gap-5">
                    <div className="flex flex-col gap-2">
                        <Input label="Search" icon={SearchLg} value={q} onChange={setQ} placeholder="Place, incident or road" />
                        {matches.length > 0 && view === "map" && (
                            <ul className="flex flex-col rounded-lg ring-1 ring-secondary" aria-label="Matching places">
                                {matches.map((r) => (
                                    <li key={r.id}>
                                        <button
                                            type="button"
                                            className="w-full cursor-pointer px-3 py-1.5 text-left text-sm text-secondary hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-focus-ring"
                                            onClick={() => {
                                                setSelected(r.id);
                                                setFrame([r.lon! - 0.15, r.lat! - 0.1, r.lon! + 0.15, r.lat! + 0.1]);
                                            }}
                                        >
                                            {r.title}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 text-sm font-semibold text-secondary">Time</legend>
                        <ButtonGroup
                            size="sm"
                            selectedKeys={[range]}
                            onSelectionChange={(keys) => {
                                const [k] = [...keys];
                                if (typeof k === "string" && k in RANGES) setRange(k as Range);
                            }}
                            aria-label="Time range"
                        >
                            {(Object.keys(RANGES) as Range[]).map((r) => (
                                <ButtonGroupItem key={r} id={r}>
                                    {r}
                                </ButtonGroupItem>
                            ))}
                        </ButtonGroup>
                        <p className="text-xs text-tertiary">By each record's own observed, updated or published time.</p>
                    </fieldset>
                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 text-sm font-semibold text-secondary">Layers</legend>
                        {LAYER_OPTIONS.map((l) => (
                            <Checkbox
                                key={l.id}
                                label={l.label}
                                isSelected={layers.includes(l.id)}
                                onChange={(on) => setLayers((current) => (on ? [...current, l.id] : current.filter((x) => x !== l.id)))}
                            />
                        ))}
                    </fieldset>
                    <Checkbox label="List only what's in the map view" isSelected={onlyInView} onChange={setOnlyInView} />
                </aside>
                <div className="flex min-w-0 flex-col gap-4">
                    {view === "map" && (
                        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
                            <CentreMap
                                features={visibleFeatures}
                                layers={layers}
                                frame={frame}
                                watches={watchOutlines(data.watches)}
                                selectedId={selected}
                                onSelect={setSelected}
                                onMove={setBounds}
                                label="Map of current hazard records in NSW. The same records are listed below the map."
                                className="h-[60vh] min-h-96"
                            />
                            {record ? (
                                <Card
                                    title="Details"
                                    icon={Eye}
                                    action={
                                        <ButtonUtility size="xs" color="tertiary" icon={XClose} tooltip="Close details" onClick={() => setSelected(null)} />
                                    }
                                >
                                    <div className="px-4 py-4 sm:px-5">
                                        <RecordSummary record={record} compact />
                                        <Button size="sm" color="link-color" href={`/portal/intelligence-centre/records/${record.id}`} className="mt-3">
                                            Full record and history
                                        </Button>
                                    </div>
                                </Card>
                            ) : (
                                <div className="flex flex-col gap-3 rounded-xl bg-primary p-4 ring-1 ring-secondary">
                                    <p className="text-sm font-semibold text-secondary">Legend</p>
                                    <MapLegend />
                                    <p className="text-xs text-tertiary">
                                        Select a point or area for its details. Locations are as precise as the provider made them, no more.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                    {data.truncated && <p className="text-xs text-warning-primary">More records exist than the map shows; filter by layer or search.</p>}
                    <Card title={`${list.length} ${list.length === 1 ? "record" : "records"}`} icon={List}>
                        {list.length ? (
                            <ul className="max-h-[32rem] divide-y divide-secondary overflow-y-auto" tabIndex={0} aria-label="Records on the map">
                                {list.slice(0, 300).map((r) => (
                                    <RecordRow key={r.id} record={r} />
                                ))}
                            </ul>
                        ) : (
                            <p className="px-4 py-4 text-sm text-tertiary sm:px-5">Nothing matches these layers and filters.</p>
                        )}
                    </Card>
                    {unlocated.length > 0 && (
                        <Card title="Not on the map (no published location)">
                            <ul className="divide-y divide-secondary">
                                {unlocated.map((r) => (
                                    <RecordRow key={r.id} record={r} />
                                ))}
                            </ul>
                        </Card>
                    )}
                </div>
            </div>
        </>
    );
};
