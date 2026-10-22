// Daly Intelligence: what the Worker and the browser exchange (docs/INTELLIGENCE.md).
import type { BriefingSection, FeatureKey, IntelligenceConfig, IntelligencePreferences } from "./config";

export type JobStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";

// --- Briefings -----------------------------------------------------------------------------------

export interface BriefingItem {
    id: string;
    title: string;
    url: string;
    /** e.g. "9:00 am – 10:00 am", "Approved". */
    detail?: string;
    kind: "event" | "leave";
}

export interface BriefingFactSection {
    key: BriefingSection;
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
    /** What was read, and what never was: a briefing never implies it looked at email or a calendar it couldn't. */
    checked: { calendar: boolean };
    notChecked: string[];
    sections: BriefingFactSection[];
    recommendations: { status: "off" | "not_requested" | "ready" | "unavailable" | "budget"; items: Recommendation[]; model: string | null };
    changesSincePrevious: { previousPeriod: string | null; added: number; resolved: number } | null;
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
    bindings: { ai: boolean; gateway: boolean };
    /** The effective state per capability: on only when switched on and its binding exists. */
    available: { documents: boolean; recommendations: boolean; scheduled: boolean };
    circuitOpen: boolean;
}

export interface IntelligenceShell {
    status: IntelligenceStatus;
    canManage: boolean;
}

export type IntelligenceRoute =
    | (IntelligenceShell & { route: "intelligence-home"; briefing: BriefingView | null; usage: UsageSummary })
    | (IntelligenceShell & { route: "intelligence-briefing"; kind: "daily" | "weekly"; briefing: BriefingView })
    | (IntelligenceShell & {
          route: "intelligence-settings";
          config: IntelligenceConfig;
          configVersion: number;
          preferences: IntelligencePreferences;
          preferencesVersion: number;
          usage: UsageSummary;
      });
