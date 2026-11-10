// node --test supervisor/supervisor.test.mjs  (uses a temporary state directory; never launches anything)
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.PAYLOAD_AUTONOMY_DIR = mkdtempSync(path.join(os.tmpdir(), "payload-autonomy-test-"));
const { decide, lastAssistant, resetTime, STATE_DIR } = await import("./supervisor.mjs");

const rec = (o) => JSON.stringify(o);
const limitNotice = (at, text = "You've hit your session limit · resets 12pm (Australia/Sydney)") =>
    [rec({ type: "user", message: { content: "go" } }), rec({ type: "assistant", timestamp: at, error: "rate_limit", isApiErrorMessage: true, message: { content: [{ type: "text", text }] } })].join("\n");
const normalEnd = (at) => rec({ type: "assistant", timestamp: at, message: { content: [{ type: "text", text: "All done." }] } });
const state = { deadline: "2026-11-11T02:02:00Z", maxLaunches: 4, launches: 0, sessionId: "x" };
const old = Date.parse("2026-11-10T00:00:00Z");

test("reads Claude Code's own limit notice and its reset time (Sydney, DST)", () => {
    const at = new Date("2026-11-10T22:30:00Z"); // 09:30 AEDT on 11 Nov
    assert.equal(resetTime("You've hit your session limit · resets 12pm (Australia/Sydney)", at).toISOString(), "2026-11-11T01:00:00.000Z");
    assert.equal(resetTime("resets 3:30pm (UTC)", new Date("2026-11-10T16:00:00Z")).toISOString(), "2026-11-11T15:30:00.000Z");
    assert.equal(resetTime("resets Nov 12, 9am (Australia/Sydney)", at).toISOString(), "2026-11-11T22:00:00.000Z");
    assert.equal(resetTime("resets soon", at), null);
    assert.equal(resetTime("resets 12pm (Not/AZone)", at), null);
    assert.equal(lastAssistant(limitNotice("2026-11-10T22:30:00Z")).limited, true);
    assert.equal(lastAssistant(normalEnd("2026-11-10T22:30:00Z")).limited, false);
});

test("waits until the stated reset (plus margin), then launches", () => {
    const transcript = limitNotice("2026-11-10T22:30:00Z");
    assert.equal(decide({ state, now: new Date("2026-11-11T00:59:00Z"), transcript, transcriptMtime: old }).action, "wait");
    assert.equal(decide({ state, now: new Date("2026-11-11T01:02:00Z"), transcript, transcriptMtime: old }).action, "wait");
    assert.equal(decide({ state, now: new Date("2026-11-11T01:04:00Z"), transcript, transcriptMtime: old }).action, "launch");
});

test("an unreadable reset time backs off from the notice: 30 min, then longer with each launch", () => {
    const transcript = limitNotice("2026-11-10T20:00:00Z", "Usage limit reached. Try again later.");
    assert.equal(decide({ state, now: new Date("2026-11-10T20:20:00Z"), transcript, transcriptMtime: old }).action, "wait");
    assert.equal(decide({ state, now: new Date("2026-11-10T20:31:00Z"), transcript, transcriptMtime: old }).action, "launch");
    assert.equal(decide({ state: { ...state, launches: 2 }, now: new Date("2026-11-10T21:30:00Z"), transcript, transcriptMtime: old }).action, "wait");
});

test("never launches while someone is working, after a normal ending, past the deadline or the cap", () => {
    const transcript = limitNotice("2026-11-10T20:00:00Z");
    const now = new Date("2026-11-11T01:30:00Z");
    assert.equal(decide({ state, now, transcript, transcriptMtime: now.getTime() - 60_000 }).action, "wait");
    assert.equal(decide({ state, now, transcript, transcriptMtime: old, otherSessionRunning: true }).action, "wait");
    assert.equal(decide({ state, now, transcript: normalEnd("2026-11-10T20:00:00Z"), transcriptMtime: old }).action, "idle");
    assert.equal(decide({ state, now: new Date("2026-11-11T02:03:00Z"), transcript, transcriptMtime: old }).action, "stop");
    assert.equal(decide({ state: { ...state, launches: 4 }, now, transcript, transcriptMtime: old }).action, "stop");
    assert.equal(decide({ state, now, transcript: null, transcriptMtime: 0 }).action, "wait");
});

test("a STOP file stops everything", () => {
    writeFileSync(path.join(STATE_DIR, "STOP"), "test");
    assert.equal(decide({ state, now: new Date("2026-11-11T01:30:00Z"), transcript: limitNotice("2026-11-10T20:00:00Z"), transcriptMtime: old }).action, "stop");
});
