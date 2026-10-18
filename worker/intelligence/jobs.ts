// Background work for Daly Intelligence: a small durable queue in D1.
//
// Why not Cloudflare Queues: the workloads are one person's captures and recordings, a few a day.
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
//   * Bounded steps: a handler does one bounded piece (one model call, one audio chunk) and says
//     whether there's more. Progress is saved after every step, so an interruption resumes.
//   * Retries with backoff, then `failed` with an error code (the dead letter): visible to its owner,
//     retryable by hand, never retried forever.
//   * Each job acts as the person who created it, with their current role and memberships. Someone
//     who has since lost access gets a failed job, never someone else's data.
import type { D1Database } from "@cloudflare/workers-types";
import type { IntelligenceConfig } from "../../src/shared/intelligence/config";
import type { JobStatus, JobView } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { userForEmail } from "../portal/auth";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { AiError } from "./provider";
import { BudgetExceeded } from "./usage";

export type JobKind = "capture.analyse" | "meeting.transcribe" | "document.extract" | "briefing.prepare";

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

export type StepResult =
    | { status: "done" }
    | { status: "more"; progress?: Record<string, unknown> }
    /** Stop and wait for the person to confirm the estimated cost (approveJob sets progress.approved). */
    | { status: "approval"; progress?: Record<string, unknown>; estimateNeurons: number };

export interface JobContext {
    env: Env;
    config: IntelligenceConfig;
    user: PortalUser;
    job: JobRow;
}

export type JobHandler = (ctx: JobContext) => Promise<StepResult>;

/** Thrown by a handler for a failure that retrying can't fix. */
export class PermanentFailure extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

const CLAIM_STALE_MS = 5 * 60_000;
const BACKOFF_MS = [30_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];

export const toJobView = (row: JobRow): JobView => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    progress: parseJson(row.progress, null),
    estimateNeurons: row.estimate_neurons,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export interface EnqueueInput {
    email: string;
    kind: JobKind;
    subjectId: string;
    dedupeKey?: string | null;
    estimateNeurons?: number | null;
    /** Large work waits for the person to confirm the estimated cost first. */
    needsApproval?: boolean;
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
        .bind(
            id,
            input.email,
            input.kind,
            input.needsApproval ? "waiting_approval" : "queued",
            input.subjectId,
            input.dedupeKey ?? null,
            input.maxAttempts ?? 3,
            now,
            input.estimateNeurons ?? null,
            now,
            now,
        )
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

/** The caller's own job. Anyone else's is "not found". */
export async function ownJob(db: D1Database, email: string, id: string): Promise<JobRow> {
    const row = await db.prepare("SELECT * FROM ai_jobs WHERE id = ? AND email = ?").bind(id, email).first<JobRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return row;
}

export async function latestJobFor(db: D1Database, email: string, subjectId: string): Promise<JobRow | null> {
    return db.prepare("SELECT * FROM ai_jobs WHERE subject_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1").bind(subjectId, email).first<JobRow>();
}

export async function cancelJob(db: D1Database, email: string, id: string): Promise<JobRow> {
    await ownJob(db, email, id);
    await db
        .prepare(
            "UPDATE ai_jobs SET status = 'cancelled', claim = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND email = ? AND status IN ('queued', 'waiting_approval', 'running')",
        )
        .bind(nowIso(), nowIso(), id, email)
        .run();
    return (await getJob(db, id))!;
}

/** A failed or cancelled job, queued again with a fresh set of attempts (progress is kept). */
export async function retryJob(db: D1Database, email: string, id: string): Promise<JobRow> {
    const job = await ownJob(db, email, id);
    if (!["failed", "cancelled"].includes(job.status)) throw new HttpError(409, "conflict", "Only a failed or cancelled job can be retried");
    try {
        await db
            .prepare(
                "UPDATE ai_jobs SET status = 'queued', attempts = 0, error_code = NULL, run_after = ?, updated_at = ?, finished_at = NULL WHERE id = ? AND email = ?",
            )
            .bind(nowIso(), nowIso(), id, email)
            .run();
    } catch (error) {
        if (/UNIQUE/.test(String((error as Error)?.message))) throw new HttpError(409, "in_progress", "Another run of this is already queued");
        throw error;
    }
    return (await getJob(db, id))!;
}

/** The person agreed to the estimated cost: let it run. */
export async function approveJob(db: D1Database, email: string, id: string): Promise<JobRow> {
    await ownJob(db, email, id);
    await db
        .prepare(
            "UPDATE ai_jobs SET status = 'queued', progress = json_set(COALESCE(progress, '{}'), '$.approved', json('true')), run_after = ?, updated_at = ? WHERE id = ? AND email = ? AND status = 'waiting_approval'",
        )
        .bind(nowIso(), nowIso(), id, email)
        .run();
    return (await getJob(db, id))!;
}

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
export const isPermanent = (error: unknown) =>
    error instanceof PermanentFailure ||
    (error instanceof AiError && ["ai_off", "not_configured", "too_large", "malformed_output", "provider_error"].includes(error.aiCode)) ||
    (error instanceof HttpError && !(error instanceof BudgetExceeded) && !(error instanceof AiError) && error.status >= 400 && error.status < 500);

/** Whether this error ends the job (no retry left), so its subject can be marked failed. */
export const willFail = (job: Pick<JobRow, "attempts" | "max_attempts">, error: unknown) =>
    !(error instanceof BudgetExceeded) && (isPermanent(error) || job.attempts + 1 >= job.max_attempts);

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
            if (result.status === "approval") {
                await env.DB.prepare("UPDATE ai_jobs SET estimate_neurons = ? WHERE id = ? AND claim = ?")
                    .bind(result.estimateNeurons, job.id, job.claim)
                    .run();
                await release(env.DB, job, { status: "waiting_approval", progress: result.progress, errorCode: null });
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
            const code = error instanceof PermanentFailure ? error.code : error instanceof HttpError ? error.code : "unexpected";
            const attempts = current.attempts + 1;
            if (!(error instanceof HttpError || error instanceof PermanentFailure))
                console.error(JSON.stringify({ event: "ai_job_error", kind: job.kind, error: (error as Error)?.name }));
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

/** Runs due jobs until `deadline` (ms since epoch). Optionally only one job (a request's nudge). */
export async function processJobs(
    env: Env,
    config: IntelligenceConfig,
    handlers: Record<JobKind, JobHandler>,
    options: { deadline: number; maxJobs?: number; onlyId?: string },
): Promise<number> {
    let ran = 0;
    const max = options.maxJobs ?? 10;
    while (ran < max && Date.now() < options.deadline) {
        const due = options.onlyId
            ? await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ? AND status IN ('queued', 'running') AND run_after <= ?")
                  .bind(options.onlyId, nowIso())
                  .all<JobRow>()
            : await env.DB.prepare(
                  `SELECT * FROM ai_jobs WHERE (status = 'queued' AND run_after <= ?1) OR (status = 'running' AND claimed_at < ?2) ORDER BY run_after LIMIT 5`,
              )
                  .bind(nowIso(), new Date(Date.now() - CLAIM_STALE_MS).toISOString())
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
        if (!claimedAny || options.onlyId) break;
    }
    return ran;
}
