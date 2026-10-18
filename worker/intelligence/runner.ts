// Where Daly Intelligence's background work runs: the existing 15-minute cron, and a short nudge
// after a request that queued something (so a capture doesn't wait for the next cron).
//
// Every piece is isolated: a failure here is logged and never affects the blog sync, wedding
// messages or task reminders that share the cron, and with Intelligence switched off the only work
// left is retention (deleting expired temporary files and old briefings), which calls no model.
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { purgeExpired } from "./attachments";
import { briefingJob, scheduleBriefings } from "./briefings";
import { captureJob } from "./capture";
import { documentJob } from "./documents";
import { type JobHandler, type JobKind, processJobs } from "./jobs";
import { meetingJob } from "./meetings";
import { syncSemanticIndex } from "./semantic";
import { availability, loadConfig } from "./settings";
import { raiseAlerts } from "./usage";

export const jobHandlers = (env: Env): Record<JobKind, JobHandler> => ({
    "capture.analyse": captureJob,
    "meeting.transcribe": meetingJob,
    "document.extract": documentJob,
    "briefing.prepare": briefingJob(new URL(env.SITE_URL).origin),
});

const CRON_BUDGET_MS = 8 * 60_000;
const NUDGE_BUDGET_MS = 25_000;

/** Deletes what retention says has expired. Runs whether or not Intelligence is on. */
export async function retentionPass(env: Env) {
    const { config } = await loadConfig(env.DB);
    const files = await purgeExpired(env.DB, env.MEDIA, config);
    const now = Date.now();
    const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
    await env.DB.batch([
        env.DB.prepare("DELETE FROM ai_briefings WHERE generated_at < ?").bind(days(config.retention.briefingDays)),
        // A capture goes once nothing in it is waiting for review (its suggestions and transcript go with it).
        env.DB.prepare(
            "DELETE FROM ai_captures WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM ai_suggestions s WHERE s.capture_id = ai_captures.id AND s.status IN ('pending', 'applying'))",
        ).bind(days(config.retention.captureDays)),
        env.DB.prepare("DELETE FROM ai_jobs WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?").bind(days(90)),
        // Usage rows hold no content; thirteen months covers a year-on-year comparison.
        env.DB.prepare("DELETE FROM ai_usage WHERE at < ?").bind(days(400)),
    ]);
    if (files.purged || files.abandoned || files.orphaned) console.log(JSON.stringify({ event: "ai_retention", ...files }));
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
    if (availability(env, config).semantic) await step("semantic", () => syncSemanticIndex(env, config));
}

/** After a request queues a job: run it now, in the background, for up to ~25 seconds. */
export function nudge(env: Env, ctx: Pick<ExecutionContext, "waitUntil"> | undefined, jobId: string) {
    if (!ctx || !jobId) return;
    ctx.waitUntil(
        (async () => {
            try {
                const { config } = await loadConfig(env.DB);
                await processJobs(env, config, jobHandlers(env), { deadline: Date.now() + NUDGE_BUDGET_MS, onlyId: jobId });
            } catch (error) {
                console.error(JSON.stringify({ event: "intelligence_nudge_error", message: (error as Error)?.message?.slice(0, 200) }));
            }
        })(),
    );
}

/** Runs one of the caller's jobs inline, for at most a few seconds (the page's "process now"). */
export async function runOwnJobNow(env: Env, jobId: string, seconds = 20) {
    const { config } = await loadConfig(env.DB);
    return processJobs(env, config, jobHandlers(env), { deadline: Date.now() + seconds * 1000, onlyId: jobId });
}
