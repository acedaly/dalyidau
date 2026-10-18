// Daly Intelligence configuration, shared by the Worker and the browser (docs/INTELLIGENCE.md).
//
// Everything is off by default. The account-wide document (ai_config) holds the feature switches,
// the model for each kind of work, budgets, processing limits and retention; each person's own
// choices live in ai_preferences. Both are validated here, on every read and every write, so a
// hand-edited row can never switch on something it shouldn't.
//
// Prices are Cloudflare's published Workers AI rates as of 15 October 2026 (developers.cloudflare.com
// /workers-ai/platform/pricing). They are estimates for planning and for the application's own
// budgets. They are not a billing cap: Cloudflare bills what it measures, and its rates and free
// allocation can change.
import { z } from "zod";

/** Workers AI bills in Neurons: $0.011 per 1,000 beyond the free daily allocation. */
export const USD_PER_NEURON = 0.011 / 1000;
/** Cloudflare's free allocation, per account per day (UTC). Subject to change by Cloudflare. */
export const FREE_NEURONS_PER_DAY = 10_000;
export const PRICING_AS_OF = "2026-10-15";

export type ModelTask = "text" | "embed" | "transcribe" | "document";

export interface ModelInfo {
    id: string;
    task: ModelTask;
    label: string;
    /** Size class, for choosing: small models for tags and classification, capable ones for synthesis. */
    tier: "small" | "standard" | "capable";
    /** Neurons per million input and output tokens (text and embeddings). */
    inputNeuronsPerM?: number;
    outputNeuronsPerM?: number;
    /** Neurons per audio minute (speech recognition). */
    neuronsPerAudioMinute?: number;
    /** Embedding size; must match the Vectorize index. */
    dimensions?: number;
    /** Longest input the model takes, in tokens (embeddings) or characters of context we send (text). */
    maxInputTokens?: number;
    notes: string;
}

export const MODELS: readonly ModelInfo[] = [
    {
        id: "@cf/meta/llama-3.2-3b-instruct",
        task: "text",
        label: "Llama 3.2 3B Instruct",
        tier: "small",
        inputNeuronsPerM: 4625,
        outputNeuronsPerM: 30475,
        notes: "Cheapest useful text model. Good for tags and yes/no classification; weaker at structured extraction.",
    },
    {
        id: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
        task: "text",
        label: "Llama 3.1 8B Instruct (fp8, fast)",
        tier: "small",
        inputNeuronsPerM: 4119,
        outputNeuronsPerM: 34868,
        notes: "Small and fast. Adequate for short summaries and simple extraction.",
    },
    {
        id: "@cf/google/gemma-4-26b-a4b-it",
        task: "text",
        label: "Gemma 4 26B A4B",
        tier: "standard",
        inputNeuronsPerM: 9091,
        outputNeuronsPerM: 27273,
        notes: "Default for extraction and summaries: mixture-of-experts, strong JSON adherence for its price.",
    },
    {
        id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
        task: "text",
        label: "Mistral Small 3.1 24B",
        tier: "standard",
        inputNeuronsPerM: 31876,
        outputNeuronsPerM: 50488,
        notes: "Alternative standard model with a long context window.",
    },
    {
        id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        task: "text",
        label: "Llama 3.3 70B Instruct (fp8, fast)",
        tier: "capable",
        inputNeuronsPerM: 26668,
        outputNeuronsPerM: 204805,
        notes: "For detailed meeting summaries and multi-document synthesis. Output is expensive: keep it bounded.",
    },
    {
        id: "@cf/baai/bge-m3",
        task: "embed",
        label: "BGE-M3 (multilingual)",
        tier: "small",
        inputNeuronsPerM: 1075,
        dimensions: 1024,
        maxInputTokens: 512,
        notes: "Default embeddings: cheapest per token, multilingual, 1,024 dimensions.",
    },
    {
        id: "@cf/qwen/qwen3-embedding-0.6b",
        task: "embed",
        label: "Qwen3 Embedding 0.6B",
        tier: "small",
        inputNeuronsPerM: 1075,
        dimensions: 1024,
        maxInputTokens: 8192,
        notes: "Same size and price as BGE-M3 with a longer input. Switching models needs a full reindex.",
    },
    {
        id: "@cf/baai/bge-base-en-v1.5",
        task: "embed",
        label: "BGE Base (English)",
        tier: "small",
        inputNeuronsPerM: 6058,
        dimensions: 768,
        maxInputTokens: 512,
        notes: "English only, 768 dimensions: needs its own Vectorize index.",
    },
    {
        id: "@cf/openai/whisper-large-v3-turbo",
        task: "transcribe",
        label: "Whisper Large v3 Turbo",
        tier: "standard",
        // $0.000513 per audio minute.
        neuronsPerAudioMinute: 46.64,
        notes: "Default speech-to-text: language detection, timestamps per segment. No speaker diarisation.",
    },
    {
        id: "@cf/openai/whisper",
        task: "transcribe",
        label: "Whisper",
        tier: "small",
        // $0.000453 per audio minute.
        neuronsPerAudioMinute: 41.18,
        notes: "Older, slightly cheaper and less accurate.",
    },
    {
        id: "workers-ai/tomarkdown",
        task: "document",
        label: "Workers AI Markdown Conversion",
        tier: "small",
        notes: "Text from PDF and Office documents. Images are refused before conversion, so no image model is ever called.",
    },
];

export const modelById = (id: string) => MODELS.find((m) => m.id === id);
const modelsFor = (task: ModelTask) => MODELS.filter((m) => m.task === task).map((m) => m.id) as [string, ...string[]];
const modelChoice = (task: ModelTask) => z.string().refine((id) => modelsFor(task).includes(id), "Choose a model from the list");

export const FEATURE_KEYS = ["enabled", "semanticSearch", "capture", "documents", "meetings", "briefingRecommendations", "scheduled"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_LABELS: Record<FeatureKey, { label: string; description: string }> = {
    enabled: {
        label: "Intelligence",
        description:
            "The master switch. While off, no model is called for anyone, scheduled processing stops and Tasks and Knowledge work exactly as before. Keyword search is unaffected.",
    },
    semanticSearch: {
        label: "Semantic search",
        description:
            "Index Knowledge by meaning (Workers AI embeddings in Vectorize, kept up to date by the cron) and blend it with keyword search. Needs the VECTORS binding.",
    },
    capture: { label: "Intelligent Capture", description: "Analyse pasted text and Knowledge objects into suggestions for review." },
    documents: { label: "Document intelligence", description: "Extract text from uploaded PDF, Word and text documents for capture and analysis." },
    meetings: { label: "Meeting intelligence", description: "Transcribe uploaded recordings and propose summaries, decisions and action items." },
    briefingRecommendations: {
        label: "AI briefing recommendations",
        description: "Add model-written suggestions to daily and weekly briefings. Facts are always shown without it.",
    },
    scheduled: {
        label: "Scheduled intelligence",
        description:
            "Prepare briefings (with recommendations, when those are on) at each person's preferred time, for people who saved briefing preferences and haven't paused them.",
    },
};

const neurons = z.number().int().min(0).max(10_000_000);

export const BUDGET_FEATURES = ["semantic", "capture", "documents", "meetings", "briefings"] as const;
export type BudgetFeature = (typeof BUDGET_FEATURES)[number];

export const intelligenceConfigSchema = z
    .object({
        features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<FeatureKey, z.ZodBoolean>).strict(),
        models: z
            .object({
                /** Tags, classification. */
                classify: modelChoice("text"),
                /** Tasks, decisions, dates and facts from text. */
                extract: modelChoice("text"),
                /** Short summaries and briefing recommendations. */
                summarise: modelChoice("text"),
                /** Detailed meeting summaries, multi-document synthesis. */
                synthesis: modelChoice("text"),
                embed: modelChoice("embed"),
                transcribe: modelChoice("transcribe"),
            })
            .strict(),
        budgets: z
            .object({
                /** Account-wide, per UTC day. Default stays inside Cloudflare's free allocation. */
                dailyNeurons: neurons,
                monthlyNeurons: neurons,
                /** Each person's own requests, per UTC day. */
                perUserDailyNeurons: neurons,
                /** Per feature, per UTC day. */
                features: z.object(Object.fromEntries(BUDGET_FEATURES.map((k) => [k, neurons])) as Record<BudgetFeature, typeof neurons>).strict(),
                /** Work estimated above this asks the person to confirm before it runs. */
                confirmAboveNeurons: neurons,
                /** Items one background pass may process (objects to embed, chunks to transcribe). */
                maxBatch: z.number().int().min(1).max(200),
                /** Percentages of a budget that raise an alert on the usage page. */
                alertThresholds: z.array(z.number().int().min(1).max(100)).max(5),
            })
            .strict(),
        limits: z
            .object({
                maxCaptureCharacters: z.number().int().min(1_000).max(200_000),
                /** Characters of source and context sent to a text model in one call. */
                maxContextCharacters: z.number().int().min(2_000).max(60_000),
                maxDocumentBytes: z.number().int().min(100_000).max(20_000_000),
                maxDocumentPages: z.number().int().min(1).max(300),
                maxAudioBytes: z.number().int().min(1_000_000).max(100_000_000),
                maxAudioMinutes: z.number().int().min(1).max(240),
                /** Seconds a single model call may take before it's abandoned. */
                callTimeoutSeconds: z.number().int().min(5).max(120),
            })
            .strict(),
        retention: z
            .object({
                /** Uploaded audio and documents, after successful processing. */
                temporaryDays: z.number().int().min(0).max(30),
                /** Files whose processing failed, kept for investigation. */
                failedDays: z.number().int().min(1).max(30),
                /** Task attachments, after the task they belong to is deleted. */
                unreferencedGraceDays: z.number().int().min(1).max(90),
                /** Stored briefings. */
                briefingDays: z.number().int().min(7).max(365),
                /** Captures and their suggestions once nothing is pending. */
                captureDays: z.number().int().min(7).max(3650),
            })
            .strict(),
        /** Dimensions of the Vectorize index (VECTORS). Must equal the embedding model's. */
        vectorDimensions: z.number().int().min(128).max(1536),
    })
    .strict()
    .superRefine((config, ctx) => {
        const embed = modelById(config.models.embed);
        if (embed?.dimensions && embed.dimensions !== config.vectorDimensions)
            ctx.addIssue({
                code: "custom",
                path: ["models", "embed"],
                message: `That model makes ${embed.dimensions}-dimension vectors; the index is ${config.vectorDimensions}. Create a matching index first.`,
            });
        if (config.budgets.perUserDailyNeurons > config.budgets.dailyNeurons)
            ctx.addIssue({ code: "custom", path: ["budgets", "perUserDailyNeurons"], message: "A person's limit can't be higher than the account's" });
        if (config.budgets.dailyNeurons > config.budgets.monthlyNeurons)
            ctx.addIssue({ code: "custom", path: ["budgets", "dailyNeurons"], message: "The daily limit can't be higher than the monthly one" });
    });

export type IntelligenceConfig = z.output<typeof intelligenceConfigSchema>;

/** Conservative defaults: everything off, cheap models, budgets inside the free daily allocation. */
export const DEFAULT_CONFIG: IntelligenceConfig = {
    features: { enabled: false, semanticSearch: false, capture: false, documents: false, meetings: false, briefingRecommendations: false, scheduled: false },
    models: {
        classify: "@cf/meta/llama-3.2-3b-instruct",
        extract: "@cf/google/gemma-4-26b-a4b-it",
        summarise: "@cf/google/gemma-4-26b-a4b-it",
        synthesis: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        embed: "@cf/baai/bge-m3",
        transcribe: "@cf/openai/whisper-large-v3-turbo",
    },
    budgets: {
        dailyNeurons: 9_000,
        monthlyNeurons: 270_000,
        perUserDailyNeurons: 5_000,
        features: { semantic: 3_000, capture: 3_000, documents: 1_500, meetings: 3_000, briefings: 1_500 },
        confirmAboveNeurons: 1_500,
        maxBatch: 25,
        alertThresholds: [50, 80, 100],
    },
    limits: {
        maxCaptureCharacters: 60_000,
        maxContextCharacters: 16_000,
        maxDocumentBytes: 10_000_000,
        maxDocumentPages: 60,
        maxAudioBytes: 50_000_000,
        maxAudioMinutes: 90,
        callTimeoutSeconds: 60,
    },
    retention: { temporaryDays: 7, failedDays: 14, unreferencedGraceDays: 30, briefingDays: 90, captureDays: 365 },
    vectorDimensions: 1024,
};

/** A stored document merged over the defaults, so a newer Worker always has every field. Invalid documents fall back to the defaults (fail closed: off). */
export function parseConfig(value: unknown): IntelligenceConfig {
    const stored = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof IntelligenceConfig, unknown>>;
    const merged = {
        ...DEFAULT_CONFIG,
        ...stored,
        features: { ...DEFAULT_CONFIG.features, ...(stored.features as object) },
        models: { ...DEFAULT_CONFIG.models, ...(stored.models as object) },
        budgets: {
            ...DEFAULT_CONFIG.budgets,
            ...(stored.budgets as object),
            features: { ...DEFAULT_CONFIG.budgets.features, ...((stored.budgets as { features?: object } | undefined)?.features ?? {}) },
        },
        limits: { ...DEFAULT_CONFIG.limits, ...(stored.limits as object) },
        retention: { ...DEFAULT_CONFIG.retention, ...(stored.retention as object) },
    };
    const parsed = intelligenceConfigSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

// --- Estimating cost ------------------------------------------------------------------------------

/** Rough token count for planning (about four characters a token for English). */
export const estimateTokens = (characters: number) => Math.ceil(characters / 4);

export function estimateTextNeurons(modelId: string, inputTokens: number, outputTokens: number): number {
    const model = modelById(modelId);
    if (!model) return 0;
    return ((model.inputNeuronsPerM ?? 0) * inputTokens + (model.outputNeuronsPerM ?? 0) * outputTokens) / 1_000_000;
}

export const estimateAudioNeurons = (modelId: string, seconds: number) => ((modelById(modelId)?.neuronsPerAudioMinute ?? 0) * seconds) / 60;

export const neuronsToUsd = (neurons: number) => neurons * USD_PER_NEURON;

// --- Personal preferences ------------------------------------------------------------------------

export const BRIEFING_SECTIONS = [
    "today",
    "overdue",
    "deadlines",
    "projects",
    "decisions",
    "follow_ups",
    "waiting",
    "household",
    "knowledge",
    "changes",
    "suggestions",
] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

export const BRIEFING_SECTION_LABELS: Record<BriefingSection, string> = {
    today: "Today's tasks",
    overdue: "Overdue commitments",
    deadlines: "Upcoming deadlines",
    projects: "Priority projects",
    decisions: "Recent decisions",
    follow_ups: "Outstanding follow-ups",
    waiting: "Waiting on others",
    household: "Household",
    knowledge: "Knowledge updates",
    changes: "Changes since last briefing",
    suggestions: "Suggested next actions",
};

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:30");

export const preferencesSchema = z
    .object({
        sections: z.array(z.enum(BRIEFING_SECTIONS)).max(BRIEFING_SECTIONS.length),
        mode: z.enum(["concise", "detailed"]),
        /** Personal only, or personal and the shared spaces and projects the person belongs to. */
        scope: z.enum(["personal", "all"]),
        dailyTime: clock,
        /** 0 = Sunday … 6 = Saturday. */
        weeklyDay: z.number().int().min(0).max(6),
        weeklyTime: clock,
        /** Show a "briefing ready" notice in the portal. Email is not sent (docs/INTELLIGENCE.md). */
        notifyInApp: z.boolean(),
        /** Stop preparing briefings ahead of time. Opening the page still shows today's facts. */
        paused: z.boolean(),
        /** Ask the model for recommendations, when the owner has switched them on. */
        recommendations: z.boolean(),
        /** Knowledge spaces left out of this person's briefings and recommendations. */
        excludedSpaceIds: z.array(z.string().regex(/^ksp_[a-z0-9]{14}$/)).max(50),
    })
    .strict();

export type IntelligencePreferences = z.output<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: IntelligencePreferences = {
    sections: ["today", "overdue", "deadlines", "projects", "decisions", "follow_ups", "waiting", "household", "knowledge", "changes", "suggestions"],
    mode: "concise",
    scope: "all",
    dailyTime: "07:00",
    weeklyDay: 0,
    weeklyTime: "17:00",
    notifyInApp: true,
    paused: false,
    recommendations: true,
    excludedSpaceIds: [],
};

export function parsePreferences(value: unknown): IntelligencePreferences {
    const parsed = preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, ...(value && typeof value === "object" ? value : {}) });
    return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}
