// AI usage, budgets and alerts.
//
// Every model call is one ai_usage row: who, which feature and model, how many units, the Neurons
// (Cloudflare's reported usage where a response says, otherwise our estimate from the published
// rates) and whether it worked. Never the prompt, the input or the output.
//
// Budgets are the application's own safeguard: before a call, the estimate is checked against the
// account's daily and monthly limits, the person's daily limit and the feature's daily limit, and
// the call is refused if it would go over. They are not a Cloudflare billing cap. Two calls racing
// can both pass the check, and Cloudflare's own measurement is what it bills.
import type { D1Database } from "@cloudflare/workers-types";
import { type BudgetFeature, FREE_NEURONS_PER_DAY, type IntelligenceConfig, PRICING_AS_OF, neuronsToUsd } from "../../src/shared/intelligence/config";
import type { UsageSummary, UsageTotals } from "../../src/shared/intelligence/types";
import { HttpError } from "../portal/http";

export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
export const utcMonth = (date = new Date()) => date.toISOString().slice(0, 7);

export class BudgetExceeded extends HttpError {
    constructor(readonly scope: string) {
        super(429, "budget_exceeded", `The ${scope} AI budget is used up. It resets at midnight UTC, or an owner can raise it in Intelligence settings.`);
    }
}

export interface UsageRow {
    email: string | null;
    spaceId?: string | null;
    feature: string;
    task: "generate" | "extract" | "summarise" | "classify" | "embed" | "transcribe" | "document";
    provider: string;
    model: string;
    inputUnits: number;
    outputUnits: number;
    unit: "tokens" | "audio_seconds" | "documents";
    neurons: number;
    measured: boolean;
    durationMs: number;
    ok: boolean;
    errorCode?: string | null;
    jobId?: string | null;
}

export async function recordUsage(db: D1Database, row: UsageRow) {
    const now = new Date();
    await db
        .prepare(
            `INSERT INTO ai_usage (at, day, month, email, space_id, feature, task, provider, model, input_units, output_units, unit, neurons, estimated_usd, measured,
                duration_ms, ok, error_code, job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            now.toISOString(),
            utcDay(now),
            utcMonth(now),
            row.email,
            row.spaceId ?? null,
            row.feature.slice(0, 40),
            row.task,
            row.provider,
            row.model.slice(0, 120),
            Math.max(0, Math.round(row.inputUnits)),
            Math.max(0, Math.round(row.outputUnits)),
            row.unit,
            Math.max(0, row.neurons),
            neuronsToUsd(Math.max(0, row.neurons)),
            row.measured ? 1 : 0,
            Math.max(0, Math.round(row.durationMs)),
            row.ok ? 1 : 0,
            row.errorCode?.slice(0, 40) ?? null,
            row.jobId ?? null,
        )
        .run();
}

interface Spent {
    day: number;
    month: number;
    user: number;
    feature: number;
}

async function spent(db: D1Database, email: string | null, feature: string): Promise<Spent> {
    const day = utcDay();
    const row = await db
        .prepare(
            `SELECT
                (SELECT COALESCE(SUM(neurons), 0) FROM ai_usage WHERE day = ?1) AS day,
                (SELECT COALESCE(SUM(neurons), 0) FROM ai_usage WHERE month = ?2) AS month,
                (SELECT COALESCE(SUM(neurons), 0) FROM ai_usage WHERE day = ?1 AND email = ?3) AS user,
                (SELECT COALESCE(SUM(neurons), 0) FROM ai_usage WHERE day = ?1 AND feature = ?4) AS feature`,
        )
        .bind(day, utcMonth(), email ?? "", feature)
        .first<Spent>();
    return row ?? { day: 0, month: 0, user: 0, feature: 0 };
}

/** Throws BudgetExceeded if `estimate` more Neurons would go over any limit that applies. */
export async function checkBudget(db: D1Database, config: IntelligenceConfig, request: { email: string | null; feature: BudgetFeature; estimate: number }) {
    const used = await spent(db, request.email, request.feature);
    const b = config.budgets;
    const estimate = Math.max(0, request.estimate);
    if (used.month + estimate > b.monthlyNeurons) throw new BudgetExceeded("monthly");
    if (used.day + estimate > b.dailyNeurons) throw new BudgetExceeded("daily");
    if (request.email && used.user + estimate > b.perUserDailyNeurons) throw new BudgetExceeded("personal daily");
    if (used.feature + estimate > b.features[request.feature]) throw new BudgetExceeded(`${request.feature} daily`);
}

/** Neurons left today for this person and feature: the smallest of the limits that apply. */
export async function headroom(db: D1Database, config: IntelligenceConfig, email: string | null, feature: BudgetFeature): Promise<number> {
    const used = await spent(db, email, feature);
    const b = config.budgets;
    return Math.max(
        0,
        Math.min(
            b.monthlyNeurons - used.month,
            b.dailyNeurons - used.day,
            email ? b.perUserDailyNeurons - used.user : Infinity,
            b.features[feature] - used.feature,
        ),
    );
}

// --- Circuit breaker -------------------------------------------------------------------------------

const BREAKER_WINDOW_MS = 5 * 60_000;
const BREAKER_FAILURES = 5;
const BREAKER_COOL_OFF_MS = 2 * 60_000;
const UNAVAILABLE = ["unavailable", "timeout", "capacity"];

/**
 * Open (refuse calls) when the provider's last five calls in the past five minutes all failed as
 * unavailable, until two minutes after the most recent one. Then one call is let through.
 */
export async function circuitOpen(db: D1Database, provider = "workers-ai"): Promise<boolean> {
    const rows = await db
        .prepare("SELECT at, ok, error_code FROM ai_usage WHERE provider = ? ORDER BY id DESC LIMIT ?")
        .bind(provider, BREAKER_FAILURES)
        .all<{ at: string; ok: number; error_code: string | null }>();
    if (rows.results.length < BREAKER_FAILURES) return false;
    const now = Date.now();
    const allFailed = rows.results.every((r) => !r.ok && UNAVAILABLE.includes(r.error_code ?? "") && now - Date.parse(r.at) < BREAKER_WINDOW_MS);
    return allFailed && now - Date.parse(rows.results[0].at) < BREAKER_COOL_OFF_MS;
}

// --- Reporting -------------------------------------------------------------------------------------

type TotalsRow = { neurons: number; usd: number; calls: number; failures: number };
const totals = (row: TotalsRow | null): UsageTotals => ({
    neurons: Math.round((row?.neurons ?? 0) * 100) / 100,
    estimatedUsd: Math.round((row?.usd ?? 0) * 10_000) / 10_000,
    calls: row?.calls ?? 0,
    failures: row?.failures ?? 0,
});
const TOTALS = "COALESCE(SUM(neurons), 0) AS neurons, COALESCE(SUM(estimated_usd), 0) AS usd, COUNT(*) AS calls, COALESCE(SUM(1 - ok), 0) AS failures";

export async function usageSummary(db: D1Database, config: IntelligenceConfig, email: string): Promise<UsageSummary> {
    const day = utcDay();
    const month = utcMonth();
    const since = utcDay(new Date(Date.now() - 13 * 86_400_000));
    const [today, thisMonth, mine, byFeature, byModel, daily, alerts] = await db.batch([
        db.prepare(`SELECT ${TOTALS} FROM ai_usage WHERE day = ?`).bind(day),
        db.prepare(`SELECT ${TOTALS} FROM ai_usage WHERE month = ?`).bind(month),
        db.prepare(`SELECT ${TOTALS} FROM ai_usage WHERE day = ? AND email = ?`).bind(day, email),
        db
            .prepare(
                "SELECT feature, COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS calls FROM ai_usage WHERE month = ? GROUP BY feature ORDER BY neurons DESC",
            )
            .bind(month),
        db
            .prepare(
                `SELECT model, COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS calls, COALESCE(SUM(input_units), 0) AS input_units, COALESCE(SUM(output_units), 0) AS output_units
                 FROM ai_usage WHERE month = ? GROUP BY model ORDER BY neurons DESC LIMIT 20`,
            )
            .bind(month),
        db.prepare("SELECT day, COALESCE(SUM(neurons), 0) AS neurons FROM ai_usage WHERE day >= ? GROUP BY day ORDER BY day").bind(since),
        db.prepare("SELECT period, scope, threshold FROM ai_alerts WHERE period IN (?, ?) ORDER BY raised_at DESC LIMIT 20").bind(day, month),
    ]);
    const days = new Map((daily.results as { day: string; neurons: number }[]).map((r) => [r.day, r.neurons]));
    return {
        day,
        month,
        today: totals((today.results[0] as TotalsRow) ?? null),
        thisMonth: totals((thisMonth.results[0] as TotalsRow) ?? null),
        mine: totals((mine.results[0] as TotalsRow) ?? null),
        byFeature: (byFeature.results as { feature: string; neurons: number; calls: number }[]).map((r) => ({ ...r, neurons: Math.round(r.neurons) })),
        byModel: (byModel.results as { model: string; neurons: number; calls: number; input_units: number; output_units: number }[]).map((r) => ({
            model: r.model,
            neurons: Math.round(r.neurons),
            calls: r.calls,
            inputUnits: r.input_units,
            outputUnits: r.output_units,
        })),
        last14Days: Array.from({ length: 14 }, (_, i) => {
            const d = utcDay(new Date(Date.now() - (13 - i) * 86_400_000));
            return { day: d, neurons: Math.round(days.get(d) ?? 0) };
        }),
        budgets: {
            dailyNeurons: config.budgets.dailyNeurons,
            monthlyNeurons: config.budgets.monthlyNeurons,
            perUserDailyNeurons: config.budgets.perUserDailyNeurons,
            features: config.budgets.features,
        },
        alerts: (alerts.results as { period: string; scope: string; threshold: number }[]).map((r) => ({
            period: r.period,
            scope: r.scope,
            threshold: r.threshold,
        })),
        freeNeuronsPerDay: FREE_NEURONS_PER_DAY,
        pricingAsOf: PRICING_AS_OF,
    };
}

/** Records each budget threshold crossed today or this month, once. Returns the new ones (for the log). */
export async function raiseAlerts(db: D1Database, config: IntelligenceConfig): Promise<{ scope: string; threshold: number }[]> {
    const used = await spent(db, null, "");
    const day = utcDay();
    const month = utcMonth();
    const checks: { period: string; scope: string; used: number; limit: number }[] = [
        { period: day, scope: "daily", used: used.day, limit: config.budgets.dailyNeurons },
        { period: month, scope: "monthly", used: used.month, limit: config.budgets.monthlyNeurons },
        { period: day, scope: "free allocation", used: used.day, limit: FREE_NEURONS_PER_DAY },
    ];
    const raised: { scope: string; threshold: number }[] = [];
    for (const check of checks) {
        if (check.limit <= 0) continue;
        const percent = (check.used / check.limit) * 100;
        for (const threshold of config.budgets.alertThresholds) {
            if (percent < threshold) continue;
            const result = await db
                .prepare("INSERT OR IGNORE INTO ai_alerts (period, scope, threshold, raised_at) VALUES (?, ?, ?, ?)")
                .bind(check.period, check.scope, threshold, new Date().toISOString())
                .run();
            if (result.meta.changes) raised.push({ scope: check.scope, threshold });
        }
    }
    for (const alert of raised) console.log(JSON.stringify({ event: "ai_budget_alert", scope: alert.scope, threshold: alert.threshold }));
    return raised;
}
