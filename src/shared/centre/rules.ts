// Monitoring rules (docs/INTELLIGENCE_CENTRE_9_1.md#monitoring-rules): a person's own conditions,
// evaluated deterministically after each collection. A rule names one of the person's watch areas
// for anything geographic (never new coordinates), states its units, and says what's official
// (a published warning level, a declared ban) and what's the person's own threshold (a gust speed,
// a river level). No model ever decides whether a rule matches.
import { z } from "zod";
import { HAZARD_CATEGORIES } from "./sources";

export const RULE_CONDITIONS = [
    "official_level",
    "fire_within",
    "road_on_corridor",
    "gauge_threshold",
    "wind_gust",
    "temperature",
    "total_fire_ban",
    "earthquake",
    "source_stale",
] as const;
export type RuleCondition = (typeof RULE_CONDITIONS)[number];

export interface ConditionMeta {
    label: string;
    description: string;
    /** "official": matches a level or declaration as the provider published it. "own": a threshold the person chose. */
    threshold: "official" | "own" | "operational";
    needsWatch: boolean;
}

export const CONDITION_META: Record<RuleCondition, ConditionMeta> = {
    official_level: {
        label: "Official warning at or above a level",
        description: "An official warning or incident at or above the Australian Warning System level you choose, in or within a distance of a watch area.",
        threshold: "official",
        needsWatch: true,
    },
    fire_within: {
        label: "Reported fire within a distance",
        description: "An official bush or grass fire incident within a distance of a watch area.",
        threshold: "own",
        needsWatch: true,
    },
    road_on_corridor: {
        label: "Road disruption on a corridor",
        description: "A road closure or hazard on one of your road corridors (or in another watch area).",
        threshold: "official",
        needsWatch: true,
    },
    gauge_threshold: {
        label: "River gauge crosses a level",
        description: "A river gauge's observed level above or below a level you choose, in metres.",
        threshold: "own",
        needsWatch: false,
    },
    wind_gust: {
        label: "Observed wind gust above a speed",
        description: "A weather station in a watch area records a gust at or above a speed you choose.",
        threshold: "own",
        needsWatch: true,
    },
    temperature: {
        label: "Observed temperature above or below",
        description: "A weather station in a watch area records a temperature at or above (or at or below) one you choose.",
        threshold: "own",
        needsWatch: true,
    },
    total_fire_ban: {
        label: "Total Fire Ban in a district",
        description: "The RFS lists a Total Fire Ban for a fire weather district today or tomorrow.",
        threshold: "official",
        needsWatch: false,
    },
    earthquake: {
        label: "Earthquake above a magnitude",
        description: "Geoscience Australia locates an earthquake at or above a magnitude within a distance of a watch area.",
        threshold: "own",
        needsWatch: true,
    },
    source_stale: {
        label: "Source out of date",
        description: "A source hasn't been retrieved successfully for longer than its expected refresh (or a time you choose).",
        threshold: "operational",
        needsWatch: false,
    },
};

const watchId = z.string().regex(/^icw_[a-z0-9]{14}$/, "Choose one of your watch areas");
const sourceId = z.string().regex(/^[a-z0-9-]{3,40}$/);

/** Converts a gust in the rule's unit to km/h (BoM observations are stored in km/h). */
export const gustKmh = (value: number, unit: "km/h" | "kn") => (unit === "kn" ? Math.round(value * 1.852 * 10) / 10 : value);

export const ruleDefinitionSchema = z.discriminatedUnion("condition", [
    z
        .object({
            condition: z.literal("official_level"),
            watchId,
            /** 1 Advice, 2 Watch and Act, 3 Emergency Warning (as published). */
            minLevel: z.number().int().min(1).max(3),
            radiusKm: z.number().min(0).max(100).default(0),
            unit: z.literal("km").default("km"),
            categories: z.array(z.enum(HAZARD_CATEGORIES)).max(HAZARD_CATEGORIES.length).default([]),
        })
        .strict(),
    z
        .object({
            condition: z.literal("fire_within"),
            watchId,
            radiusKm: z.number().min(1).max(100),
            unit: z.literal("km").default("km"),
            /** Only fires the RFS lists as not under control. */
            notUnderControlOnly: z.boolean().default(false),
        })
        .strict(),
    z.object({ condition: z.literal("road_on_corridor"), watchId, closuresOnly: z.boolean().default(false) }).strict(),
    z
        .object({
            condition: z.literal("gauge_threshold"),
            station: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/, "Use the gauge's station number, e.g. 410001"),
            direction: z.enum(["above", "below"]),
            threshold: z.number().min(-10).max(40),
            unit: z.literal("m"),
        })
        .strict(),
    z
        .object({
            condition: z.literal("wind_gust"),
            watchId,
            threshold: z.number().positive(),
            unit: z.enum(["km/h", "kn"]),
        })
        .strict()
        .refine((d) => gustKmh(d.threshold, d.unit) >= 10 && gustKmh(d.threshold, d.unit) <= 300, {
            message: "Choose a gust between 10 and 300 km/h (5 and 160 knots)",
            path: ["threshold"],
        }),
    z
        .object({
            condition: z.literal("temperature"),
            watchId,
            direction: z.enum(["above", "below"]),
            threshold: z.number().min(-20).max(55),
            unit: z.literal("°C"),
        })
        .strict(),
    z
        .object({
            condition: z.literal("total_fire_ban"),
            district: z.string().trim().min(1).max(80),
            when: z.enum(["today", "tomorrow", "either"]).default("either"),
        })
        .strict(),
    z
        .object({
            condition: z.literal("earthquake"),
            watchId,
            minMagnitude: z.number().min(0).max(10),
            radiusKm: z.number().min(1).max(3000),
            unit: z.literal("km").default("km"),
        })
        .strict(),
    z
        .object({
            condition: z.literal("source_stale"),
            sourceId,
            /** Null: the source's own expected limit. */
            minutes: z.number().int().min(15).max(10080).nullable().default(null),
        })
        .strict(),
]);
export type RuleDefinition = z.output<typeof ruleDefinitionSchema>;

export const ruleInputSchema = z
    .object({
        name: z.string().trim().min(1).max(80),
        definition: ruleDefinitionSchema,
        /** Only records or readings from this long ago count. */
        lookbackMinutes: z.number().int().min(15).max(10080).default(180),
        /** After a match notifies, further matches stay quiet this long (they're still recorded). */
        cooldownMinutes: z.number().int().min(0).max(10080).default(60),
        notify: z.enum(["none", "in_app", "email"]).default("in_app"),
        enabled: z.boolean().default(true),
    })
    .strict();
export type RuleInput = z.output<typeof ruleInputSchema>;

export const MAX_RULES = 40;

export interface MonitoringRule extends RuleInput {
    id: string;
    version: number;
    lastEvaluatedAt: string | null;
    lastMatchedAt: string | null;
    createdAt: string;
    updatedAt: string;
    matches7d: number;
}

export interface RuleMatch {
    id: string;
    ruleId: string;
    ruleName: string;
    at: string;
    recordId: string | null;
    sourceId: string | null;
    reason: string;
    observedValue: number | null;
    threshold: number | null;
    unit: string | null;
    /** The record's or reading's own time. */
    evidenceAt: string | null;
    notified: boolean;
    suppressed: "cooldown" | "rate_limit" | "disabled" | null;
    taskId: string | null;
    acknowledgedAt: string | null;
}

/** One hypothetical match when a rule is tested against stored history (nothing is written). */
export interface RuleTestMatch {
    at: string;
    recordId: string | null;
    reason: string;
    observedValue: number | null;
}

export interface RuleTestResult {
    from: string;
    to: string;
    matches: RuleTestMatch[];
    /** States and readings examined. */
    examined: number;
    notes: string[];
}
