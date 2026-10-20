// The Intelligence Centre assistant (docs/INTELLIGENCE_CENTRE_9_1.md#assistant): questions answered
// from stored records through a fixed set of analytical tools. Without AI it understands questions
// by their words; with Daly Intelligence on, a model chooses the tool and writes the answer from the
// tool's facts only, every sentence citing them.
import { z } from "zod";
import type { ReportFact } from "./reports";

export const ASSISTANT_TOOLS = [
    "watch_changes",
    "current_warnings",
    "escalations",
    "river_trends",
    "roads_near_incidents",
    "observations_for_record",
    "compare_dates",
    "incident_development",
    "data_gaps",
] as const;
export type AssistantTool = (typeof ASSISTANT_TOOLS)[number];

export const ASSISTANT_TOOL_LABELS: Record<AssistantTool, string> = {
    watch_changes: "What changed (in a watch area or NSW)",
    current_warnings: "Official warnings in force",
    escalations: "Escalated records",
    river_trends: "River level trends",
    roads_near_incidents: "Road disruptions near followed incidents",
    observations_for_record: "Observations around a warning or incident",
    compare_dates: "Compare two moments",
    incident_development: "How an incident developed",
    data_gaps: "Missing or stale information",
};

export const assistantRequestSchema = z
    .object({
        question: z
            .string()
            .trim()
            .min(3, "Ask a question")
            .max(500, "Keep the question under 500 characters")
            // Control characters are never part of a question.
            .transform((q) => q.replace(/[\u0000-\u001f\u007f]/g, " ")),
        /** Context from the page the question was asked on. */
        watchId: z
            .string()
            .regex(/^icw_[a-z0-9]{14}$/)
            .nullable()
            .default(null),
        recordId: z
            .string()
            .regex(/^icr_[a-z0-9]{14}$/)
            .nullable()
            .default(null),
    })
    .strict();
export type AssistantRequest = z.output<typeof assistantRequestSchema>;

export interface AssistantAnswer {
    question: string;
    tool: AssistantTool;
    toolLabel: string;
    /** "ai": a model chose the tool and wrote the answer from its facts. "rules": understood from its words, answered with the facts. */
    mode: "ai" | "rules";
    /** What was looked at: scope, period, record. */
    looked: string[];
    lead: string;
    facts: ReportFact[];
    answer: { status: "ready" | "off" | "unavailable" | "budget" | "rules"; items: { text: string; refs: string[] }[]; model: string | null };
    freshness: { sourceId: string; dataset: string; status: string; lastSuccessAt: string | null }[];
    limitations: string[];
}

export const ASSISTANT_EXAMPLES = [
    "What changed in my watch area over the past 24 hours?",
    "What official warnings currently affect this region?",
    "Which recorded incidents escalated today?",
    "Have river observations changed significantly this week?",
    "Are any road disruptions near the incidents I'm following?",
    "What information is missing or stale?",
    "Compare recorded activity between 2026-10-18 and 2026-10-19",
];
