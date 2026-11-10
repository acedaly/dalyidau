// Resumes the owner-authorised autonomous Payload work after a Claude usage limit resets.
// Run every few minutes by launchd (supervisor/install.sh). Does nothing unless ALL of these hold:
//   - no STOP file, the deadline hasn't passed, and fewer than `maxLaunches` sessions have been started;
//   - no other supervisor run or supervised session is running (lock + process check);
//   - the session being followed has gone quiet AND its last assistant message is Claude Code's own
//     usage-limit notice ("…limit · resets 12pm (Australia/Sydney)", recorded with error "rate_limit");
//   - the reset time in that notice has passed (plus a margin). If the time can't be read, it waits with
//     bounded backoff (30 min, doubling, at most 3 h) from the notice.
// Then it starts ONE fresh headless session that reads docs/PAYLOAD-NEXT.md, and follows that session next.
// It never retries a session that ended for any other reason, never stores credentials and never prints
// session content to its log. Stop it: `touch ~/.payload-autonomy/STOP` or `supervisor/install.sh uninstall`.
//
//   node supervisor.mjs              # one tick (what launchd runs)
//   node supervisor.mjs --dry-run    # decide and log, never launch
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = process.env.PAYLOAD_AUTONOMY_DIR ?? path.join(os.homedir(), ".payload-autonomy");
const QUIET_MS = 10 * 60_000; // a transcript written to in the last 10 minutes means someone is working
const RESET_MARGIN_MS = 3 * 60_000;

const log = (message) => {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(path.join(STATE_DIR, "supervisor.log"), `${new Date().toISOString()} ${message}\n`);
};

/** The last assistant record in a JSONL transcript, and whether it is a usage-limit notice. */
export function lastAssistant(jsonl) {
    const lines = jsonl.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 400; i--) {
        let record;
        try {
            record = JSON.parse(lines[i]);
        } catch {
            continue;
        }
        if (record.type !== "assistant") continue;
        const content = record.message?.content;
        const text = Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join(" ") : String(content ?? "");
        const limited = record.error === "rate_limit" || record.isApiErrorMessage === true && /limit/i.test(text);
        return { at: record.timestamp ? new Date(record.timestamp) : null, text, limited };
    }
    return null;
}

/** Offset (ms) of a time zone from UTC at an instant. */
function tzOffset(timeZone, instant) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
            .formatToParts(instant)
            .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The reset instant in a notice such as "resets 12pm (Australia/Sydney)", "resets 3:30pm (UTC)" or
 * "resets Nov 12, 3pm (Australia/Sydney)": the first matching wall-clock time after the notice. Null if unreadable.
 */
export function resetTime(text, noticeAt) {
    const m = /resets\s+(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
    if (!m || !noticeAt) return null;
    const [, mon, day, h, min, ampm, timeZone] = m;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
        return null;
    }
    let hour = Number(h) % 12;
    if (ampm.toLowerCase() === "pm") hour += 12;
    const minute = Number(min ?? 0);
    // Walk forward day by day (up to 8) from the notice's local date to the first matching instant after it.
    for (let d = 0; d <= 8; d++) {
        const probe = new Date(noticeAt.getTime() + d * 86_400_000);
        const local = new Date(probe.getTime() + tzOffset(timeZone, probe));
        if (mon) {
            const wantMonth = new Date(`${mon} 1, 2000`).getMonth();
            if (local.getUTCMonth() !== wantMonth || local.getUTCDate() !== Number(day)) continue;
        }
        const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - tzOffset(timeZone, probe);
        const instant = new Date(guess - (tzOffset(timeZone, new Date(guess)) - tzOffset(timeZone, probe))); // DST-correct
        if (instant > noticeAt) return instant;
    }
    return null;
}

/** When the next attempt may start, given the notice. */
export function nextAttemptAt(notice, priorWaits = 0) {
    const reset = resetTime(notice.text, notice.at);
    if (reset) return { at: new Date(reset.getTime() + RESET_MARGIN_MS), source: "notice" };
    const backoff = Math.min(30 * 60_000 * 2 ** priorWaits, 3 * 3_600_000);
    return { at: new Date((notice.at ?? new Date()).getTime() + backoff), source: "backoff" };
}

/** The decision for one tick. Pure apart from reading files, so it can be tested. */
export function decide({ state, now = new Date(), transcript, transcriptMtime, otherSessionRunning }) {
    if (existsSync(path.join(STATE_DIR, "STOP"))) return { action: "stop", why: "STOP file present" };
    if (now > new Date(state.deadline)) return { action: "stop", why: "deadline passed" };
    if (otherSessionRunning) return { action: "wait", why: "a supervised session is running" };
    if (transcript === null) return { action: "wait", why: "transcript not found" };
    if (now - transcriptMtime < QUIET_MS) return { action: "wait", why: "session active (transcript recently written)" };
    const last = lastAssistant(transcript);
    if (!last || !last.limited) return { action: "idle", why: "session ended without a usage-limit notice; nothing to resume" };
    const next = nextAttemptAt(last, state.launches ?? 0); // unreadable reset: 30 min, 1 h, 2 h, then 3 h
    if (now < next.at) return { action: "wait", why: `limit notice; next attempt after ${next.at.toISOString()} (${next.source})`, source: next.source };
    if ((state.launches ?? 0) >= state.maxLaunches) return { action: "stop", why: `launch cap (${state.maxLaunches}) reached` };
    return { action: "launch", why: `limit reset passed (${next.source})` };
}

function main() {
    const dryRun = process.argv.includes("--dry-run");
    const statePath = path.join(STATE_DIR, "state.json");
    if (!existsSync(statePath)) return log("no state.json; not configured");
    const state = JSON.parse(readFileSync(statePath, "utf8"));

    // One supervisor at a time.
    const lock = path.join(STATE_DIR, "lock");
    try {
        mkdirSync(lock);
    } catch {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age < 6 * 3_600_000) return log("another supervisor run holds the lock");
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
    }
    try {
        const transcriptPath = path.join(state.projectDir, `${state.sessionId}.jsonl`);
        const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : null;
        const transcriptMtime = transcript === null ? 0 : statSync(transcriptPath).mtimeMs;
        const ps = spawnSync("pgrep", ["-f", "--", "--name payload-autonomy"], { encoding: "utf8" });
        const otherSessionRunning = ps.stdout.trim().length > 0;
        const decision = decide({ state, transcript, transcriptMtime, otherSessionRunning });
        log(`${decision.action}: ${decision.why} [following ${state.sessionId}]`);

        if (decision.action === "stop") writeFileSync(path.join(STATE_DIR, "STOP"), `${new Date().toISOString()} ${decision.why}\n`);
        if (decision.action !== "launch" || dryRun) {
            if (dryRun && decision.action === "launch") log("dry run: would launch");
            return;
        }

        const sessionId = randomUUID();
        state.launches = (state.launches ?? 0) + 1;
        state.history = [...(state.history ?? []), { sessionId, startedAt: new Date().toISOString(), after: state.sessionId }];
        state.sessionId = sessionId;
        writeFileSync(statePath, JSON.stringify(state, null, 2)); // saved before launching: a crash never relaunches blindly
        const prompt = readFileSync(path.join(import.meta.dirname, "resume-prompt.md"), "utf8");
        const until = new Date(state.deadline).getTime() + 10 * 60_000 - Date.now();
        log(`launching session ${sessionId} (launch ${state.launches}/${state.maxLaunches})`);
        const result = spawnSync(
            state.claudePath,
            [
                "-p", prompt,
                "--session-id", sessionId,
                "--name", "payload-autonomy",
                "--permission-mode", "auto",
                "--settings", path.join(import.meta.dirname, "headless-settings.json"),
                "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--disallowedTools", "Artifact,ArtifactData,ArtifactComments,Workflow,SendToProject,RemoteTrigger,PushNotification",
                "--output-format", "json",
            ],
            { cwd: state.repo, encoding: "utf8", timeout: Math.max(until, 60_000), maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: state.path } },
        );
        // Outcome only: never the session's text.
        let summary = `exit ${result.status}${result.signal ? ` signal ${result.signal}` : ""}`;
        try {
            const out = JSON.parse(result.stdout);
            summary += ` subtype=${out.subtype} is_error=${out.is_error} turns=${out.num_turns}`;
        } catch {
            /* not JSON (e.g. killed) */
        }
        log(`session ${sessionId} ended: ${summary}`);
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
