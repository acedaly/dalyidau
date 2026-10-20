// Timelines, replay, the change feed and analytics (docs/INTELLIGENCE_CENTRE_9_1.md#history).
//
// Everything here describes what the Centre actually collected and when. A timeline event is
// labelled by what it is: official (the provider published it), observed (a measurement or
// detection), derived (worked out here, such as a correlation) or collection (about the Centre's
// own collecting: first seen, source outages). Replay shows only what was stored at the moment
// chosen; it never fills the past in with what was learnt later.
import type { HazardCategory } from "./sources";
import type { CentreChange, ChangeKind, Correlation, RecordKind, RecordMetric } from "./types";

// --- Significance ----------------------------------------------------------------------------------

/**
 * Whether a change is worth someone's attention, or routine. Deterministic, from the change's kind,
 * category and the provider's own level. Routine changes stay in the feed; they don't alert.
 */
export function isSignificant(change: Pick<CentreChange, "kind" | "category" | "severityRank" | "toValue">): boolean {
    switch (change.kind) {
        case "escalated":
        case "ban_declared":
        case "geometry_changed":
        case "source_failed":
        case "source_stale":
        case "source_recovered":
        case "reappeared":
            return true;
        case "new":
            // A new official warning or levelled incident, a road closure, an outage; not every minor incident.
            return change.severityRank >= 1 || change.category === "flood" || change.category === "weather" || change.category === "transport" || change.category === "power";
        case "rating_changed":
            return change.severityRank >= 2;
        case "measurement_change":
            return true;
        case "downgraded":
        case "ended":
            return change.severityRank >= 1 || change.category === "transport";
        default:
            return false;
    }
}

/** A plainer label for a change in the feed, from its kind and what it's about. */
export function feedLabel(change: Pick<CentreChange, "kind" | "category">): string {
    const transport = change.category === "transport";
    const power = change.category === "power";
    switch (change.kind) {
        case "new":
            return transport ? "New road closure or hazard" : power ? "New power outage" : change.category === "fire_danger" ? "Rating published" : "New official record";
        case "ended":
            return transport ? "Road reopened or hazard cleared (as the provider marked it)" : power ? "Outage marked restored" : "Provider marked it ended";
        case "escalated":
            return "Official warning escalated";
        case "downgraded":
            return "Official warning downgraded";
        case "geometry_changed":
            return "Published area changed";
        case "rating_changed":
            return "Fire danger rating changed";
        case "ban_declared":
            return "Total Fire Ban declared";
        case "ban_lifted":
            return "Total Fire Ban no longer listed";
        case "measurement_change":
            return "Material change in a measurement (observed)";
        case "not_in_feed":
            return "No longer in the feed (not confirmed resolved)";
        case "reappeared":
            return "Back in the feed";
        case "source_failed":
            return "Source failed";
        case "source_stale":
            return "Source out of date";
        case "source_recovered":
            return "Source recovered";
        default:
            return "Updated";
    }
}

export const FEED_CHANGE_GROUPS: { id: string; label: string; kinds: ChangeKind[] }[] = [
    { id: "new", label: "New incidents and warnings", kinds: ["new", "reappeared"] },
    { id: "escalation", label: "Escalations and downgrades", kinds: ["escalated", "downgraded"] },
    { id: "area", label: "Changed published areas", kinds: ["geometry_changed"] },
    { id: "fire_danger", label: "Fire danger and Total Fire Bans", kinds: ["rating_changed", "ban_declared", "ban_lifted"] },
    { id: "ended", label: "Ended, reopened or no longer listed", kinds: ["ended", "not_in_feed"] },
    { id: "measurement", label: "Environmental measurements", kinds: ["measurement_change"] },
    { id: "source", label: "Source failures and recovery", kinds: ["source_failed", "source_stale", "source_recovered"] },
    { id: "updated", label: "Other updates", kinds: ["updated"] },
];

export interface FeedChange extends CentreChange {
    label: string;
    significant: boolean;
    provider: string;
    /** The record's level as it is now (the change's own from/to values say what it was). */
    level: string | null;
    sourceUrl: string | null;
    areaName: string | null;
}

export interface FeedFilters {
    hazard: HazardCategory | null;
    region: string | null;
    watch: string | null;
    from: string;
    to: string;
    minLevel: number;
    source: string | null;
    group: string | null;
    significance: "significant" | "all";
}

// --- Timelines -------------------------------------------------------------------------------------

export type TimelineNature = "official" | "observed" | "derived" | "collection";

export interface TimelineEvent {
    at: string;
    /** For collection events, when the Centre stored it; for official ones, the provider's own time. */
    kind:
        | "first_seen"
        | "published"
        | "provider_update"
        | "level_change"
        | "status_change"
        | "area_change"
        | "ended"
        | "not_in_feed"
        | "reappeared"
        | "baseline"
        | "observation"
        | "road"
        | "detection"
        | "correlation"
        | "source_gap"
        | "change";
    nature: TimelineNature;
    label: string;
    detail: string;
    recordId: string | null;
    sourceId: string | null;
    /** The provider's link for official events. */
    sourceUrl: string | null;
    /** When the Centre collected it (official events show both times). */
    collectedAt: string | null;
}

export interface RecordTimeline {
    recordId: string;
    title: string;
    events: TimelineEvent[];
    /** True when the record was already in the feed when versioning began, so its earlier history wasn't recorded. */
    startsAtBaseline: boolean;
    historyFrom: string | null;
    notes: string[];
}

export interface SituationTimeline {
    scopeLabel: string;
    from: string;
    to: string;
    events: TimelineEvent[];
    truncated: boolean;
    notes: string[];
}

// --- Replay ----------------------------------------------------------------------------------------

/** A record as it was stored at one moment (from its version, never from later collections). */
export interface ReplayRecord {
    id: string;
    versionSeq: number;
    sourceId: string;
    provider: string;
    kind: RecordKind;
    category: HazardCategory;
    title: string;
    status: string | null;
    warningLevel: string | null;
    severityRank: number;
    lat: number | null;
    lon: number | null;
    areaName: string | null;
    publishedAt: string | null;
    updatedAt: string | null;
    observedAt: string | null;
    active: boolean;
    missing: boolean;
    baseline: boolean;
    validFrom: string;
    validTo: string | null;
    sourceUrl: string | null;
    metrics: RecordMetric[];
    attributes: Record<string, string>;
    fixture: boolean;
}

export interface ReplaySourceState {
    sourceId: string;
    dataset: string;
    provider: string;
    /** What was known about the source at that moment. */
    state: "current" | "stale" | "not_collected" | "before_history" | "unknown";
    lastSuccessBefore: string | null;
    note: string;
}

export interface ReplayFrame {
    at: string;
    records: ReplayRecord[];
    map: { type: "FeatureCollection"; features: unknown[] };
    sources: ReplaySourceState[];
    truncated: boolean;
    /** Limits that apply to this moment: before history began, retention, outages. */
    notes: string[];
    historyStartedAt: string | null;
}

export interface ReplayMeta {
    historyStartedAt: string | null;
    oldestRetained: string | null;
    /** Moments where something changed, for the scrubber (bounded). */
    steps: { at: string; changes: number }[];
    truncated: boolean;
    gaps: { sourceId: string; from: string; to: string }[];
    retentionDays: number;
    recording: boolean;
}

export interface ReplayComparison {
    a: string;
    b: string;
    added: ReplayRecord[];
    removed: ReplayRecord[];
    changed: { before: ReplayRecord; after: ReplayRecord; fields: string[] }[];
    unchanged: number;
    notes: string[];
}

// --- Analytics -------------------------------------------------------------------------------------

export interface AnalyticsSeries {
    key: string;
    label: string;
    points: { date: string; value: number }[];
}

export interface CentreAnalytics {
    range: { from: string; to: string; days: number };
    computedAt: string;
    /** New official records per day, by category (as collected). */
    newRecords: AnalyticsSeries[];
    /** Escalations and downgrades per day. */
    transitions: AnalyticsSeries[];
    byCategory: { category: HazardCategory; label: string; count: number }[];
    byRegion: { region: string; label: string; count: number }[];
    byEventType: { eventType: string; count: number }[];
    significantChanges: AnalyticsSeries;
    rivers: { recordId: string; label: string; points: { at: string; value: number }[] }[];
    weather: AnalyticsSeries[];
    sources: SourceReliability[];
    /** Plain statements of what these numbers are and aren't. */
    caveats: string[];
    coverage: { sourceId: string; dataset: string; daysCollected: number; daysInRange: number }[];
}

export interface SourceReliability {
    sourceId: string;
    provider: string;
    dataset: string;
    days: { date: string; attempts: number; ok: number; errors: number; availability: number | null; avgMs: number | null; delayS: number | null; recordsMax: number; longestGapMinutes: number }[];
    availability: number | null;
    avgMs: number | null;
    avgDelayS: number | null;
    maxDelayS: number | null;
    consecutiveFailures: number;
    lastValidatedAt: string | null;
    longestGapMinutes: number;
}

export type { Correlation };
