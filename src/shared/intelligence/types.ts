// Daly Intelligence: what the Worker and the browser exchange (docs/INTELLIGENCE.md).
//
// Suggestion payloads are validated with these schemas twice: when a model proposes them (anything
// that doesn't fit is dropped, never repaired by guessing) and again when a person edits or approves
// one. Ids inside a payload are only ever ids the Worker itself put there after a membership check;
// approval re-checks every one of them.
import { z } from "zod";
import type { BriefingSection, FeatureKey, IntelligenceConfig, IntelligencePreferences } from "./config";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");
const plain = (max: number) =>
    z
        .string()
        .transform((v) =>
            v
                // eslint-disable-next-line no-control-regex
                .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
                .replace(/[ \t]+/g, " ")
                .trim(),
        )
        .pipe(z.string().max(max));
const title = (max: number) => plain(max).pipe(z.string().min(1, "Give it a title"));
const tagList = z.array(plain(50).pipe(z.string().min(1))).max(10);
const objectId = z.string().regex(/^kob_[a-z0-9]{14}$/);
const projectId = z.string().regex(/^tpj_[a-z0-9]{14}$/);
const spaceId = z.string().regex(/^ksp_[a-z0-9]{14}$/);
const suggestionId = z.string().regex(/^ais_[a-z0-9]{14}$/);

/** How sure the source is about a date: stated outright, worked out ("next Friday"), or not given. */
export const DATE_CERTAINTY = ["explicit", "inferred", "none"] as const;

export const SUGGESTION_KINDS = ["task", "project", "knowledge_object", "decision", "meeting_note", "tags", "link", "follow_up", "fact"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_KIND_LABELS: Record<SuggestionKind, string> = {
    task: "Task",
    project: "New project",
    knowledge_object: "Knowledge note",
    decision: "Decision",
    meeting_note: "Meeting record",
    tags: "Tags",
    link: "Link",
    follow_up: "Follow-up",
    fact: "Fact",
};

export const payloadSchemas = {
    task: z
        .object({
            title: title(300),
            description: plain(4000).default(""),
            dueDate: isoDate.nullable().default(null),
            /** What the source actually said about timing, e.g. "by Friday". */
            dueText: plain(120).nullable().default(null),
            dateCertainty: z.enum(DATE_CERTAINTY).default("none"),
            priority: z.number().int().min(1).max(4).default(4),
            /** An existing project the person can edit, or null for the Inbox. */
            projectId: projectId.nullable().default(null),
            /** Or a project suggestion from the same capture, created first when approved together. */
            projectSuggestionId: suggestionId.nullable().default(null),
            labels: tagList.default([]),
            /** Named in the source as responsible. Never resolved to a person automatically. */
            owner: plain(120).nullable().default(null),
            knowledgeObjectIds: z.array(objectId).max(5).default([]),
        })
        .strict(),
    follow_up: z
        .object({
            title: title(300),
            waitingOn: plain(120).nullable().default(null),
            dueDate: isoDate.nullable().default(null),
            dueText: plain(120).nullable().default(null),
            dateCertainty: z.enum(DATE_CERTAINTY).default("none"),
            projectId: projectId.nullable().default(null),
            knowledgeObjectIds: z.array(objectId).max(5).default([]),
        })
        .strict(),
    project: z
        .object({
            name: title(120),
            description: plain(2000).default(""),
            kind: z.enum(["personal", "shared"]).default("personal"),
            /** Existing projects with a similar name, so the reviewer can choose one instead. */
            similarProjectIds: z.array(projectId).max(5).default([]),
        })
        .strict(),
    knowledge_object: z
        .object({
            spaceId,
            typeSlug: z.enum(["page", "resource", "area", "person", "project"]).default("page"),
            title: title(300),
            text: plain(20_000).default(""),
            tags: tagList.default([]),
        })
        .strict(),
    decision: z
        .object({
            spaceId,
            title: title(300),
            text: plain(10_000).default(""),
            decidedOn: isoDate.nullable().default(null),
            tags: tagList.default([]),
        })
        .strict(),
    meeting_note: z
        .object({
            spaceId,
            title: title(300),
            /** The summary written for this meeting (generated commentary). */
            summary: plain(20_000).default(""),
            date: isoDate.nullable().default(null),
            /** Append the transcript (source text) under the summary. */
            includeTranscript: z.boolean().default(true),
            tags: tagList.default([]),
        })
        .strict(),
    tags: z.object({ objectId, tags: tagList.pipe(z.array(z.string()).min(1)) }).strict(),
    link: z
        .object({
            sourceObjectId: objectId,
            targetObjectId: objectId,
            relationType: z.enum(["related", "mentions", "duplicate_of", "supports"]).default("related"),
        })
        .strict(),
    fact: z
        .object({
            statement: title(1000),
            /** Add it to this object, or to a new note in the capture's space. */
            objectId: objectId.nullable().default(null),
            spaceId: spaceId.nullable().default(null),
        })
        .strict(),
} satisfies Record<SuggestionKind, z.ZodType>;

export type SuggestionPayload<K extends SuggestionKind = SuggestionKind> = z.output<(typeof payloadSchemas)[K]>;

export type SuggestionStatus = "pending" | "applying" | "applied" | "dismissed" | "failed";

export interface SuggestionView {
    id: string;
    kind: SuggestionKind;
    status: SuggestionStatus;
    payload: SuggestionPayload;
    reason: string | null;
    /** A short quote from the source this came from. */
    evidence: string | null;
    confidence: number | null;
    dependsOn: string | null;
    capture: { id: string; title: string; source: CaptureSource } | null;
    /** Names for the ids in the payload, resolved through the reviewer's own access. */
    labels: Record<string, string>;
    result: { type: string; id: string; url: string } | null;
    errorCode: string | null;
    version: number;
    createdAt: string;
    decidedAt: string | null;
}

export type CaptureSource = "text" | "document" | "audio" | "knowledge" | "mcp" | "app";
export type CaptureStatus = "received" | "extracting" | "transcribing" | "analysing" | "ready" | "failed" | "cancelled";

export interface CaptureSummary {
    id: string;
    title: string;
    source: CaptureSource;
    status: CaptureStatus;
    errorCode: string | null;
    spaceId: string | null;
    pending: number;
    createdAt: string;
    updatedAt: string;
    job: JobView | null;
}

export interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
}

export interface CaptureDetail extends CaptureSummary {
    /** The source text as captured, extracted or transcribed. */
    text: string | null;
    textTruncated: boolean;
    /** Generated commentary, kept apart from the source. */
    summary: string | null;
    language: string | null;
    sourceObject: { id: string; title: string } | null;
    attachment: AttachmentView | null;
    transcript: {
        model: string;
        language: string | null;
        durationSeconds: number | null;
        chunksDone: number;
        chunksTotal: number;
        segments: TranscriptSegment[];
    } | null;
    suggestions: SuggestionView[];
}

export type JobStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";

export interface JobView {
    id: string;
    kind: string;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    progress: { step?: string; done?: number; total?: number } | null;
    estimateNeurons: number | null;
    errorCode: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface AttachmentView {
    id: string;
    filename: string;
    contentType: string;
    bytes: number;
    purpose: "knowledge" | "task" | "processing";
    retention: "permanent" | "referenced" | "temporary";
    keep: boolean;
    status: "uploading" | "stored" | "processed" | "failed" | "deleted";
    purgeAfter: string | null;
    objectId: string | null;
    createdAt: string;
}

// --- Briefings -----------------------------------------------------------------------------------

export interface BriefingItem {
    id: string;
    title: string;
    url: string;
    /** e.g. "Due today", "3 days overdue", "Health: at risk". */
    detail?: string;
    kind: "task" | "project" | "goal" | "knowledge" | "routine" | "event" | "leave";
}

export interface BriefingFactSection {
    key: BriefingSection | "completed" | "at_risk" | "stale" | "milestones" | "housekeeping";
    title: string;
    count: number;
    items: BriefingItem[];
}

export interface Recommendation {
    text: string;
    /** Records the recommendation is about; each is one of the briefing's own facts. */
    refs: { id: string; title: string; url: string }[];
}

export interface BriefingView {
    kind: "daily" | "weekly";
    period: string;
    generatedAt: string;
    /** What was read, and what never was: a briefing never implies it looked at email or a calendar. */
    checked: { tasks: boolean; knowledge: boolean; calendar?: boolean };
    notChecked: string[];
    sections: BriefingFactSection[];
    recommendations: { status: "off" | "not_requested" | "ready" | "unavailable" | "budget"; items: Recommendation[]; model: string | null };
    changesSincePrevious: { previousPeriod: string | null; added: number; resolved: number } | null;
}

// --- Semantic search -----------------------------------------------------------------------------

export interface HybridHit {
    object: { id: string; spaceId: string; title: string; typeId: string; status: string; updatedAt: string; tags: string[] };
    /** A passage from the object itself, read after the access check. */
    excerpt: string;
    /** Highlighted by FTS when the keyword index matched. */
    titleSnippet: string | null;
    score: number;
    matchedBy: ("keyword" | "meaning")[];
    url: string;
}

export interface HybridSearchResult {
    hits: HybridHit[];
    /** "hybrid" when meaning was used; "keyword" when it was off, unavailable or over budget. */
    mode: "hybrid" | "keyword";
    fallbackReason: string | null;
}

// --- Status and usage ------------------------------------------------------------------------------

export interface UsageTotals {
    neurons: number;
    estimatedUsd: number;
    calls: number;
    failures: number;
}

export interface UsageSummary {
    day: string;
    month: string;
    today: UsageTotals;
    thisMonth: UsageTotals;
    /** The viewer's own calls today. */
    mine: UsageTotals;
    byFeature: { feature: string; neurons: number; calls: number }[];
    byModel: { model: string; neurons: number; calls: number; inputUnits: number; outputUnits: number }[];
    last14Days: { day: string; neurons: number }[];
    budgets: { dailyNeurons: number; monthlyNeurons: number; perUserDailyNeurons: number; features: Record<string, number> };
    alerts: { scope: string; threshold: number; period: string }[];
    freeNeuronsPerDay: number;
    pricingAsOf: string;
}

export interface IntelligenceStatus {
    features: Record<FeatureKey, boolean>;
    /** Whether each Cloudflare binding is present on this Worker. */
    bindings: { ai: boolean; vectors: boolean; gateway: boolean };
    /** The effective state per capability: on only when switched on and its binding exists. */
    available: { semantic: boolean; capture: boolean; documents: boolean; meetings: boolean; recommendations: boolean; scheduled: boolean };
    circuitOpen: boolean;
    index: { indexed: number; failed: number; pending: number; spaces: number } | null;
}

export interface StorageSummary {
    totals: { purpose: string; retention: string; files: number; bytes: number }[];
    purgeDue: number;
    attachments: AttachmentView[];
}

export interface IntelligenceShell {
    status: IntelligenceStatus;
    pendingSuggestions: number;
    canManage: boolean;
}

export type IntelligenceRoute =
    | (IntelligenceShell & {
          route: "intelligence-home";
          briefing: BriefingView | null;
          suggestions: SuggestionView[];
          captures: CaptureSummary[];
          usage: UsageSummary;
      })
    | (IntelligenceShell & { route: "intelligence-inbox"; suggestions: SuggestionView[]; filter: "pending" | "applied" | "dismissed" | "all" })
    | (IntelligenceShell & {
          route: "intelligence-capture";
          captures: CaptureSummary[];
          spaces: { id: string; name: string; kind: "personal" | "shared"; role: string }[];
          limits: IntelligenceConfig["limits"];
          prefillObject: { id: string; title: string } | null;
      })
    | (IntelligenceShell & { route: "intelligence-capture-detail"; capture: CaptureDetail })
    | (IntelligenceShell & { route: "intelligence-briefing"; kind: "daily" | "weekly"; briefing: BriefingView })
    | (IntelligenceShell & {
          route: "intelligence-meetings";
          captures: CaptureSummary[];
          limits: IntelligenceConfig["limits"];
          spaces: { id: string; name: string }[];
      })
    | (IntelligenceShell & {
          route: "intelligence-settings";
          config: IntelligenceConfig;
          configVersion: number;
          preferences: IntelligencePreferences;
          preferencesVersion: number;
          usage: UsageSummary;
          storage: StorageSummary;
          spaces: { id: string; name: string; kind: "personal" | "shared"; role: string; excluded: boolean }[];
      });
