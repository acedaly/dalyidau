// Where Daly Intelligence's background work runs: the existing 15-minute cron.
//
// Every piece is isolated: a failure here is logged and never affects the blog sync or wedding
// messages that share the cron, and with Intelligence switched off the only work left is retention
// (deleting old briefings, finished jobs and usage rows), which calls no model.
//
// Captures, suggestions, transcripts and their attachments (from before Knowledge and Tasks were
// retired) are never deleted here: they wait for the owner's approved cleanup
// (docs/DECOMMISSION_KNOWLEDGE_TASKS.md).
import type { Env } from "../env";
import { briefingJob, scheduleBriefings } from "./briefings";
import { type JobHandler, type JobKind, processJobs } from "./jobs";
import { loadConfig } from "./settings";
import { raiseAlerts } from "./usage";

export const jobHandlers = (env: Env): Record<JobKind, JobHandler> => ({
    "briefing.prepare": briefingJob(new URL(env.SITE_URL).origin),
});

const CRON_BUDGET_MS = 8 * 60_000;

/** Deletes what retention says has expired. Runs whether or not Intelligence is on. */
export async function retentionPass(env: Env) {
    const { config } = await loadConfig(env.DB);
    const now = Date.now();
    const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
    await env.DB.batch([
        env.DB.prepare("DELETE FROM ai_briefings WHERE generated_at < ?").bind(days(config.retention.briefingDays)),
        env.DB.prepare("DELETE FROM ai_jobs WHERE kind = 'briefing.prepare' AND status IN ('done', 'failed', 'cancelled') AND updated_at < ?").bind(days(90)),
        // Usage rows hold no content; thirteen months covers a year-on-year comparison.
        env.DB.prepare("DELETE FROM ai_usage WHERE at < ?").bind(days(400)),
    ]);
}

export async function runIntelligenceCron(env: Env) {
    const started = Date.now();
    const step = async (name: string, work: () => Promise<unknown>) => {
        try {
            await work();
        } catch (error) {
            console.error(JSON.stringify({ event: "intelligence_cron_error", step: name, message: (error as Error)?.message?.slice(0, 200) }));
        }
    };
    await step("retention", () => retentionPass(env));
    const { config } = await loadConfig(env.DB);
    if (!config.features.enabled) return;
    await step("alerts", () => raiseAlerts(env.DB, config));
    await step("briefings", () => scheduleBriefings(env, config));
    await step("jobs", () => processJobs(env, config, jobHandlers(env), { deadline: started + CRON_BUDGET_MS - 90_000, maxJobs: 20 }));
}
