// Background work for Daly Intelligence: a small durable queue in D1.
//
// Why not Cloudflare Queues: the workload is each person's scheduled briefings, a few a day.
// A table, the existing 15-minute cron and a nudge after each request (ctx.waitUntil) give
// durability, retries and ordering with no new binding or service, and the same code runs in tests.
// Queues can replace the trigger later without changing a job's handler (docs/INTELLIGENCE.md).
//
// Guarantees:
//   * One live job per subject: a dedupe key and a partial unique index (enqueueing twice returns
//     the first job).
//   * One runner per job: claiming sets a random token under a status/claim check, so two cron
//     invocations can't both run it. A claim older than CLAIM_STALE_MS belongs to a runner that died
//     and is taken over.
//   * Bounded steps: a handler does one bounded piece (one model call) and says whether there's more. Progress is saved after every step, so an interruption resumes.
//   * Retries with backoff, then `failed` with an error code (the dead letter), never retried forever.
//   * Each job acts as the person who created it, with their current role and memberships. Someone
//     who has since lost access gets a failed job, never someone else's data.
//   * Only kinds with a handler run. Capture, meeting and document jobs queued before Knowledge and
//     Tasks were retired stay as they are, untouched, until the approved cleanup.
import type { D1Database } from "@cloudflare/workers-types";
import type { IntelligenceConfig } from "../../src/shared/intelligence/config";
import type { JobStatus } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { userForEmail } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { AiError } from "./provider";
import { BudgetExceeded } from "./usage";

export type JobKind = "briefing.prepare";

export interface JobRow {
    id: string;
    email: string;
    kind: JobKind;
    status: JobStatus;
    subject_id: string;
    dedupe_key: string | null;
    attempts: number;
    max_attempts: number;
    run_after: string;
    claim: string | null;
    claimed_at: string | null;
    progress: string | null;
    estimate_neurons: number | null;
    error_code: string | null;
    created_at: string;
    updated_at: string;
}

export type StepResult = { status: "done" } | { status: "more"; progress?: Record<string, unknown> };

export interface JobContext {
    env: Env;
    config: IntelligenceConfig;
    user: PortalUser;
    job: JobRow;
}

export type JobHandler = (ctx: JobContext) => Promise<StepResult>;

const CLAIM_STALE_MS = 5 * 60_000;
const BACKOFF_MS = [30_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];

export interface EnqueueInput {
    email: string;
    kind: JobKind;
    subjectId: string;
    dedupeKey?: string | null;
    maxAttempts?: number;
}

export async function enqueue(db: D1Database, input: EnqueueInput): Promise<{ job: JobRow; existing: boolean }> {
    const id = newId("ajb");
    const now = nowIso();
    const result = await db
        .prepare(
            `INSERT INTO ai_jobs (id, email, kind, status, subject_id, dedupe_key, max_attempts, run_after, estimate_neurons, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(id, input.email, input.kind, "queued", input.subjectId, input.dedupeKey ?? null, input.maxAttempts ?? 3, now, null, now, now)
        .run();
    if (result.meta.changes) return { job: (await getJob(db, id))!, existing: false };
    const live = await db
        .prepare("SELECT * FROM ai_jobs WHERE dedupe_key = ? AND status IN ('queued', 'running', 'waiting_approval')")
        .bind(input.dedupeKey ?? "")
        .first<JobRow>();
    if (!live) throw new HttpError(409, "in_progress", "That is already being processed. Try again in a moment.");
    return { job: live, existing: true };
}

export const getJob = (db: D1Database, id: string) => db.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(id).first<JobRow>();

async function claim(db: D1Database, job: JobRow): Promise<JobRow | null> {
    const token = crypto.randomUUID();
    const now = nowIso();
    const result = await db
        .prepare(
            `UPDATE ai_jobs SET status = 'running', claim = ?, claimed_at = ?, updated_at = ?
             WHERE id = ? AND (status = 'queued' OR (status = 'running' AND claimed_at < ?))`,
        )
        .bind(token, now, now, job.id, new Date(Date.now() - CLAIM_STALE_MS).toISOString())
        .run();
    return result.meta.changes ? { ...job, status: "running", claim: token, claimed_at: now } : null;
}

const release = (
    db: D1Database,
    job: JobRow,
    fields: { status: JobStatus; runAfter?: string; errorCode?: string | null; attempts?: number; progress?: unknown },
) =>
    db
        .prepare(
            `UPDATE ai_jobs SET status = ?, claim = NULL, run_after = COALESCE(?, run_after), error_code = ?, attempts = COALESCE(?, attempts),
                progress = COALESCE(?, progress), updated_at = ?, finished_at = CASE WHEN ? IN ('done', 'failed') THEN ? ELSE finished_at END
             WHERE id = ? AND claim = ?`,
        )
        .bind(
            fields.status,
            fields.runAfter ?? null,
            fields.errorCode ?? null,
            fields.attempts ?? null,
            fields.progress === undefined ? null : JSON.stringify(fields.progress),
            nowIso(),
            fields.status,
            nowIso(),
            job.id,
            job.claim,
        )
        .run();

/** Failures retrying can't fix: refusals, validation, configuration and the model's own output. */
const isPermanent = (error: unknown) =>
    (error instanceof AiError && ["ai_off", "not_configured", "too_large", "malformed_output", "provider_error"].includes(error.aiCode)) ||
    (error instanceof HttpError && !(error instanceof BudgetExceeded) && !(error instanceof AiError) && error.status >= 400 && error.status < 500);

const nextUtcMidnight = () => {
    const d = new Date();
    d.setUTCHours(24, 5, 0, 0);
    return d.toISOString();
};

/** Runs one claimed job until it finishes, fails or the deadline passes. */
async function runClaimed(env: Env, config: IntelligenceConfig, handlers: Record<JobKind, JobHandler>, job: JobRow, deadline: number) {
    const auth = await userForEmail(env, job.email);
    if (!auth.ok) {
        await release(env.DB, job, { status: "failed", errorCode: "forbidden" });
        return;
    }
    for (;;) {
        // Re-read: the person may have cancelled it between steps.
        const current = await getJob(env.DB, job.id);
        if (!current || current.claim !== job.claim || current.status !== "running") return;
        try {
            const result = await handlers[job.kind]({ env, config, user: auth.user, job: current });
            if (result.status === "done") {
                await release(env.DB, job, { status: "done", errorCode: null });
                return;
            }
            if (result.progress)
                await env.DB.prepare("UPDATE ai_jobs SET progress = ?, updated_at = ? WHERE id = ? AND claim = ?")
                    .bind(JSON.stringify(result.progress), nowIso(), job.id, job.claim)
                    .run();
            if (Date.now() > deadline) {
                await release(env.DB, job, { status: "queued", runAfter: nowIso() });
                return;
            }
        } catch (error) {
            // Over budget: wait for tomorrow's allowance without spending an attempt.
            if (error instanceof BudgetExceeded)
                return void (await release(env.DB, job, { status: "queued", runAfter: nextUtcMidnight(), errorCode: "budget_exceeded" }));
            const permanent = isPermanent(error);
            const code = error instanceof HttpError ? error.code : "unexpected";
            const attempts = current.attempts + 1;
            if (!(error instanceof HttpError)) console.error(JSON.stringify({ event: "ai_job_error", kind: job.kind, error: (error as Error)?.name }));
            if (permanent || attempts >= current.max_attempts) await release(env.DB, job, { status: "failed", errorCode: code.slice(0, 40), attempts });
            else
                await release(env.DB, job, {
                    status: "queued",
                    errorCode: code.slice(0, 40),
                    attempts,
                    runAfter: new Date(Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]).toISOString(),
                });
            return;
        }
    }
}

/** Runs due jobs of the kinds `handlers` knows until `deadline` (ms since epoch). */
export async function processJobs(
    env: Env,
    config: IntelligenceConfig,
    handlers: Record<JobKind, JobHandler>,
    options: { deadline: number; maxJobs?: number },
): Promise<number> {
    let ran = 0;
    const max = options.maxJobs ?? 10;
    const kinds = JSON.stringify(Object.keys(handlers));
    while (ran < max && Date.now() < options.deadline) {
        const due = await env.DB.prepare(
            `SELECT * FROM ai_jobs WHERE kind IN (SELECT value FROM json_each(?3)) AND ((status = 'queued' AND run_after <= ?1) OR (status = 'running' AND claimed_at < ?2))
             ORDER BY run_after LIMIT 5`,
        )
            .bind(nowIso(), new Date(Date.now() - CLAIM_STALE_MS).toISOString(), kinds)
            .all<JobRow>();
        if (!due.results.length) break;
        let claimedAny = false;
        for (const row of due.results) {
            if (ran >= max || Date.now() >= options.deadline) break;
            const claimed = await claim(env.DB, row);
            if (!claimed) continue;
            claimedAny = true;
            ran++;
            await runClaimed(env, config, handlers, claimed, options.deadline);
        }
        if (!claimedAny) break;
    }
    return ran;
}
