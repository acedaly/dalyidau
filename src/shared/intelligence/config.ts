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

export type ModelTask = "text" | "document";

export interface ModelInfo {
    id: string;
    task: ModelTask;
    label: string;
    /** Size class, for choosing: small models for tags and classification, capable ones for synthesis. */
    tier: "small" | "standard" | "capable";
    /** Neurons per million input and output tokens. */
    inputNeuronsPerM?: number;
    outputNeuronsPerM?: number;
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
        notes: "For detailed briefings and synthesis. Output is expensive: keep it bounded.",
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

export const FEATURE_KEYS = ["enabled", "documents", "briefingRecommendations", "scheduled"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_LABELS: Record<FeatureKey, { label: string; description: string }> = {
    enabled: {
        label: "Intelligence",
        description: "The master switch. While off, no model is called for anyone and scheduled processing stops. Every application works exactly as before.",
    },
    documents: {
        label: "Document intelligence",
        description: "Read uploaded receipts, photos and policy documents for Home & Assets suggestions (with its own switch on too).",
    },
    briefingRecommendations: {
        label: "AI briefing recommendations",
        description: "Add model-written suggestions to daily and weekly briefings and Intelligence Centre interpretations. Facts are always shown without it.",
    },
    scheduled: {
        label: "Scheduled intelligence",
        description:
            "Prepare briefings (with recommendations, when those are on) at each person's preferred time, for people who saved briefing preferences and haven't paused them.",
    },
};

const neurons = z.number().int().min(0).max(10_000_000);

export const BUDGET_FEATURES = ["documents", "briefings"] as const;
export type BudgetFeature = (typeof BUDGET_FEATURES)[number];

export const intelligenceConfigSchema = z
    .object({
        features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<FeatureKey, z.ZodBoolean>).strict(),
        models: z
            .object({
                /** Values and dates from documents (Home & Assets). */
                extract: modelChoice("text"),
                /** Short summaries and briefing recommendations. */
                summarise: modelChoice("text"),
                /** Detailed briefings. */
                synthesis: modelChoice("text"),
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
                /** Percentages of a budget that raise an alert on the usage page. */
                alertThresholds: z.array(z.number().int().min(1).max(100)).max(5),
            })
            .strict(),
        limits: z
            .object({
                /** Seconds a single model call may take before it's abandoned. */
                callTimeoutSeconds: z.number().int().min(5).max(120),
            })
            .strict(),
        retention: z
            .object({
                /** Stored briefings. */
                briefingDays: z.number().int().min(7).max(365),
            })
            .strict(),
    })
    .strict()
    .superRefine((config, ctx) => {
        if (config.budgets.perUserDailyNeurons > config.budgets.dailyNeurons)
            ctx.addIssue({ code: "custom", path: ["budgets", "perUserDailyNeurons"], message: "A person's limit can't be higher than the account's" });
        if (config.budgets.dailyNeurons > config.budgets.monthlyNeurons)
            ctx.addIssue({ code: "custom", path: ["budgets", "dailyNeurons"], message: "The daily limit can't be higher than the monthly one" });
    });

export type IntelligenceConfig = z.output<typeof intelligenceConfigSchema>;

/** Conservative defaults: everything off, cheap models, budgets inside the free daily allocation. */
export const DEFAULT_CONFIG: IntelligenceConfig = {
    features: { enabled: false, documents: false, briefingRecommendations: false, scheduled: false },
    models: {
        extract: "@cf/google/gemma-4-26b-a4b-it",
        summarise: "@cf/google/gemma-4-26b-a4b-it",
        synthesis: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    },
    budgets: {
        dailyNeurons: 9_000,
        monthlyNeurons: 270_000,
        perUserDailyNeurons: 5_000,
        features: { documents: 1_500, briefings: 1_500 },
        alertThresholds: [50, 80, 100],
    },
    limits: { callTimeoutSeconds: 60 },
    retention: { briefingDays: 90 },
};

/** Only the keys `shape` has. Documents saved before Knowledge and Tasks were retired hold settings for capture, meetings and semantic search; they're read past, never saved again. */
const known = <T extends object>(shape: T, value: unknown): Partial<T> =>
    value && typeof value === "object" ? (Object.fromEntries(Object.entries(value).filter(([k]) => k in shape)) as Partial<T>) : {};

/** A stored document merged over the defaults, so a newer Worker always has every field. Invalid documents fall back to the defaults (fail closed: off). */
export function parseConfig(value: unknown): IntelligenceConfig {
    const stored = known(DEFAULT_CONFIG, value) as Partial<Record<keyof IntelligenceConfig, unknown>>;
    const budgets = known(DEFAULT_CONFIG.budgets, stored.budgets);
    const merged = {
        ...DEFAULT_CONFIG,
        ...stored,
        features: { ...DEFAULT_CONFIG.features, ...known(DEFAULT_CONFIG.features, stored.features) },
        models: { ...DEFAULT_CONFIG.models, ...known(DEFAULT_CONFIG.models, stored.models) },
        budgets: {
            ...DEFAULT_CONFIG.budgets,
            ...budgets,
            features: { ...DEFAULT_CONFIG.budgets.features, ...known(DEFAULT_CONFIG.budgets.features, budgets.features) },
        },
        limits: { ...DEFAULT_CONFIG.limits, ...known(DEFAULT_CONFIG.limits, stored.limits) },
        retention: { ...DEFAULT_CONFIG.retention, ...known(DEFAULT_CONFIG.retention, stored.retention) },
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

export const neuronsToUsd = (neurons: number) => neurons * USD_PER_NEURON;

// --- Personal preferences ------------------------------------------------------------------------

export const BRIEFING_SECTIONS = ["calendar", "changes", "suggestions"] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

export const BRIEFING_SECTION_LABELS: Record<BriefingSection, string> = {
    calendar: "Calendar and leave",
    changes: "Changes since last briefing",
    suggestions: "Suggested next actions",
};

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:30");

export const preferencesSchema = z
    .object({
        sections: z.array(z.enum(BRIEFING_SECTIONS)).max(BRIEFING_SECTIONS.length),
        mode: z.enum(["concise", "detailed"]),
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
    })
    .strict();

export type IntelligencePreferences = z.output<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: IntelligencePreferences = {
    sections: ["calendar", "changes", "suggestions"],
    mode: "concise",
    dailyTime: "07:00",
    weeklyDay: 0,
    weeklyTime: "17:00",
    notifyInApp: true,
    paused: false,
    recommendations: true,
};

/** Stored preferences over the defaults. Sections, scope and excluded spaces for Tasks and Knowledge (retired) are read past. */
export function parsePreferences(value: unknown): IntelligencePreferences {
    const stored = known(DEFAULT_PREFERENCES, value);
    const sections = Array.isArray(stored.sections) ? stored.sections.filter((s) => (BRIEFING_SECTIONS as readonly unknown[]).includes(s)) : undefined;
    const parsed = preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, ...stored, ...(sections ? { sections } : {}) });
    return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}
