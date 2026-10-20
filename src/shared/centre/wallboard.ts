// Wallboard 2.0 (docs/INTELLIGENCE_CENTRE_9_1.md#wallboard-20): presets, the widget catalogue, the
// grid every view is laid out on, and what a display receives. Shared by the layout editor (which
// validates as you edit) and the Worker (which validates again before saving and builds each
// widget's data).
//
// A view is a 12 × 12 grid of widgets. Presets are ordinary views the editor can start from and
// restore; a customised view keeps its own widgets. Widgets carry their own geographic scope (the
// board's area, one of the owner's watch areas, or a named region), so one screen can show a
// local map beside a statewide list. What a display gets for a watch area is the records that
// concern it and a frame rounded outwards: never the area's coordinates or name.
import { z } from "zod";
import { REGION_IDS, type RegionId } from "./regions";
import type { HazardCategory, SourceStatus } from "./sources";
import { HAZARD_CATEGORIES } from "./sources";
import type { BriefingFact, CentreBriefing, Correlation, MapLayer, RecordKind, RecordMetric } from "./types";
import { DISPLAY_THEMES, MAP_LAYERS } from "./types";

export const GRID_COLUMNS = 12;
export const GRID_ROWS = 12;
export const MAX_VIEWS = 6;
export const MAX_WIDGETS = 16;

// --- Presets ---------------------------------------------------------------------------------------

export const WALLBOARD_PRESETS = ["local", "nsw", "weather", "transport", "trends", "map"] as const;
export type WallboardPreset = (typeof WALLBOARD_PRESETS)[number];

export const PRESET_LABELS: Record<WallboardPreset, string> = {
    local: "Local Situation",
    nsw: "NSW Situation Overview",
    weather: "Weather & Environment",
    transport: "Transport & Infrastructure",
    trends: "Intelligence & Trends",
    map: "Map Focus (classic)",
};

export const PRESET_DESCRIPTIONS: Record<WallboardPreset, string> = {
    local: "One watch area: a large map, warnings and nearby incidents, fire danger, observations and recent changes.",
    nsw: "Statewide awareness: the incident map, activity by category and region, warning levels, fire danger and significant changes.",
    weather: "Weather and flood warnings, station observations with charts, rainfall, river gauges, air quality and satellite detections.",
    transport: "Road closures and hazards (with your saved corridors), power outages, relevant warnings and recent changes.",
    trends: "Significant changes, an incident's timeline, cross-source correlations, trends, a briefing and source reliability.",
    map: "The original layout: a large map with the most serious records beside it.",
};

// --- Widgets ---------------------------------------------------------------------------------------

export const WIDGET_TYPES = [
    "map",
    "warnings",
    "nearby_incidents",
    "fire_danger",
    "fire_bans",
    "weather",
    "observation_chart",
    "rainfall_chart",
    "river_gauge",
    "air_quality",
    "recent_changes",
    "incident_timeline",
    "roads",
    "outages",
    "detections",
    "correlations",
    "trends",
    "summary",
    "briefing",
    "source_health",
    "source_timestamps",
    "clock",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Measurements a chart can show (as stored in each source's series). */
export const CHART_METRICS = ["air_temperature", "gust_kmh", "rainfall", "water_level", "pm25", "pm10", "ozone", "kp"] as const;
export type ChartMetric = (typeof CHART_METRICS)[number];
export const CHART_METRIC_LABELS: Record<ChartMetric, { label: string; unit: string }> = {
    air_temperature: { label: "Air temperature", unit: "°C" },
    gust_kmh: { label: "Wind gusts", unit: "km/h" },
    rainfall: { label: "Rain since 9 am", unit: "mm" },
    water_level: { label: "River level", unit: "m" },
    pm25: { label: "PM2.5", unit: "µg/m³" },
    pm10: { label: "PM10", unit: "µg/m³" },
    ozone: { label: "Ozone", unit: "pphm" },
    kp: { label: "Planetary K index", unit: "" },
};

export type WidgetNature = "official" | "observed" | "derived" | "mixed";
type SettingKey = keyof z.input<typeof widgetSettingsSchema>;

export interface WidgetMeta {
    label: string;
    description: string;
    nature: WidgetNature;
    min: { w: number; h: number };
    size: { w: number; h: number };
    /** Settings the editor offers for this widget (others are refused). */
    settings: readonly SettingKey[];
}

const LIST: readonly SettingKey[] = ["title", "scope", "limit"];

export const WIDGET_META: Record<WidgetType, WidgetMeta> = {
    map: {
        label: "Incident map",
        description: "Official incidents, warning areas as published, disruptions and detections, with clustering and a legend.",
        nature: "mixed",
        min: { w: 3, h: 3 },
        size: { w: 8, h: 8 },
        settings: ["title", "scope", "layers", "legend"],
    },
    warnings: {
        label: "Official warnings",
        description: "Warnings in force, most serious first, with their published level and time.",
        nature: "official",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: [...LIST, "categories"],
    },
    nearby_incidents: {
        label: "Nearby incidents",
        description: "Incidents that concern the area, nearest first (no distances are shown).",
        nature: "official",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 3 },
        settings: [...LIST, "categories"],
    },
    fire_danger: {
        label: "Fire danger",
        description: "Fire Danger Ratings today and tomorrow, and Total Fire Bans, as the RFS publishes them.",
        nature: "official",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 2 },
        settings: ["title", "scope", "limit"],
    },
    fire_bans: {
        label: "Total Fire Bans",
        description: "Districts with a Total Fire Ban today and tomorrow.",
        nature: "official",
        min: { w: 2, h: 1 },
        size: { w: 4, h: 2 },
        settings: ["title", "scope"],
    },
    weather: {
        label: "Current weather",
        description: "Station observations: temperature, wind and gusts, rain since 9 am, each with its own time.",
        nature: "observed",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 3 },
        settings: LIST,
    },
    observation_chart: {
        label: "Observation chart",
        description: "A measurement over time at one station (or the highest in the area).",
        nature: "observed",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: ["title", "scope", "metric", "station", "hours"],
    },
    rainfall_chart: {
        label: "Rainfall chart",
        description: "Rain since 9 am at the stations with the most rain in the area.",
        nature: "observed",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: ["title", "scope", "station", "hours"],
    },
    river_gauge: {
        label: "River gauge",
        description: "River levels at the gauges you follow, with recent readings.",
        nature: "observed",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: ["title", "station", "hours", "limit"],
    },
    air_quality: {
        label: "Air quality",
        description: "NSW Government air quality categories and readings at nearby sites.",
        nature: "observed",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 3 },
        settings: LIST,
    },
    recent_changes: {
        label: "Recent changes",
        description: "What changed between collections: new incidents, escalations, ratings, bans, closures, source problems.",
        nature: "derived",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: [...LIST, "hours", "significantOnly", "categories"],
    },
    incident_timeline: {
        label: "Incident timeline",
        description: "How one incident developed: published updates, level and status changes, related observations.",
        nature: "mixed",
        min: { w: 3, h: 3 },
        size: { w: 4, h: 6 },
        settings: ["title", "scope", "recordId", "limit"],
    },
    roads: {
        label: "Road disruptions",
        description: "Closures and hazards from Live Traffic NSW, with matches on your saved corridors.",
        nature: "official",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: [...LIST, "corridors"],
    },
    outages: {
        label: "Electricity outages",
        description: "Unplanned outages the network publishes, with customers affected.",
        nature: "official",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 3 },
        settings: LIST,
    },
    detections: {
        label: "Satellite detections",
        description: "Thermal detections from satellites: heat signatures, not confirmed fires.",
        nature: "observed",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 3 },
        settings: [...LIST, "hours"],
    },
    correlations: {
        label: "Cross-source correlations",
        description: "Records that may be related, with the rule, evidence and limitations. Derived, not official.",
        nature: "derived",
        min: { w: 3, h: 3 },
        size: { w: 4, h: 5 },
        settings: LIST,
    },
    trends: {
        label: "Trends",
        description: "New official records per day by category, as collected (not complete statistics).",
        nature: "derived",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: ["title", "scope", "hours", "categories"],
    },
    summary: {
        label: "Situation summary",
        description: "A short summary built from the records: counts by category and level, fire danger, latest update.",
        nature: "derived",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 3 },
        settings: ["title", "scope"],
    },
    briefing: {
        label: "Intelligence briefing",
        description: "The deterministic briefing facts, and an AI interpretation only if you prepared one.",
        nature: "derived",
        min: { w: 3, h: 3 },
        size: { w: 4, h: 4 },
        settings: ["title", "scope", "limit", "showInterpretation"],
    },
    source_health: {
        label: "Source health",
        description: "Each source's status and its success rate over the last 24 hours.",
        nature: "derived",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 4 },
        settings: ["title"],
    },
    source_timestamps: {
        label: "Source update times",
        description: "When each source was last retrieved and published, flagged when out of date.",
        nature: "derived",
        min: { w: 3, h: 2 },
        size: { w: 4, h: 3 },
        settings: ["title"],
    },
    clock: {
        label: "Clock and date",
        description: "A large clock and the date in the board's time zone.",
        nature: "derived",
        min: { w: 2, h: 1 },
        size: { w: 3, h: 2 },
        settings: ["title", "showSeconds"],
    },
};

export const widgetScopeSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("board") }).strict(),
    z.object({ kind: z.literal("watch"), watchId: z.string().regex(/^icw_[a-z0-9]{14}$/, "Choose one of your watch areas") }).strict(),
    z.object({ kind: z.literal("region"), region: z.enum(REGION_IDS) }).strict(),
]);
export type WidgetScope = z.output<typeof widgetScopeSchema>;

export const widgetSettingsSchema = z
    .object({
        title: z.string().trim().max(60).optional(),
        scope: widgetScopeSchema.optional(),
        layers: z.array(z.enum(MAP_LAYERS)).max(MAP_LAYERS.length).optional(),
        legend: z.boolean().optional(),
        limit: z.number().int().min(1).max(30).optional(),
        hours: z.number().int().min(1).max(168).optional(),
        significantOnly: z.boolean().optional(),
        categories: z.array(z.enum(HAZARD_CATEGORIES)).max(HAZARD_CATEGORIES.length).optional(),
        /** A station's or gauge's own number, e.g. 066062 or 410001. */
        station: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,20}$/, "Use the station number")
            .optional(),
        metric: z.enum(CHART_METRICS).optional(),
        recordId: z
            .string()
            .regex(/^icr_[a-z0-9]{14}$/)
            .optional(),
        corridors: z.boolean().optional(),
        showInterpretation: z.boolean().optional(),
        showSeconds: z.boolean().optional(),
    })
    .strict();
export type WidgetSettings = z.output<typeof widgetSettingsSchema>;

export const widgetSchema = z
    .object({
        id: z.string().regex(/^w[a-z0-9]{1,15}$/),
        type: z.enum(WIDGET_TYPES),
        x: z
            .number()
            .int()
            .min(0)
            .max(GRID_COLUMNS - 1),
        y: z
            .number()
            .int()
            .min(0)
            .max(GRID_ROWS - 1),
        w: z.number().int().min(1).max(GRID_COLUMNS),
        h: z.number().int().min(1).max(GRID_ROWS),
        settings: widgetSettingsSchema.default({}),
    })
    .strict();
export type Widget = z.output<typeof widgetSchema>;

/** What's wrong with a layout, in words; empty when it's valid. */
export function layoutProblems(widgets: readonly Widget[]): string[] {
    const problems: string[] = [];
    if (!widgets.length) problems.push("Add at least one widget");
    if (widgets.length > MAX_WIDGETS) problems.push(`A view can have up to ${MAX_WIDGETS} widgets`);
    const ids = new Set<string>();
    for (const w of widgets) {
        const meta = WIDGET_META[w.type];
        if (ids.has(w.id)) problems.push("Two widgets share an id");
        ids.add(w.id);
        if (w.x + w.w > GRID_COLUMNS || w.y + w.h > GRID_ROWS) problems.push(`${meta.label} goes past the edge of the screen`);
        if (w.w < meta.min.w || w.h < meta.min.h) problems.push(`${meta.label} needs at least ${meta.min.w} × ${meta.min.h} cells`);
        const allowed = new Set<string>(meta.settings);
        for (const key of Object.keys(w.settings)) if (!allowed.has(key)) problems.push(`${meta.label} has no "${key}" setting`);
    }
    for (let i = 0; i < widgets.length; i++)
        for (let j = i + 1; j < widgets.length; j++) {
            const a = widgets[i];
            const b = widgets[j];
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
                problems.push(`${WIDGET_META[a.type].label} overlaps ${WIDGET_META[b.type].label}`);
        }
    return [...new Set(problems)];
}

export const viewInputSchema = z
    .object({
        id: z
            .string()
            .regex(/^icl_[a-z0-9]{14}$/)
            .optional(),
        name: z.string().trim().min(1).max(60),
        preset: z.enum(WALLBOARD_PRESETS),
        customised: z.boolean().default(false),
        widgets: z.array(widgetSchema).min(1).max(MAX_WIDGETS),
    })
    .strict()
    .superRefine((view, ctx) => {
        for (const message of layoutProblems(view.widgets)) ctx.addIssue({ code: "custom", message, path: ["widgets"] });
    });
export type ViewInput = z.output<typeof viewInputSchema>;

export const viewsInputSchema = z.array(viewInputSchema).min(1).max(MAX_VIEWS);

export interface WallboardView extends ViewInput {
    id: string;
}

const w = (id: string, type: WidgetType, x: number, y: number, width: number, height: number, settings: WidgetSettings = {}): Widget => ({
    id,
    type,
    x,
    y,
    w: width,
    h: height,
    settings,
});

const MAP_ALL: MapLayer[] = ["fire", "warnings", "flood", "weather", "transport", "power", "hotspot", "emergency"];

/** The widgets a preset starts with. Every preset fits the 12 × 12 grid exactly, with no gaps. */
export function presetWidgets(preset: WallboardPreset): Widget[] {
    switch (preset) {
        case "local":
            // The map takes about 56% of the content area on a 16:9 screen.
            return [
                w("wmap", "map", 0, 0, 8, 10, { layers: MAP_ALL, legend: true }),
                w("wchanges", "recent_changes", 0, 10, 8, 2, { hours: 24, limit: 3, title: "Recent changes here" }),
                w("wsummary", "summary", 8, 0, 4, 2),
                w("wwarnings", "warnings", 8, 2, 4, 3, { limit: 4 }),
                w("wnearby", "nearby_incidents", 8, 5, 4, 3, { limit: 4 }),
                w("wfire", "fire_danger", 8, 8, 4, 2, { limit: 3 }),
                w("wweather", "weather", 8, 10, 4, 2, { limit: 3 }),
            ];
        case "nsw":
            return [
                w("wmap", "map", 0, 0, 7, 12, { layers: MAP_ALL, legend: true, scope: { kind: "region", region: "nsw" } }),
                w("wsummary", "summary", 7, 0, 5, 3, { scope: { kind: "region", region: "nsw" }, title: "Active across NSW" }),
                w("wwarnings", "warnings", 7, 3, 5, 4, { scope: { kind: "region", region: "nsw" }, limit: 5 }),
                w("wfire", "fire_danger", 7, 7, 5, 2, { scope: { kind: "region", region: "nsw" }, limit: 6 }),
                w("wchanges", "recent_changes", 7, 9, 5, 3, {
                    scope: { kind: "region", region: "nsw" },
                    hours: 24,
                    significantOnly: true,
                    limit: 4,
                    title: "Significant changes, last 24 hours",
                }),
            ];
        case "weather":
            return [
                w("wwarnings", "warnings", 0, 0, 4, 4, { categories: ["weather", "flood"], limit: 4, title: "Weather and flood warnings" }),
                w("wweather", "weather", 0, 4, 4, 8, { limit: 10 }),
                w("wtemp", "observation_chart", 4, 0, 4, 4, { metric: "air_temperature", hours: 24 }),
                w("wgust", "observation_chart", 4, 4, 4, 4, { metric: "gust_kmh", hours: 24 }),
                w("wrain", "rainfall_chart", 4, 8, 4, 4, { hours: 24 }),
                w("wriver", "river_gauge", 8, 0, 4, 5, { hours: 72, limit: 3 }),
                w("wair", "air_quality", 8, 5, 4, 4, { limit: 4 }),
                w("wdetect", "detections", 8, 9, 4, 3, { hours: 24, limit: 3 }),
            ];
        case "transport":
            return [
                w("wmap", "map", 0, 0, 8, 8, { layers: ["transport", "power", "warnings", "flood", "fire"], legend: true }),
                w("wroads", "roads", 8, 0, 4, 6, { corridors: true, limit: 6 }),
                w("woutages", "outages", 8, 6, 4, 3, { limit: 3 }),
                w("wtimes", "source_timestamps", 8, 9, 4, 3),
                w("wwarnings", "warnings", 0, 8, 4, 4, { limit: 3, title: "Relevant warnings" }),
                w("wchanges", "recent_changes", 4, 8, 4, 4, { categories: ["transport", "power"], hours: 24, limit: 4, title: "Roads and power: changes" }),
            ];
        case "trends":
            return [
                w("wchanges", "recent_changes", 0, 0, 4, 12, { hours: 24, significantOnly: true, limit: 12, title: "Significant changes" }),
                w("wtimeline", "incident_timeline", 4, 0, 4, 6, { limit: 8 }),
                w("wcorrelations", "correlations", 4, 6, 4, 6, { limit: 3 }),
                w("wtrends", "trends", 8, 0, 4, 4, { hours: 168 }),
                w("wbriefing", "briefing", 8, 4, 4, 4, { limit: 5 }),
                w("whealth", "source_health", 8, 8, 4, 4),
            ];
        case "map":
            return [
                w("wmap", "map", 0, 0, 9, 12, { layers: MAP_ALL, legend: true }),
                w("wwarnings", "warnings", 9, 0, 3, 12, { limit: 8, title: "Most serious" }),
            ];
    }
}

export const presetView = (preset: WallboardPreset): ViewInput => ({ name: PRESET_LABELS[preset], preset, customised: false, widgets: presetWidgets(preset) });

/** Views for a board saved before Wallboard 2.0: its layout, or each layout it rotated through. */
export function legacyViews(layout: string, rotation: readonly string[]): ViewInput[] {
    const known = (l: string): WallboardPreset => ((WALLBOARD_PRESETS as readonly string[]).includes(l) ? (l as WallboardPreset) : "nsw");
    const list = rotation.length ? rotation : [layout];
    return [...new Set(list.map(known))].slice(0, MAX_VIEWS).map(presetView);
}

/** A free widget id for a new widget in a view. */
export function nextWidgetId(widgets: readonly Pick<Widget, "id">[]): string {
    const used = new Set(widgets.map((x) => x.id));
    for (let i = 1; i < 1000; i++) if (!used.has(`wn${i}`)) return `wn${i}`;
    return `w${Date.now().toString(36).slice(-8)}`;
}

/** The first free place for a widget of this size, or null when the view is full. */
export function freeSlot(widgets: readonly Widget[], width: number, height: number): { x: number; y: number } | null {
    for (let y = 0; y + height <= GRID_ROWS; y++)
        for (let x = 0; x + width <= GRID_COLUMNS; x++) {
            const clash = widgets.some((o) => x < o.x + o.w && o.x < x + width && y < o.y + o.h && o.y < y + height);
            if (!clash) return { x, y };
        }
    return null;
}

// --- Display preferences ---------------------------------------------------------------------------

export { DISPLAY_THEMES };
export type DisplayTheme = (typeof DISPLAY_THEMES)[number];
export const DISPLAY_THEME_LABELS: Record<DisplayTheme, string> = { dark: "Dark", high_contrast: "High contrast" };

// --- What a display receives (version 2) ------------------------------------------------------------

/** A record trimmed for a screen: what it says, where it's from and its own times. */
export interface DisplayRecord {
    id: string;
    kind: RecordKind;
    category: HazardCategory;
    nature: "official" | "observed";
    title: string;
    status: string | null;
    /** The provider's own level, exactly as published. */
    level: string | null;
    rank: number;
    areaName: string | null;
    provider: string;
    sourceId: string;
    publishedAt: string | null;
    updatedAt: string | null;
    observedAt: string | null;
    sourceUrl: string | null;
    metrics: RecordMetric[];
    attributes: Record<string, string>;
    fixture: boolean;
}

export interface DisplayChange {
    id: string;
    kind: string;
    label: string;
    at: string;
    summary: string;
    category: HazardCategory | null;
    recordId: string | null;
    sourceId: string;
    significant: boolean;
}

export interface DisplaySource {
    id: string;
    provider: string;
    dataset: string;
    status: SourceStatus;
    lastSuccessAt: string | null;
    lastPublishedAt: string | null;
    attribution: string;
    /** Successful retrievals in the last 24 hours, as a share of attempts (null: none attempted). */
    successRate24h: number | null;
    /** Why there's nothing from it, in words (a missing key, switched off, failing). Null when active. */
    gap: string | null;
}

export interface DisplayTimelineEvent {
    at: string;
    label: string;
    detail: string;
    nature: "official" | "observed" | "derived" | "collection";
}

export interface FireDangerRow {
    district: string;
    today: string;
    tomorrow: string;
    banToday: boolean;
    banTomorrow: boolean;
    updatedAt: string | null;
}

interface WidgetBase {
    /** The view's id and the widget's, e.g. "icl_…:wmap". */
    key: string;
    title: string;
    nature: WidgetNature;
    scopeLabel: string;
    /** Sources this widget needs that aren't active, with why: shown instead of a misleading empty list. */
    unavailable: { sourceId: string; message: string }[];
    /** Sources this widget uses whose data is out of date. */
    stale: string[];
}

export type WidgetData = WidgetBase &
    (
        | {
              type: "map";
              frame: [number, number, number, number];
              features: unknown[];
              layers: MapLayer[];
              legend: boolean;
              outline: [number, number][] | null;
              truncated: boolean;
              /** District and text-only records that have no shape to draw (listed beside the map). */
              unmapped: number;
          }
        | {
              type: "warnings" | "nearby_incidents" | "roads" | "outages" | "detections" | "air_quality" | "weather";
              records: DisplayRecord[];
              total: number;
              corridorIds: string[];
              customers: number | null;
          }
        | { type: "fire_danger" | "fire_bans"; districts: FireDangerRow[]; updatedAt: string | null }
        | {
              type: "observation_chart" | "rainfall_chart" | "river_gauge";
              metric: ChartMetric;
              unit: string;
              series: { label: string; recordId: string; latest: number | null; latestAt: string | null; points: { at: string; value: number }[] }[];
          }
        | { type: "recent_changes"; changes: DisplayChange[]; total: number }
        | { type: "incident_timeline"; record: DisplayRecord | null; events: DisplayTimelineEvent[] }
        | { type: "correlations"; correlations: Correlation[] }
        | { type: "trends"; days: { date: string; counts: Partial<Record<HazardCategory, number>> }[]; note: string }
        | { type: "summary"; lines: string[]; counts: { label: string; value: number }[] }
        | { type: "briefing"; facts: BriefingFact[]; interpretation: CentreBriefing["interpretation"] | null }
        | { type: "source_health" | "source_timestamps"; sources: DisplaySource[] }
        | { type: "clock"; showSeconds: boolean }
    );

/** A current official warning or a recent change to one in the board's area: pinned above every view. */
export interface DisplayAlert {
    id: string;
    recordId: string;
    title: string;
    level: string | null;
    rank: number;
    provider: string;
    publishedAt: string | null;
    updatedAt: string | null;
    sourceUrl: string | null;
    /** What changed, when it's a change (new, escalated, area changed); null for one simply in force. */
    change: string | null;
    changedAt: string | null;
}

export interface BasemapInfo {
    kind: "detailed" | "outline";
    /** Tile address template on this site (only for the detailed map). */
    tiles: string | null;
    minZoom: number;
    maxZoom: number;
    bounds: [number, number, number, number] | null;
    attribution: string;
    /** Why the detailed map isn't shown, when it isn't. */
    note: string | null;
}

export interface WallboardPayloadV2 {
    version: 2;
    /** Changes whenever anything on the board could have; the display sends it back to skip unchanged refreshes. */
    stateKey: string;
    board: {
        name: string;
        theme: DisplayTheme;
        scale: number;
        clock: boolean;
        burnIn: boolean;
        rotate: boolean;
        rotationSeconds: number;
        refreshSeconds: number;
    };
    views: { id: string; name: string; preset: WallboardPreset; widgets: Pick<Widget, "id" | "type" | "x" | "y" | "w" | "h">[] }[];
    data: Record<string, WidgetData>;
    /** Emergency Warnings in force, and official warning changes in the last two hours, in the board's area. */
    alerts: DisplayAlert[];
    sources: DisplaySource[];
    basemap: BasemapInfo;
    areaLabel: string;
    generatedAt: string;
    timeZone: string;
    /** The credential is near its expiry and may be renewed by the display itself. */
    renewal: { due: boolean; expiresAt: string | null };
}

export const scopeLabelOf = (scope: WidgetScope | undefined, boardLabel: string, regionLabel: (id: RegionId) => string, watchLabel: string) =>
    !scope || scope.kind === "board" ? boardLabel : scope.kind === "region" ? regionLabel(scope.region) : watchLabel;
