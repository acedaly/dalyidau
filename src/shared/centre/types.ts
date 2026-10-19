// Shapes shared by the Intelligence Centre's Worker and pages (docs/INTELLIGENCE_CENTRE.md).
//
// Three kinds of information are kept apart everywhere they appear:
//  - official: what a provider published (incidents, warnings, ratings), in its own words;
//  - observed: measurements and detections (weather, rivers, air, satellites), with their own times;
//  - derived: what this application worked out (changes, correlations, briefings), always labelled.
import { z } from "zod";
import type { HazardCategory, SourceDefinition, SourceStatus } from "./sources";
import { HAZARD_CATEGORIES } from "./sources";

export const RECORD_KINDS = ["incident", "warning", "rating", "observation", "disruption", "detection", "event"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
    incident: "Incident",
    warning: "Official warning",
    rating: "Official rating",
    observation: "Observation",
    disruption: "Disruption",
    detection: "Satellite detection",
    event: "Event",
};

/** Official information (published by an agency) vs measured or detected. */
export const recordNature = (kind: RecordKind): "official" | "observed" => (kind === "observation" || kind === "detection" ? "observed" : "official");

/**
 * The Australian Warning System levels, in order. Only a provider's own published level is ever
 * stored; nothing here infers or raises one.
 */
export const WARNING_LEVELS = ["Advice", "Watch and Act", "Emergency Warning"] as const;
export type WarningLevel = (typeof WARNING_LEVELS)[number];
export const levelRank = (level: string | null | undefined): number => {
    const i = WARNING_LEVELS.findIndex((l) => l.toLowerCase() === (level ?? "").trim().toLowerCase());
    return i < 0 ? 0 : i + 1;
};

/** Fire Danger Ratings (the Australian Fire Danger Rating System), lowest first. "None" means no rating. */
export const FIRE_DANGER_RATINGS = ["No rating", "Moderate", "High", "Extreme", "Catastrophic"] as const;
export type FireDangerRating = (typeof FIRE_DANGER_RATINGS)[number];
export const fireDangerRank = (rating: string | null | undefined): number => {
    const value = (rating ?? "").trim().toLowerCase();
    if (!value || value === "none" || value === "no rating") return 0;
    const i = FIRE_DANGER_RATINGS.findIndex((r) => r.toLowerCase() === value);
    return i < 0 ? 0 : i;
};

export type GeometryQuality = "point" | "polygon" | "line" | "district" | "area_text" | "none";

export const GEOMETRY_QUALITY_LABELS: Record<GeometryQuality, string> = {
    point: "A published point. The incident or event may cover a much larger area.",
    polygon: "An area published by the provider.",
    line: "A line published by the provider.",
    district: "A named district: the provider publishes no boundary.",
    area_text: "Described in words only: no location is drawn.",
    none: "No location published.",
};

export interface RecordMetric {
    key: string;
    label: string;
    value: number;
    unit: string;
}

/** One record as the browser sees it. */
export interface CentreRecord {
    id: string;
    sourceId: string;
    provider: string;
    externalId: string;
    kind: RecordKind;
    category: HazardCategory;
    eventType: string | null;
    title: string;
    description: string | null;
    status: string | null;
    /** The provider's own level (AWS for warnings, the FDR for ratings), exactly as published. */
    warningLevel: string | null;
    severityRank: number;
    lat: number | null;
    lon: number | null;
    bbox: [number, number, number, number] | null;
    hasGeometry: boolean;
    geometryQuality: GeometryQuality;
    /** Stated accuracy in metres, when the provider gives one. */
    uncertaintyM: number | null;
    areaName: string | null;
    /** When the provider says it published or issued it. */
    publishedAt: string | null;
    /** The provider's own "last updated". */
    updatedAt: string | null;
    /** When it was measured or detected (observations and detections). */
    observedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    /** Set when a later complete retrieval no longer contained it. This is not the same as resolved. */
    missingSince: string | null;
    active: boolean;
    sourceUrl: string | null;
    metrics: RecordMetric[];
    attributes: Record<string, string>;
    /** Collected from a recorded fixture or a local stand-in, never from the live service. */
    fixture: boolean;
}

export const CHANGE_KINDS = [
    "new",
    "escalated",
    "downgraded",
    "updated",
    "geometry_changed",
    "not_in_feed",
    "reappeared",
    "ended",
    "rating_changed",
    "ban_declared",
    "ban_lifted",
    "measurement_change",
    "source_failed",
    "source_stale",
    "source_recovered",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
    new: "New",
    escalated: "Warning level raised",
    downgraded: "Warning level lowered",
    updated: "Updated",
    geometry_changed: "Published area changed",
    not_in_feed: "No longer in the feed (not confirmed resolved)",
    reappeared: "Back in the feed",
    ended: "Provider marked it ended",
    rating_changed: "Fire danger rating changed",
    ban_declared: "Total fire ban declared",
    ban_lifted: "Total fire ban no longer listed",
    measurement_change: "Material change in measurement",
    source_failed: "Source failed",
    source_stale: "Source stale",
    source_recovered: "Source recovered",
};

export interface CentreChange {
    id: string;
    recordId: string | null;
    sourceId: string;
    kind: ChangeKind;
    at: string;
    fromValue: string | null;
    toValue: string | null;
    summary: string;
    severityRank: number;
    category: HazardCategory | null;
    title: string | null;
}

export interface SourceHealth {
    source: SourceDefinition;
    enabled: boolean;
    status: SourceStatus;
    /** A plain explanation of the status. */
    statusDetail: string;
    credentialsPresent: boolean;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastPublishedAt: string | null;
    nextDueAt: string | null;
    recordCount: number;
    consecutiveFailures: number;
    errorMessage: string | null;
    fixture: boolean;
}

export interface FetchRun {
    id: string;
    sourceId: string;
    startedAt: string;
    outcome: "ok" | "unchanged" | "error" | "rejected";
    httpStatus: number | null;
    bytes: number;
    records: number;
    created: number;
    changed: number;
    ms: number;
    errorCode: string | null;
}

// --- Watch areas -----------------------------------------------------------------------------------

export const WATCH_KINDS = ["point", "polygon", "region", "fire_district", "gauge", "corridor", "incident"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const WATCH_KIND_LABELS: Record<WatchKind, string> = {
    point: "Place and radius",
    polygon: "Drawn area (polygon)",
    region: "Region (bounding box)",
    fire_district: "Fire danger district",
    gauge: "River gauge",
    corridor: "Road corridor",
    incident: "One incident",
};

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const position = z.tuple([lon, lat]);

export const watchDefinitionSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("point"), lat, lon, radiusKm: z.number().min(0.5).max(300), placeName: z.string().trim().max(120).default("") }).strict(),
    z
        .object({
            kind: z.literal("polygon"),
            ring: z
                .array(position)
                .min(4)
                .max(200)
                .refine((r) => r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1], "The first and last points must be the same"),
        })
        .strict(),
    z
        .object({ kind: z.literal("region"), south: lat, west: lon, north: lat, east: lon })
        .strict()
        .refine((r) => r.north > r.south && r.east > r.west, "North must be above south and east right of west")
        .refine((r) => r.north - r.south <= 15 && r.east - r.west <= 15, "A region can be at most 15 degrees across"),
    z.object({ kind: z.literal("fire_district"), district: z.string().trim().min(1).max(80) }).strict(),
    z.object({ kind: z.literal("gauge"), station: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/, "Use the station number, e.g. 410001") }).strict(),
    z
        .object({
            kind: z.literal("corridor"),
            line: z.array(position).min(2).max(100),
            bufferKm: z.number().min(0.2).max(20),
        })
        .strict(),
    z.object({ kind: z.literal("incident"), recordId: z.string().regex(/^icr_[a-z0-9]{14}$/, "Not a valid record") }).strict(),
]);
export type WatchDefinition = z.output<typeof watchDefinitionSchema>;

export const watchInputSchema = z
    .object({
        name: z.string().trim().min(1).max(80),
        definition: watchDefinitionSchema,
        /** Also show the fire danger for this district (point, polygon, region and corridor watches). */
        fireDistrict: z.string().trim().max(80).nullable().default(null),
        categories: z.array(z.enum(HAZARD_CATEGORIES)).max(HAZARD_CATEGORIES.length).default([]),
        /** Alert from this AWS level up (0: any official warning or new incident). */
        minLevel: z.number().int().min(0).max(3).default(0),
        notifyInApp: z.boolean().default(true),
        notifyEmail: z.boolean().default(false),
        quietStart: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .nullable()
            .default(null),
        quietEnd: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .nullable()
            .default(null),
        expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
        enabled: z.boolean().default(true),
    })
    .strict();
export type WatchInput = z.output<typeof watchInputSchema>;

export interface WatchArea extends WatchInput {
    id: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    /** Records currently matching (active only). */
    matches?: number;
}

// --- Alerts --------------------------------------------------------------------------------------

export interface CentreAlert {
    id: string;
    watchId: string | null;
    watchName: string | null;
    recordId: string | null;
    kind: ChangeKind | "digest";
    title: string;
    detail: string | null;
    url: string;
    levelRank: number;
    createdAt: string;
    acknowledgedAt: string | null;
    emailStatus: string | null;
}

// --- Preferences and settings ----------------------------------------------------------------------

export const centrePreferencesSchema = z
    .object({
        /** Show an Intelligence section on Today, and from which level. */
        today: z.object({ enabled: z.boolean(), minLevel: z.number().int().min(0).max(3), showFireDanger: z.boolean() }).strict(),
        /** Emails need the owner's switch, a provider, and this. Off by default. */
        email: z.object({ alerts: z.boolean(), digest: z.boolean(), digestHour: z.number().int().min(0).max(23) }).strict(),
        quietHours: z
            .object({
                start: z.string().regex(/^\d{2}:\d{2}$/),
                end: z.string().regex(/^\d{2}:\d{2}$/),
            })
            .nullable(),
        /** Compare upcoming calendar events' locations with active warnings. Off unless chosen. */
        calendarMatching: z.boolean(),
        timeZone: z.string().max(60),
    })
    .strict();
export type CentrePreferences = z.output<typeof centrePreferencesSchema>;

export const DEFAULT_CENTRE_PREFERENCES: CentrePreferences = {
    today: { enabled: true, minLevel: 2, showFireDanger: true },
    email: { alerts: false, digest: false, digestHour: 7 },
    quietHours: null,
    calendarMatching: false,
    timeZone: "Australia/Sydney",
};

export const centreSettingsSchema = z
    .object({
        retention: z
            .object({
                /** Records no longer in any feed are kept this long, then removed. */
                recordDays: z.number().int().min(7).max(400),
                changeDays: z.number().int().min(7).max(400),
                seriesDays: z.number().int().min(2).max(400),
                fetchRunDays: z.number().int().min(2).max(90),
                alertDays: z.number().int().min(7).max(400),
                /** Raw response snapshots in R2 (only for sources whose terms allow keeping history). */
                snapshotsPerSource: z.number().int().min(0).max(200),
            })
            .strict(),
        /** River gauges to follow from Water Data Online (station numbers). */
        gauges: z
            .array(z.string().regex(/^[A-Za-z0-9_-]{3,20}$/))
            .max(20)
            .default([]),
        /** Air quality sites to follow (NSW site ids). Empty: every site, latest hour only. */
        airSites: z.array(z.number().int().min(1).max(100_000)).max(60).default([]),
        correlation: z
            .object({
                distanceKm: z.number().min(1).max(100),
                windowHours: z.number().min(1).max(168),
            })
            .strict(),
        /** Materiality of a river level change (metres in one collection) worth recording. */
        riverChangeMetres: z.number().min(0.05).max(5),
        /** Records drawn on the map at once. */
        maxMapRecords: z.number().int().min(100).max(5000),
        /**
         * Basemap: an outline of Australia's states served from this site (Natural Earth, public domain).
         * Third-party tiles aren't offered: every tile request would tell a tile host which area
         * someone is looking at (often their home), and they'd need a wider Content Security Policy.
         */
        basemap: z.enum(["outline"]),
    })
    .strict();
export type CentreSettings = z.output<typeof centreSettingsSchema>;

export const DEFAULT_CENTRE_SETTINGS: CentreSettings = {
    retention: { recordDays: 90, changeDays: 180, seriesDays: 30, fetchRunDays: 30, alertDays: 90, snapshotsPerSource: 20 },
    gauges: [],
    airSites: [],
    correlation: { distanceKm: 25, windowHours: 48 },
    riverChangeMetres: 0.3,
    maxMapRecords: 2000,
    basemap: "outline",
};

// --- Correlation ---------------------------------------------------------------------------------

export interface CorrelationEvidence {
    recordId: string;
    title: string;
    category: HazardCategory;
    kind: RecordKind;
    provider: string;
    at: string | null;
    distanceKm: number | null;
    sourceUrl: string | null;
}

export interface Correlation {
    id: string;
    rule: string;
    title: string;
    explanation: string;
    /** Never "high": correlation isn't confirmation. */
    confidence: "low" | "moderate";
    limitations: string;
    records: CorrelationEvidence[];
    centre: { lat: number; lon: number } | null;
}

// --- Briefings -----------------------------------------------------------------------------------

export interface BriefingFact {
    /** F1, F2…: what an AI explanation may cite. */
    ref: string;
    text: string;
    recordId: string | null;
    sourceId: string | null;
    at: string | null;
    url: string | null;
}

export interface BriefingSection {
    key: string;
    title: string;
    facts: BriefingFact[];
}

export interface CentreBriefing {
    scope: "nsw" | "watch" | "morning";
    watchId: string | null;
    title: string;
    generatedAt: string;
    sections: BriefingSection[];
    /** Sources not active, with why: the briefing says what it couldn't see. */
    gaps: { sourceId: string; dataset: string; status: SourceStatus }[];
    interpretation: { status: "off" | "not_requested" | "ready" | "unavailable" | "budget"; items: { text: string; refs: string[] }[]; model: string | null };
}

// --- Wallboards ----------------------------------------------------------------------------------

export const WALLBOARD_LAYOUTS = ["local", "nsw", "map", "weather"] as const;
export type WallboardLayout = (typeof WALLBOARD_LAYOUTS)[number];
export const WALLBOARD_LAYOUT_LABELS: Record<WallboardLayout, string> = {
    local: "Local Situation",
    nsw: "NSW Overview",
    map: "Map Focus",
    weather: "Weather & Environment",
};

export const MAP_LAYERS = [
    "fire",
    "warnings",
    "weather",
    "flood",
    "water",
    "transport",
    "power",
    "air",
    "hotspot",
    "earthquake",
    "emergency",
    "watch",
] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];
export const MAP_LAYER_LABELS: Record<MapLayer, string> = {
    fire: "Bush and grass fires",
    warnings: "Official warning areas",
    weather: "Weather stations and warnings",
    flood: "Flood warnings",
    water: "River gauges",
    transport: "Road closures and hazards",
    power: "Power outages",
    air: "Air quality",
    hotspot: "Satellite thermal detections",
    earthquake: "Earthquakes",
    emergency: "Other incidents",
    watch: "My watch areas",
};

export const wallboardInputSchema = z
    .object({
        name: z.string().trim().min(1).max(60),
        layout: z.enum(WALLBOARD_LAYOUTS),
        /** The area shown: a watch area of the owner's, or all of NSW. */
        watchId: z
            .string()
            .regex(/^icw_[a-z0-9]{14}$/)
            .nullable()
            .default(null),
        layers: z.array(z.enum(MAP_LAYERS)).max(MAP_LAYERS.length).default(["fire", "warnings", "transport", "hotspot"]),
        /** Rotate through these layouts (empty: stay on one). */
        rotation: z.array(z.enum(WALLBOARD_LAYOUTS)).max(4).default([]),
        rotationSeconds: z.number().int().min(20).max(600).default(60),
        refreshSeconds: z.number().int().min(30).max(900).default(60),
        showInterpretation: z.boolean().default(false),
        /** Draw the watch area's outline on the display (off by default: it shows a private location). */
        showWatchOutline: z.boolean().default(false),
    })
    .strict();
export type WallboardInput = z.output<typeof wallboardInputSchema>;

export interface Wallboard extends WallboardInput {
    id: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    tokens: DisplayToken[];
}

export interface DisplayToken {
    id: string;
    label: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
}

/** What a display receives: only this board's view, never a coordinate of the watch area itself. */
export interface WallboardPayload {
    board: { name: string; layout: WallboardLayout; rotation: WallboardLayout[]; rotationSeconds: number; refreshSeconds: number; layers: MapLayer[] };
    /** Frame for the map, rounded outwards to 0.1° so it doesn't pinpoint a home. */
    frame: [number, number, number, number];
    areaLabel: string;
    generatedAt: string;
    timeZone: string;
    records: CentreRecord[];
    /** The same records as map features (published areas included), built by the Worker. */
    map: { type: "FeatureCollection"; features: unknown[] };
    fireDanger: { district: string; today: string; tomorrow: string; banToday: boolean; banTomorrow: boolean; updatedAt: string | null }[];
    observations: CentreRecord[];
    changes: CentreChange[];
    /** Changes to official warnings in the selected area, to highlight. */
    highlights: CentreChange[];
    sources: { id: string; dataset: string; provider: string; status: SourceStatus; lastSuccessAt: string | null; attribution: string }[];
    interpretation: CentreBriefing["interpretation"] | null;
    outline: [number, number][] | null;
    basemap: CentreSettings["basemap"];
}

// --- API and page shapes --------------------------------------------------------------------------

export interface CentreSummary {
    generatedAt: string;
    incidents: { active: number; byLevel: Record<string, number> };
    warnings: { active: number; byLevel: Record<string, number>; bySource: Record<string, number> };
    fireDanger: { highestToday: string; highestTomorrow: string; bansToday: number; bansTomorrow: number; updatedAt: string | null; available: boolean };
    weather: { warnings: number; stations: number; latestObservation: string | null };
    transport: { closures: number; available: boolean };
    power: { outages: number; customers: number; available: boolean };
    air: { worstCategory: string | null; sites: number; latestObservation: string | null };
    hotspots: { last24h: number };
    earthquakes: { last7d: number; largest: number | null };
    changes24h: number;
    staleSources: number;
    activeSources: number;
}

export interface CentreShell {
    canManage: boolean;
    ingestionOn: boolean;
    wallboardOn: boolean;
    emailOn: boolean;
    aiAvailable: boolean;
    preferences: CentrePreferences;
    preferencesVersion: number;
    unacknowledgedAlerts: number;
    fixtureData: boolean;
}

export const CENTRE_HAZARD_TABS = ["weather", "fire-danger", "flood", "transport", "environment", "infrastructure"] as const;
export type CentreHazardTab = (typeof CENTRE_HAZARD_TABS)[number];

export type CentreRoute =
    | ({ route: "centre-overview" } & CentreShell & {
              summary: CentreSummary;
              recentWarnings: CentreRecord[];
              changes: CentreChange[];
              sources: SourceHealth[];
              watches: WatchArea[];
              alerts: CentreAlert[];
              briefing: CentreBriefing;
              correlations: Correlation[];
          })
    | ({ route: "centre-map" } & CentreShell & { records: CentreRecord[]; watches: WatchArea[]; truncated: boolean; basemap: CentreSettings["basemap"] })
    | ({ route: "centre-records" } & CentreShell & {
              records: CentreRecord[];
              /** Why each record concerns the chosen watch area (empty without one). */
              reasons: Record<string, string>;
              truncated: boolean;
              filters: RecordFilters;
              watches: WatchArea[];
          })
    | ({ route: "centre-record" } & CentreShell & {
              record: CentreRecord;
              changes: CentreChange[];
              series: { metric: string; points: { at: string; value: number }[] }[];
              related: Correlation[];
              source: SourceHealth;
              geometry: unknown | null;
          })
    | ({ route: "centre-hazards" } & CentreShell & {
              tab: CentreHazardTab;
              records: CentreRecord[];
              fireDanger: WallboardPayload["fireDanger"];
              sources: SourceHealth[];
              series: { recordId: string; metric: string; points: { at: string; value: number }[] }[];
          })
    | ({ route: "centre-history" } & CentreShell & {
              changes: CentreChange[];
              days: { date: string; count: number }[];
              runs: FetchRun[];
              range: "24h" | "7d" | "30d";
          })
    | ({ route: "centre-briefings" } & CentreShell & { briefing: CentreBriefing; watches: WatchArea[]; correlations: Correlation[] })
    | ({ route: "centre-watches" } & CentreShell & { watches: WatchArea[]; districts: string[]; alerts: CentreAlert[] })
    | ({ route: "centre-wallboards" } & CentreShell & { wallboards: Wallboard[]; watches: WatchArea[] })
    | ({ route: "centre-sources" } & CentreShell & { sources: SourceHealth[]; runs: FetchRun[] })
    | ({ route: "centre-settings" } & CentreShell & {
              settings: CentreSettings;
              settingsVersion: number;
              airSites: { id: number; name: string; region: string }[];
          });

// --- Today -----------------------------------------------------------------------------------------

export interface TodayCentreItem {
    id: string;
    title: string;
    detail: string | null;
    url: string;
    kind: "warning" | "incident" | "fire_danger" | "disruption" | "calendar";
    rank: number;
}

export interface TodayCentre {
    items: TodayCentreItem[];
    alerts: number;
    watches: number;
    staleNote: string | null;
}

export interface RecordFilters {
    q: string;
    category: HazardCategory | null;
    kind: RecordKind | null;
    source: string | null;
    minLevel: number;
    watch: string | null;
    includeInactive: boolean;
}
