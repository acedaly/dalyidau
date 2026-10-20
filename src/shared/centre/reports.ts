// Situation reports (docs/INTELLIGENCE_CENTRE_9_1.md#situation-reports): deterministic, sectioned,
// evidence-linked reports for NSW, a watch area, a region, one incident, a hazard or a past period.
// Each fact is one sentence built from stored records, with its source, its own time and a link;
// an AI narrative is optional, built only from those facts, and labelled as interpretation.
import { z } from "zod";
import { REGION_IDS } from "./regions";
import { HAZARD_CATEGORIES } from "./sources";
import type { BriefingFact } from "./types";

export const reportScopeSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("nsw") }).strict(),
    z.object({ kind: z.literal("watch"), watchId: z.string().regex(/^icw_[a-z0-9]{14}$/, "Choose one of your watch areas") }).strict(),
    z.object({ kind: z.literal("region"), region: z.enum(REGION_IDS) }).strict(),
    z.object({ kind: z.literal("incident"), recordId: z.string().regex(/^icr_[a-z0-9]{14}$/, "Not a valid record") }).strict(),
    z.object({ kind: z.literal("hazard"), category: z.enum(HAZARD_CATEGORIES), region: z.enum(REGION_IDS).default("nsw") }).strict(),
]);
export type ReportScope = z.output<typeof reportScopeSchema>;

export const reportRequestSchema = z
    .object({
        scope: reportScopeSchema,
        /** The end of the period (null: now). A past time is reported as the Centre knew it then. */
        at: z.iso.datetime({ offset: true }).nullable().default(null),
        /** How far back changes are reported from. */
        periodHours: z.number().int().min(1).max(744).default(24),
        title: z.string().trim().max(160).optional(),
        /** Ask Daly Intelligence for a readable narrative of the facts (if it's switched on). */
        narrative: z.boolean().default(false),
    })
    .strict();
export type ReportRequest = z.output<typeof reportRequestSchema>;

export const REPORT_SECTIONS = [
    { key: "overview", title: "Situation overview" },
    { key: "warnings", title: "Official warnings" },
    { key: "incidents", title: "Current incidents" },
    { key: "changes", title: "Significant recent changes" },
    { key: "fire_danger", title: "Fire danger" },
    { key: "weather", title: "Weather and environmental observations" },
    { key: "water", title: "Flood and water information" },
    { key: "transport", title: "Transport and infrastructure disruptions" },
    { key: "correlations", title: "Potential cross-source relationships" },
    { key: "gaps", title: "Source health and information gaps" },
    { key: "sources", title: "Sources and collection times" },
] as const;
export type ReportSectionKey = (typeof REPORT_SECTIONS)[number]["key"];

export interface ReportFact extends BriefingFact {
    nature: "official" | "observed" | "derived" | "collection";
}

export interface ReportSection {
    key: ReportSectionKey;
    title: string;
    facts: ReportFact[];
    /** Said when a section is empty, so an empty section never reads as "nothing happening". */
    empty: string | null;
}

export interface SituationReport {
    id: string | null;
    title: string;
    scope: ReportScope;
    scopeLabel: string;
    at: string;
    periodFrom: string;
    generatedAt: string;
    /** True when the report describes a past moment from stored history. */
    historical: boolean;
    sections: ReportSection[];
    sources: { sourceId: string; provider: string; dataset: string; status: string; lastSuccessAt: string | null; attribution: string }[];
    limitations: string[];
    narrative: { status: "off" | "not_requested" | "ready" | "unavailable" | "budget"; items: { text: string; refs: string[] }[]; model: string | null };
    fingerprint: string;
}

export interface ReportSummary {
    id: string;
    title: string;
    scope: ReportScope;
    periodFrom: string | null;
    periodTo: string;
    generatedAt: string;
    facts: number;
    trigger: "manual" | "schedule" | "mcp";
    scheduleId: string | null;
    knowledgeObjectId: string | null;
    hasNarrative: boolean;
}

export const scheduleInputSchema = z
    .object({
        name: z.string().trim().min(1).max(80),
        scope: reportScopeSchema,
        frequency: z.enum(["daily", "weekly"]),
        /** 0 Sunday … 6 Saturday, for weekly reports. */
        weekday: z.number().int().min(0).max(6).nullable().default(null),
        hour: z.number().int().min(0).max(23),
        timeZone: z.string().max(60).default("Australia/Sydney"),
        periodHours: z.number().int().min(1).max(744).default(24),
        notify: z.enum(["none", "in_app", "email"]).default("in_app"),
        saveToKnowledge: z.boolean().default(false),
        narrative: z.boolean().default(false),
        enabled: z.boolean().default(true),
    })
    .strict()
    .refine((s) => s.frequency === "daily" || s.weekday !== null, { message: "Choose a day for a weekly report", path: ["weekday"] });
export type ScheduleInput = z.output<typeof scheduleInputSchema>;

export const MAX_SCHEDULES = 10;

export interface ReportSchedule extends ScheduleInput {
    id: string;
    version: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastReportId: string | null;
    createdAt: string;
    updatedAt: string;
}
